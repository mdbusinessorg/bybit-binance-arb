import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { evaluateFundingArb, normalizeFundingTo8h, pct, usd } from '../math.js';
import { openFundingPosition, closeFundingPosition } from '../executor.js';
import { state, save, recordTrade } from '../state.js';
import { tradingBlockedReason, canOpenNotional } from '../risk.js';
import { notify } from '../notify.js';
import { commonSwapSymbols, EXCHANGE_IDS } from '../exchanges.js';

const log = createLogger('funding');

export function fundingIntervalHours(fr, market) {
  const s = fr?.interval;
  if (typeof s === 'string') {
    const m = s.match(/^(\d+)\s*h$/i);
    if (m) return Number(m[1]);
  }
  const info = market?.info || {};
  if (info.fundingInterval) {
    const minutes = Number(info.fundingInterval);
    if (Number.isFinite(minutes) && minutes > 0) return minutes / 60;
  }
  if (info.fundingIntervalHours) return Number(info.fundingIntervalHours);
  return 8;
}

export class FundingArbStrategy {
  constructor(exs) {
    this.exs = exs;
    this.symbols = commonSwapSymbols(exs, config.funding.symbols);
    this.exitCounters = {};
    this.lastAccrualAt = {};
    log.info(`perps comuns Bybit/Binance: ${this.symbols.length}${config.funding.symbols.length ? ` (lista configurada)` : ''}`);
    log.info(
      `limiar: spread funding 8h >= ${pct(config.funding.minSpread8hPct, 4)}, APR líquido >= ${pct(config.funding.minNetAprPct, 1)}, ` +
        `tamanho ${usd(config.funding.positionUsd)} por lado, alavancagem ${config.funding.leverage}x, máx ${config.funding.maxOpenPositions} posições`,
    );
  }

  async fetchRates() {
    const res = await Promise.all(
      EXCHANGE_IDS.map(async (id) => {
        const ex = this.exs[id];
        const raw = await ex.fetchFundingRates(this.symbols);
        const out = {};
        for (const s of this.symbols) {
          const fr = raw[s];
          if (!fr || typeof fr.fundingRate !== 'number') continue;
          const hours = fundingIntervalHours(fr, ex.markets[s]);
          out[s] = {
            rate: fr.fundingRate,
            hours,
            rate8h: normalizeFundingTo8h(fr.fundingRate, hours),
            price: fr.markPrice || fr.indexPrice || null,
            nextFunding: fr.fundingTimestamp || null,
          };
        }
        return out;
      }),
    );
    return { bybit: res[0], binance: res[1] };
  }

  async fetchVolumes() {
    try {
      const res = await Promise.all(EXCHANGE_IDS.map((id) => this.exs[id].fetchTickers(this.symbols)));
      const vol = {};
      for (const s of this.symbols) {
        const vals = res.map((r) => Number(r[s]?.quoteVolume || 0));
        vol[s] = Math.min(...vals);
      }
      return vol;
    } catch (e) {
      log.debug(`fetchTickers falhou (${e.message}); filtro de volume desativado neste ciclo`);
      return null;
    }
  }

  async fillPrices(symbol) {
    const res = await Promise.all(EXCHANGE_IDS.map((id) => this.exs[id].fetchOrderBook(symbol, 5)));
    return {
      bybit: { bid: res[0].bids[0]?.[0], ask: res[0].asks[0]?.[0] },
      binance: { bid: res[1].bids[0]?.[0], ask: res[1].asks[0]?.[0] },
    };
  }

  evaluate(symbol, rates) {
    const a = rates.bybit[symbol];
    const b = rates.binance[symbol];
    if (!a || !b || !a.price || !b.price) return null;
    const ev = evaluateFundingArb({
      rateA8h: a.rate8h,
      rateB8h: b.rate8h,
      priceA: a.price,
      priceB: b.price,
      feeA: config.funding.useMakerEntry ? this.exs.bybit.fees_.swapMaker : this.exs.bybit.fees_.swapTaker,
      feeB: config.funding.useMakerEntry ? this.exs.binance.fees_.swapMaker : this.exs.binance.fees_.swapTaker,
      expectedHoldHours: config.funding.expectedHoldHours,
    });
    return {
      symbol,
      ...ev,
      shortId: ev.shortOn === 'A' ? 'bybit' : 'binance',
      longId: ev.longOn === 'A' ? 'bybit' : 'binance',
      rates: { bybit: a, binance: b },
    };
  }

  rank(rates, volumes) {
    const list = [];
    for (const s of this.symbols) {
      const ev = this.evaluate(s, rates);
      if (!ev) continue;
      ev.volume = volumes ? volumes[s] : null;
      list.push(ev);
    }
    list.sort((x, y) => y.netAprPct - x.netAprPct);
    return list;
  }

  async tick() {
    const rates = await this.fetchRates();
    await this.managePositions(rates);
    const volumes = await this.fetchVolumes();
    const ranked = this.rank(rates, volumes);

    const top = ranked.slice(0, 5).map((e) => `${e.symbol.split(':')[0]} ${pct(e.spread8h, 4)}/8h short ${e.shortId} APR líq ${pct(e.netAprPct, 1)}`);
    log.info(`top spreads: ${top.join(' | ')}`);

    const open = Object.keys(state.fundingPositions).length;
    if (open >= config.funding.maxOpenPositions) return;

    for (const ev of ranked) {
      if (state.fundingPositions[ev.symbol]) continue;
      if (ev.spread8h < config.funding.minSpread8hPct) break;
      if (ev.netAprPct < config.funding.minNetAprPct) break;
      if (Math.abs(ev.basisPct) > config.funding.maxBasisPct) continue;
      if (ev.volume !== null && ev.volume < config.funding.minVolume24hUsd) continue;
      if (!canOpenNotional(config.funding.positionUsd * 2)) {
        log.info(`notional máximo atingido; não abrir ${ev.symbol}`);
        break;
      }
      const blocked = tradingBlockedReason();
      if (blocked) {
        log.warn(`oportunidade funding ignorada (${blocked}): ${ev.symbol}`);
        return;
      }
      await this.open(ev);
      if (Object.keys(state.fundingPositions).length >= config.funding.maxOpenPositions) break;
    }
  }

  async open(ev) {
    const longEx = this.exs[ev.longId];
    const shortEx = this.exs[ev.shortId];
    const px = await this.fillPrices(ev.symbol);
    const longPrice = px[ev.longId].ask;
    const shortPrice = px[ev.shortId].bid;
    if (!longPrice || !shortPrice) return;
    const realBasis = (longPrice - shortPrice) / shortPrice;
    if (realBasis > config.funding.maxBasisPct) {
      log.info(`${ev.symbol}: basis real ${pct(realBasis, 3)} acima do máximo; ignorar`);
      return;
    }
    const market = longEx.market(ev.symbol);
    const contractSize = market.contractSize || 1;
    let contracts = config.funding.positionUsd / (longPrice * contractSize);
    contracts = Number(longEx.amountToPrecision(ev.symbol, contracts));
    contracts = Number(shortEx.amountToPrecision(ev.symbol, contracts));
    const minAmt = Math.max(longEx.market(ev.symbol).limits?.amount?.min || 0, shortEx.market(ev.symbol).limits?.amount?.min || 0);
    if (contracts <= 0 || contracts < minAmt) {
      log.info(`${ev.symbol}: quantidade ${contracts} abaixo do mínimo ${minAmt}`);
      return;
    }
    const line = `${ev.symbol} long ${longEx.label} @${longPrice} / short ${shortEx.label} @${shortPrice} | spread ${pct(ev.spread8h, 4)}/8h | APR líq ${pct(ev.netAprPct, 1)} | break-even ${ev.breakEvenHours.toFixed(1)}h`;
    log.info(`ABRIR FUNDING: ${line}`);
    const res = await openFundingPosition({ longEx, shortEx, symbol: ev.symbol, contracts, prices: { long: longPrice, short: shortPrice } });
    if (!res.ok) {
      log.error(`${ev.symbol}: abertura falhou — ${res.error}`);
      notify(`⚠️ FUNDING ${ev.symbol}: abertura falhou — ${res.error}`);
      return;
    }
    const notionalUsd = res.contracts * contractSize * ((res.longPrice + res.shortPrice) / 2) * 2;
    state.fundingPositions[ev.symbol] = {
      symbol: ev.symbol,
      longId: ev.longId,
      shortId: ev.shortId,
      contracts: res.contracts,
      contractSize,
      entryLong: res.longPrice,
      entryShort: res.shortPrice,
      entryFees: res.fees,
      entrySpread8h: ev.spread8h,
      openedAt: Date.now(),
      notionalUsd,
      fundingAccruedUsd: 0,
    };
    state.fundingTrades++;
    this.lastAccrualAt[ev.symbol] = Date.now();
    this.exitCounters[ev.symbol] = 0;
    save();
    const tag = config.live ? '💰' : '🧪';
    notify(`${tag} FUNDING ABERTO ${line}\nTaxas entrada ${usd(res.fees, 3)}`);
  }

  async managePositions(rates) {
    for (const pos of Object.values(state.fundingPositions)) {
      const a = rates[pos.longId]?.[pos.symbol];
      const b = rates[pos.shortId]?.[pos.symbol];
      const now = Date.now();
      if (a && b) {
        // acumular funding estimado: recebemos do lado short, pagamos do lado long
        const signedSpread8h = b.rate8h - a.rate8h;
        const last = this.lastAccrualAt[pos.symbol] || pos.openedAt;
        const hours = (now - last) / 3600_000;
        pos.fundingAccruedUsd += signedSpread8h * (pos.notionalUsd / 2) * (hours / 8);
        this.lastAccrualAt[pos.symbol] = now;
        if (signedSpread8h < config.funding.exitSpread8hPct) {
          this.exitCounters[pos.symbol] = (this.exitCounters[pos.symbol] || 0) + 1;
        } else {
          this.exitCounters[pos.symbol] = 0;
        }
      }
      const heldHours = (now - pos.openedAt) / 3600_000;
      const spreadGone = (this.exitCounters[pos.symbol] || 0) >= config.funding.exitConfirmations;
      const tooLong = heldHours >= config.funding.maxHoldHours;
      if (spreadGone || tooLong) {
        await this.close(pos, spreadGone ? 'spread desapareceu' : 'tempo máximo');
      } else if (config.live) {
        await this.checkMargin(pos);
      }
    }
    save();
  }

  async checkMargin(pos) {
    try {
      const res = await Promise.all([pos.longId, pos.shortId].map((id) => this.exs[id].fetchPositions([pos.symbol])));
      for (const list of res) {
        for (const p of list) {
          if (!p || !p.contracts) continue;
          const liq = p.liquidationPrice;
          const mark = p.markPrice;
          if (liq && mark) {
            const dist = Math.abs(mark - liq) / mark;
            if (dist < 0.15) {
              const msg = `⚠️ ${pos.symbol}: preço de liquidação a ${pct(dist, 1)} do mark em ${p.info?.exchange || ''} — considerar reforçar margem ou fechar`;
              log.warn(msg);
              notify(msg);
            }
          }
        }
      }
    } catch (e) {
      log.debug(`checkMargin: ${e.message}`);
    }
  }

  async close(pos, reason) {
    const longEx = this.exs[pos.longId];
    const shortEx = this.exs[pos.shortId];
    const px = await this.fillPrices(pos.symbol);
    const prices = { long: px[pos.longId].bid, short: px[pos.shortId].ask };
    log.info(`FECHAR FUNDING ${pos.symbol} (${reason})`);
    const res = await closeFundingPosition({ longEx, shortEx, symbol: pos.symbol, contracts: pos.contracts, prices });
    const cs = pos.contractSize || 1;
    const legPnl = (res.longPrice - pos.entryLong) * pos.contracts * cs + (pos.entryShort - res.shortPrice) * pos.contracts * cs;
    const pnl = pos.fundingAccruedUsd + legPnl - pos.entryFees - res.fees;
    const heldHours = (Date.now() - pos.openedAt) / 3600_000;
    recordTrade({
      strategy: 'funding',
      symbol: pos.symbol,
      long: pos.longId,
      short: pos.shortId,
      reason,
      heldHours,
      fundingUsd: pos.fundingAccruedUsd,
      legPnlUsd: legPnl,
      feesUsd: pos.entryFees + res.fees,
      pnlUsd: pnl,
      ok: res.ok,
    });
    delete state.fundingPositions[pos.symbol];
    delete this.exitCounters[pos.symbol];
    delete this.lastAccrualAt[pos.symbol];
    save();
    const tag = config.live ? '💰' : '🧪';
    const msg = `${tag} FUNDING FECHADO ${pos.symbol} (${reason}) após ${heldHours.toFixed(1)}h | funding ${usd(pos.fundingAccruedUsd, 3)} + pernas ${usd(legPnl, 3)} - taxas ${usd(pos.entryFees + res.fees, 3)} = P&L ${usd(pnl, 3)}${res.ok ? '' : ' ⚠️ FECHO INCOMPLETO'}`;
    log.info(msg);
    if (config.live || !res.ok) notify(msg);
  }
}
