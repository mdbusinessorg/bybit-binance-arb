import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { evaluateSpotArb, pct, usd } from '../math.js';
import { executeSpotArb } from '../executor.js';
import { state, save, recordTrade } from '../state.js';
import { tradingBlockedReason, isStale } from '../risk.js';
import { notify } from '../notify.js';
import { commonSpotSymbols, EXCHANGE_IDS, other } from '../exchanges.js';

const log = createLogger('spot');

export class SpotArbStrategy {
  constructor(exs) {
    this.exs = exs;
    this.symbols = commonSpotSymbols(exs, config.spot.symbols);
    this.cooldown = new Map();
    this.balances = { bybit: null, binance: null };
    this.balancesAt = 0;
    this.polls = 0;
    this.best = { symbol: null, grossPct: -Infinity, dir: null };
    this.threshold = this.minGrossPct();
    log.info(`símbolos comuns: ${this.symbols.length}/${config.spot.symbols.length} -> ${this.symbols.join(', ')}`);
    log.info(
      `limiar: spread bruto >= ${pct(this.threshold, 3)} (taxas ${pct(exs.bybit.fees_.spotTaker + exs.binance.fees_.spotTaker, 3)} + ` +
        `lucro mínimo ${pct(config.spot.minNetPct, 3)} + margem slippage ${pct(config.spot.slippageBufferPct, 3)}), tamanho ${usd(config.spot.tradeUsd)}`,
    );
  }

  minGrossPct() {
    return this.exs.bybit.fees_.spotTaker + this.exs.binance.fees_.spotTaker + config.spot.minNetPct + config.spot.slippageBufferPct;
  }

  async refreshBalances(force = false) {
    if (!config.live && !config.simulate) return;
    if (!force && Date.now() - this.balancesAt < 60_000) return;
    const res = await Promise.allSettled(EXCHANGE_IDS.map((id) => this.exs[id].fetchBalance({ type: 'spot' })));
    EXCHANGE_IDS.forEach((id, i) => {
      if (res[i].status === 'fulfilled') this.balances[id] = res[i].value;
      else log.warn(`${id} fetchBalance falhou: ${res[i].reason?.message}`);
    });
    this.balancesAt = Date.now();
  }

  free(id, currency) {
    const b = this.balances[id];
    if (!b) return Infinity; // dry-run sem chaves: assume fundos suficientes
    return Number(b.free?.[currency] ?? b[currency]?.free ?? 0);
  }

  async tick() {
    this.polls++;
    const [tb, tn] = await Promise.all([
      this.exs.bybit.fetchBidsAsks(this.symbols),
      this.exs.binance.fetchBidsAsks(this.symbols),
    ]);
    const quotes = { bybit: tb, binance: tn };
    const candidates = [];

    for (const symbol of this.symbols) {
      for (const buyId of EXCHANGE_IDS) {
        const sellId = other(buyId);
        const q1 = quotes[buyId][symbol];
        const q2 = quotes[sellId][symbol];
        if (!q1?.ask || !q2?.bid) continue;
        if (isStale(q1.timestamp) || isStale(q2.timestamp)) continue;
        const grossPct = (q2.bid - q1.ask) / q1.ask;
        if (grossPct > this.best.grossPct) this.best = { symbol, grossPct, dir: `${buyId}->${sellId}` };
        if (grossPct >= this.threshold && grossPct <= config.spot.maxSpreadPct) {
          candidates.push({ symbol, buyId, sellId, grossPct, ask: q1.ask, bid: q2.bid });
        }
      }
    }

    if (this.polls % 40 === 0) {
      log.info(`${this.polls} varrimentos | melhor spread visto: ${this.best.symbol} ${this.best.dir} ${pct(this.best.grossPct)} | limiar ${pct(this.threshold)}`);
      this.best = { symbol: null, grossPct: -Infinity, dir: null };
    }

    candidates.sort((a, b) => b.grossPct - a.grossPct);
    for (const c of candidates.slice(0, 3)) {
      const until = this.cooldown.get(c.symbol) || 0;
      if (Date.now() < until) continue;
      await this.evaluateAndExecute(c);
    }
  }

  async evaluateAndExecute(c) {
    const buyEx = this.exs[c.buyId];
    const sellEx = this.exs[c.sellId];
    const [obBuy, obSell] = await Promise.all([buyEx.fetchOrderBook(c.symbol, 20), sellEx.fetchOrderBook(c.symbol, 20)]);
    if (isStale(obBuy.timestamp) || isStale(obSell.timestamp)) {
      log.debug(`${c.symbol}: livro de ordens obsoleto, ignorar`);
      return;
    }

    await this.refreshBalances();
    let tradeUsd = config.spot.tradeUsd;
    const market = buyEx.market(c.symbol);
    const usdtFree = this.free(c.buyId, 'USDT');
    const baseFree = this.free(c.sellId, market.base);
    tradeUsd = Math.min(tradeUsd, usdtFree * 0.98, baseFree * c.bid * 0.98);
    if (!Number.isFinite(tradeUsd)) tradeUsd = config.spot.tradeUsd;
    const minCost = market.limits?.cost?.min || 5;
    if (tradeUsd < Math.max(minCost, 5)) {
      log.debug(`${c.symbol}: saldo insuficiente (USDT em ${buyEx.label}: ${usdtFree}, ${market.base} em ${sellEx.label}: ${baseFree})`);
      this.cooldown.set(c.symbol, Date.now() + 60_000);
      return;
    }

    const ev = evaluateSpotArb({
      buyAsks: obBuy.asks,
      sellBids: obSell.bids,
      tradeUsd,
      buyFee: buyEx.fees_.spotTaker,
      sellFee: sellEx.fees_.spotTaker,
      slippageBuffer: config.spot.slippageBufferPct,
    });
    if (!ev || !ev.ok) {
      log.debug(`${c.symbol}: ${ev?.reason || 'sem avaliação'}`);
      return;
    }
    state.opportunitiesSeen++;
    const line = `${c.symbol} comprar ${buyEx.label} @${ev.buyPrice.toPrecision(6)} -> vender ${sellEx.label} @${ev.sellPrice.toPrecision(6)} | bruto ${pct(ev.grossPct)} | líquido ${pct(ev.netPct)} (${usd(ev.net, 3)})`;
    if (ev.netPct < config.spot.minNetPct || ev.net < config.spot.minNetUsd) {
      log.info(`oportunidade fraca (profundidade real): ${line}`);
      this.cooldown.set(c.symbol, Date.now() + 3000);
      return;
    }

    const blocked = tradingBlockedReason();
    if (blocked) {
      log.warn(`oportunidade ignorada (${blocked}): ${line}`);
      return;
    }

    log.info(`EXECUTAR: ${line}`);
    const amount = Number(buyEx.amountToPrecision(c.symbol, ev.amount));
    const result = await executeSpotArb({
      buyEx,
      sellEx,
      symbol: c.symbol,
      amount,
      buyLimit: ev.buyPrice * (1 + config.spot.iocPriceTolPct),
      sellLimit: ev.sellPrice * (1 - config.spot.iocPriceTolPct),
      evaluation: ev,
    });
    state.spotTrades++;
    recordTrade({
      strategy: 'spot',
      symbol: c.symbol,
      buy: c.buyId,
      sell: c.sellId,
      amount,
      expectedNetUsd: ev.net,
      pnlUsd: result.pnlUsd,
      ok: result.ok,
      detail: result.detail,
    });
    save();
    this.cooldown.set(c.symbol, Date.now() + config.spot.cooldownMs);
    this.balancesAt = 0;
    const tag = config.live ? '💰' : '🧪';
    const msg = `${tag} SPOT ${c.symbol}: ${buyEx.label}→${sellEx.label} ${usd(tradeUsd)} | P&L ${usd(result.pnlUsd, 3)} (esperado ${usd(ev.net, 3)})${result.ok ? '' : ' ⚠️ FALHA'}`;
    log.info(msg);
    if (config.live || !result.ok) notify(msg);
  }
}
