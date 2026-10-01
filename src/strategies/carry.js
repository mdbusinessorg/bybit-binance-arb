/**
 * Estratégia 3 — Cash-and-carry numa só exchange (por defeito Bybit):
 * compra o ativo no spot e abre short do mesmo tamanho no perpétuo USDT. A posição fica
 * delta-neutra e recebe o funding enquanto for positivo (longs pagam shorts).
 *
 * Só entra quando: funding atual E médio das últimas 24h acima do mínimo, APR líquido após
 * 4 taxas e basis acima do mínimo, mercado saudável (sem delisting, >14 dias listado, open interest
 * e volume suficientes) e dentro da janela antes do settlement (para receber o 1.º funding cedo).
 * Sai quando o funding desaparece (confirmações), stop-loss de basis, margem em perigo ou tempo máximo.
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { evaluateCarry, normalizeFundingTo8h, minutesTo, pct, usd } from '../math.js';
import { marketHealthIssue, FundingHistoryCache, OpenInterestCache, qualityIssue, intervalHours } from '../filters.js';
import { setCandidates, recordBest } from '../stats.js';
import { openCarryPosition, closeCarryPosition } from '../executor.js';
import { state, save, recordTrade } from '../state.js';
import { tradingBlockedReason, canOpenNotional } from '../risk.js';
import { notify } from '../notify.js';
import { carrySymbols } from '../exchanges.js';
import { fundingIntervalHours } from './fundingArb.js';

const log = createLogger('carry');

export class CarryStrategy {
  constructor(exs) {
    this.ex = exs[config.carry.exchange];
    if (!this.ex) throw new Error(`carry: exchange ${config.carry.exchange} não está ativa (EXCHANGES=${config.exchanges.join(',')})`);
    const all = carrySymbols(this.ex, config.carry.symbols);
    const excluded = [];
    this.symbols = all.filter((s) => {
      const issue = marketHealthIssue(this.ex.markets[s]) || marketHealthIssue(this.ex.markets[spotOf(this.ex, s)]);
      if (issue) excluded.push(`${s.split(':')[0]} (${issue})`);
      return !issue;
    });
    this.history = new FundingHistoryCache();
    this.oi = new OpenInterestCache();
    this.tickers = {};
    this.exitCounters = {};
    this.lastAccrualAt = {};
    log.info(`${this.ex.label}: perps com spot: ${this.symbols.length}; excluídos (delisting/novos/blacklist): ${excluded.length}`);
    if (excluded.length) log.debug(`excluídos: ${excluded.join(', ')}`);
    log.info(
      `limiar: funding 8h >= ${pct(config.carry.minRate8hPct, 4)}, APR líquido >= ${pct(config.carry.minNetAprPct, 1)}, ` +
        `tamanho ${usd(config.carry.positionUsd)}, alavancagem ${config.carry.leverage}x, máx ${config.carry.maxOpenPositions} posições`,
    );
  }

  async fetchRates() {
    const raw = await this.ex.fetchFundingRates(this.symbols);
    const out = {};
    for (const s of this.symbols) {
      const fr = raw[s];
      if (!fr || typeof fr.fundingRate !== 'number') continue;
      const market = this.ex.markets[s];
      const hours = fundingIntervalHours(fr, market);
      out[s] = {
        rate: fr.fundingRate,
        intervalHours: hours,
        rate8h: normalizeFundingTo8h(fr.fundingRate, hours),
        mark: fr.markPrice || fr.indexPrice || null,
        nextFunding: fr.fundingTimestamp || null,
      };
    }
    return out;
  }

  async fetchTickers() {
    try {
      const [perp, spot] = await Promise.all([
        this.ex.fetchTickers(this.symbols),
        this.ex.fetchTickers(this.symbols.map((s) => spotOf(this.ex, s))),
      ]);
      this.tickers = { perp, spot };
    } catch (e) {
      log.warn(`tickers falharam: ${e.message}`);
      this.tickers = { perp: {}, spot: {} };
    }
  }

  /** Avaliação com top-of-book real: ask do spot (compramos) e bid do perp (vendemos). */
  async evaluate(symbol, r) {
    const spotSymbol = spotOf(this.ex, symbol);
    const [spotOb, perpOb] = await Promise.all([this.ex.fetchOrderBook(spotSymbol, 5), this.ex.fetchOrderBook(symbol, 5)]);
    const spotAsk = spotOb.asks[0]?.[0];
    const perpBid = perpOb.bids[0]?.[0];
    if (!spotAsk || !perpBid) return null;
    const ev = evaluateCarry({
      rate8h: r.rate8h,
      spotAsk,
      perpBid,
      spotFee: this.ex.fees_.spotTaker,
      perpFee: this.ex.fees_.swapTaker,
      expectedHoldHours: config.carry.expectedHoldHours,
    });
    return { symbol, spotSymbol, spotAsk, perpBid, nextFunding: r.nextFunding, intervalHours: r.intervalHours, ...ev };
  }

  async tick() {
    const rates = await this.fetchRates();
    await this.fetchTickers();
    await this.managePositions(rates);

    const ranked = Object.entries(rates)
      .filter(([, r]) => r.rate8h > 0)
      .sort((a, b) => b[1].rate8h - a[1].rate8h)
      .slice(0, config.carry.topN);
    if (ranked[0]) recordBest('carry', ranked[0][0], ranked[0][1].rate8h);

    const open = Object.keys(state.carryPositions).length;
    const seen = [];
    let opened = 0;
    for (const [symbol, r] of ranked) {
      const row = { symbol: symbol.split(':')[0], rate8h: r.rate8h, netAprPct: null, basisPct: null, reason: null };
      seen.push(row);
      if (state.carryPositions[symbol]) { row.reason = 'já aberta'; continue; }
      if (r.rate8h < config.carry.minRate8hPct) { row.reason = 'funding abaixo do mínimo'; continue; }
      if (open + opened >= config.carry.maxOpenPositions) { row.reason = 'máx. posições abertas'; continue; }
      const ev = await this.evaluate(symbol, r);
      if (!ev) { row.reason = 'sem book'; continue; }
      row.netAprPct = ev.netAprPct;
      row.basisPct = ev.basisPct;
      if (ev.basisCostPct > config.carry.maxBasisCostPct) { row.reason = `perp ${pct(ev.basisCostPct, 3)} abaixo do spot (basis custa demasiado)`; continue; }
      if (ev.netAprPct < config.carry.minNetAprPct) { row.reason = `APR líquido ${pct(ev.netAprPct, 1)} abaixo do mínimo`; continue; }
      row.reason = await this.qualityCheck(ev);
      if (row.reason) continue;
      if (!canOpenNotional(config.carry.positionUsd * 2)) { row.reason = 'notional máximo atingido'; continue; }
      const blocked = tradingBlockedReason();
      if (blocked) { row.reason = blocked; log.warn(`oportunidade carry ignorada (${blocked}): ${symbol}`); break; }
      const ok = await this.open(ev);
      row.reason = ok ? 'ABERTA' : 'abertura falhou';
      if (ok) opened++;
    }
    setCandidates('carry', seen);
    const best = seen[0];
    if (best) log.info(`melhor: ${best.symbol} ${pct(best.rate8h, 4)}/8h${best.netAprPct !== null ? ` APR líq. ${pct(best.netAprPct, 1)}` : ''} → ${best.reason}`);
  }

  async qualityCheck(ev) {
    const perpT = this.tickers.perp?.[ev.symbol];
    const spotT = this.tickers.spot?.[ev.spotSymbol];
    const volume = Math.min(Number(perpT?.quoteVolume || Infinity), Number(spotT?.quoteVolume || Infinity));
    const oiUsd = await this.oi.valueUsd(this.ex, ev.symbol, ev.perpBid, perpT);
    const history = await this.history.summary(this.ex, ev.symbol);
    const issue = qualityIssue({
      history,
      oiUsd,
      volumeUsd: Number.isFinite(volume) ? volume : null,
      positionUsd: config.carry.positionUsd,
      minMean8h: config.carry.minRate8hPct,
    });
    if (issue) return issue;
    if (config.carry.entryWindowMin > 0) {
      const mins = minutesTo(ev.nextFunding);
      if (mins !== null && mins > config.carry.entryWindowMin) return `à espera da janela de settlement (${Math.round(mins)} min)`;
    }
    return null;
  }

  async open(ev) {
    const perp = this.ex.markets[ev.symbol];
    const spot = this.ex.markets[ev.spotSymbol];
    const cs = perp.contractSize || 1;
    const raw = config.carry.positionUsd / (ev.spotAsk * cs);
    const amount = Number(this.ex.amountToPrecision(ev.symbol, raw));
    const minPerp = perp.limits?.amount?.min || 0;
    const minSpot = spot.limits?.amount?.min || 0;
    const minCost = Math.max(spot.limits?.cost?.min || 0, perp.limits?.cost?.min || 0);
    if (amount < Math.max(minPerp, minSpot) || amount * ev.spotAsk < minCost) {
      log.info(`${ev.symbol}: tamanho ${usd(config.carry.positionUsd)} abaixo do mínimo da exchange (qtd ${amount}, custo mín ${usd(minCost)})`);
      return false;
    }
    if (config.live) {
      const bal = await this.ex.fetchBalance();
      const free = Number(bal.free?.USDT || 0);
      const need = config.carry.positionUsd * (1 + 1 / config.carry.leverage) * 1.02;
      if (free < need) {
        log.info(`${ev.symbol}: saldo USDT livre ${usd(free)} < necessário ${usd(need)}`);
        return false;
      }
    }
    log.info(`ABRIR CARRY ${ev.symbol}: spot long + perp short ${amount} (~${usd(config.carry.positionUsd)}) | funding ${pct(ev.rate8h, 4)}/8h, basis ${pct(ev.basisPct, 3)}, APR líq. ${pct(ev.netAprPct, 1)}`);
    const res = await openCarryPosition({ ex: this.ex, spotSymbol: ev.spotSymbol, perpSymbol: ev.symbol, amount, prices: { spot: ev.spotAsk, perp: ev.perpBid } });
    if (!res.ok) {
      log.error(`${ev.symbol}: abertura carry falhou — ${res.error}`);
      notify(`⚠️ CARRY ${ev.symbol}: abertura falhou — ${res.error}`);
      return false;
    }
    state.carryPositions[ev.symbol] = {
      symbol: ev.symbol,
      spotSymbol: ev.spotSymbol,
      exchange: this.ex.id,
      amount: res.amount,
      contractSize: cs,
      entrySpot: res.spotPrice,
      entryPerp: res.perpPrice,
      entryFees: res.fees,
      entryRate8h: ev.rate8h,
      openedAt: Date.now(),
      notionalUsd: res.amount * cs * res.spotPrice * 2,
      fundingAccruedUsd: 0,
      legPnlUsd: 0,
    };
    state.carryTrades++;
    this.lastAccrualAt[ev.symbol] = Date.now();
    this.exitCounters[ev.symbol] = 0;
    save();
    recordBest('carry', ev.symbol, ev.rate8h, true);
    notify(`${config.live ? '💰' : '🧪'} CARRY ABERTO ${ev.symbol} em ${this.ex.label}: ${res.amount} @ spot ${res.spotPrice} / perp ${res.perpPrice} | funding ${pct(ev.rate8h, 4)}/8h, APR líq. ${pct(ev.netAprPct, 1)}\nTaxas entrada ${usd(res.fees, 3)}`);
    return true;
  }

  async managePositions(rates) {
    for (const pos of Object.values(state.carryPositions)) {
      if (pos.exchange !== this.ex.id) continue;
      const r = rates[pos.symbol];
      const now = Date.now();
      if (r) {
        const last = this.lastAccrualAt[pos.symbol] || pos.openedAt;
        pos.fundingAccruedUsd += r.rate8h * (pos.notionalUsd / 2) * ((now - last) / 3600_000 / 8);
        this.lastAccrualAt[pos.symbol] = now;
        const spotLast = this.tickers.spot?.[pos.spotSymbol]?.last;
        const perpLast = r.mark || this.tickers.perp?.[pos.symbol]?.last;
        if (spotLast && perpLast) {
          pos.legPnlUsd = (spotLast - pos.entrySpot) * pos.amount * pos.contractSize + (pos.entryPerp - perpLast) * pos.amount * pos.contractSize;
        }
        this.exitCounters[pos.symbol] = r.rate8h < config.carry.exitRate8hPct ? (this.exitCounters[pos.symbol] || 0) + 1 : 0;
      } else {
        // perp desapareceu do universo (delisting?) — fechar
        await this.close(pos, 'perp sem funding/mercado');
        continue;
      }
      const heldHours = (now - pos.openedAt) / 3600_000;
      const rateGone = (this.exitCounters[pos.symbol] || 0) >= config.carry.exitConfirmations && heldHours >= config.carry.minHoldHours;
      const tooLong = heldHours >= config.carry.maxHoldHours;
      const legLoss = Number.isFinite(pos.legPnlUsd) && pos.legPnlUsd < -config.carry.maxLegLossPct * pos.notionalUsd;
      if (legLoss || rateGone || tooLong) {
        await this.close(pos, legLoss ? `stop-loss basis (${usd(pos.legPnlUsd, 3)})` : rateGone ? 'funding desapareceu' : 'tempo máximo');
      } else if (config.live) {
        await this.checkMargin(pos);
      }
    }
    save();
  }

  async checkMargin(pos) {
    try {
      const list = await this.ex.fetchPositions([pos.symbol]);
      for (const p of list) {
        if (!p?.contracts || !p.liquidationPrice || !p.markPrice) continue;
        const dist = Math.abs(p.markPrice - p.liquidationPrice) / p.markPrice;
        if (dist < 0.15) {
          const msg = `⚠️ CARRY ${pos.symbol}: liquidação a ${pct(dist, 1)} do mark — a fechar por segurança`;
          log.warn(msg);
          notify(msg);
          await this.close(pos, 'margem em perigo');
        }
      }
    } catch (e) {
      log.debug(`checkMargin: ${e.message}`);
    }
  }

  async close(pos, reason) {
    const [spotOb, perpOb] = await Promise.all([this.ex.fetchOrderBook(pos.spotSymbol, 5), this.ex.fetchOrderBook(pos.symbol, 5)]);
    const prices = { spot: spotOb.bids[0]?.[0] || pos.entrySpot, perp: perpOb.asks[0]?.[0] || pos.entryPerp };
    log.info(`FECHAR CARRY ${pos.symbol} (${reason})`);
    const res = await closeCarryPosition({ ex: this.ex, spotSymbol: pos.spotSymbol, perpSymbol: pos.symbol, amount: pos.amount, prices });
    const legPnl = (res.spotPrice - pos.entrySpot) * pos.amount * pos.contractSize + (pos.entryPerp - res.perpPrice) * pos.amount * pos.contractSize;
    const pnl = pos.fundingAccruedUsd + legPnl - pos.entryFees - res.fees;
    const heldHours = (Date.now() - pos.openedAt) / 3600_000;
    recordTrade({
      strategy: 'carry',
      symbol: pos.symbol,
      exchange: pos.exchange,
      reason,
      heldHours,
      fundingUsd: pos.fundingAccruedUsd,
      legPnlUsd: legPnl,
      feesUsd: pos.entryFees + res.fees,
      pnlUsd: pnl,
      ok: res.ok,
    });
    delete state.carryPositions[pos.symbol];
    delete this.exitCounters[pos.symbol];
    delete this.lastAccrualAt[pos.symbol];
    save();
    const msg = `${config.live ? '💰' : '🧪'} CARRY FECHADO ${pos.symbol} (${reason}) após ${heldHours.toFixed(1)}h | funding ${usd(pos.fundingAccruedUsd, 3)} + pernas ${usd(legPnl, 3)} - taxas ${usd(pos.entryFees + res.fees, 3)} = P&L ${usd(pnl, 3)}${res.ok ? '' : ' ⚠️ FECHO INCOMPLETO'}`;
    log.info(msg);
    notify(msg);
  }
}

export function spotOf(ex, perpSymbol) {
  const m = ex.markets[perpSymbol];
  return `${m.base}/USDT`;
}
