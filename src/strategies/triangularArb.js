import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { evaluateTriangleRoute, pct, usd } from '../math.js';
import { executeTriangularArb } from '../executor.js';
import { state, save, recordTrade, recordOpportunity } from '../state.js';
import { tradingBlockedReason, isStale } from '../risk.js';
import { notify } from '../notify.js';
import { EXCHANGE_IDS } from '../exchanges.js';

const log = createLogger('tri');

/**
 * Arbitragem triangular intra-exchange: USDT -> X -> BTC -> USDT (fwd)
 * e o inverso USDT -> BTC -> X -> USDT (rev), por cada base X com mercados
 * X/USDT, X/BTC e BTC/USDT ativos na exchange. Três taxas taker tornam as
 * margens muito finas — por isso corre separada (TRI_ARB_ENABLED).
 */
export class TriangularArbStrategy {
  constructor(exs) {
    this.exs = exs;
    this.cooldown = new Map();
    this.polls = 0;
    this.best = { route: null, grossPct: -Infinity };
    // rotas candidatas: { exId, base }
    this.routes = [];
    for (const id of EXCHANGE_IDS) {
      const markets = exs[id].markets;
      const has = (s) => markets[s]?.spot && markets[s].active !== false;
      if (!has('BTC/USDT')) continue;
      const wanted = config.triangular.symbols.length
        ? config.triangular.symbols.map((b) => b.replace(/\/.*$/, ''))
        : Object.keys(markets).map((s) => markets[s].base);
      for (const base of wanted) {
        if (base === 'BTC') continue;
        if (has(`${base}/USDT`) && has(`${base}/BTC`)) this.routes.push({ exId: id, base });
      }
    }
    this.routeSymbols = {};
    for (const id of EXCHANGE_IDS) {
      const set = new Set(['BTC/USDT']);
      for (const r of this.routes) if (r.exId === id) { set.add(`${r.base}/USDT`); set.add(`${r.base}/BTC`); }
      this.routeSymbols[id] = [...set];
    }
    const fee = Math.min(...EXCHANGE_IDS.map((id) => exs[id].fees_.spotTaker));
    log.info(`rotas triangulares: ${this.routes.length} (3 taxas taker por rota; limiar líquido ${pct(config.triangular.minNetPct, 3)})`);
    if (!this.routes.length) log.warn('nenhuma base com mercados X/USDT + X/BTC + BTC/USDT ativos');
  }

  routeKey(r, dir) {
    return `${r.exId}:${r.base}:${dir}`;
  }

  /** Avalia ambas as direções para uma base usando topo do livro (barato). */
  topOfBook(r, quotes) {
    const q = quotes[r.exId];
    const xu = q[`${r.base}/USDT`];
    const xb = q[`${r.base}/BTC`];
    const bu = q['BTC/USDT'];
    if (!xu?.ask || !xu?.bid || !xb?.ask || !xb?.bid || !bu?.ask || !bu?.bid) return [];
    const fee = this.exs[r.exId].fees_.spotTaker;
    const keep = (1 - fee) ** 3;
    const out = [];
    // fwd: USDT -> X -> BTC -> USDT
    const fwd = (1 / xu.ask) * xb.bid * bu.bid * keep;
    out.push({ dir: 'fwd', gross: fwd - 1, legs: [
      { symbol: `${r.base}/USDT`, side: 'buy', limit: xu.ask * (1 + config.spot.iocPriceTolPct) },
      { symbol: `${r.base}/BTC`, side: 'sell', limit: xb.bid * (1 - config.spot.iocPriceTolPct) },
      { symbol: 'BTC/USDT', side: 'sell', limit: bu.bid * (1 - config.spot.iocPriceTolPct) },
    ] });
    // rev: USDT -> BTC -> X -> USDT
    const rev = (1 / bu.ask) * (1 / xb.ask) * xu.bid * keep;
    out.push({ dir: 'rev', gross: rev - 1, legs: [
      { symbol: 'BTC/USDT', side: 'buy', limit: bu.ask * (1 + config.spot.iocPriceTolPct) },
      { symbol: `${r.base}/BTC`, side: 'buy', limit: xb.ask * (1 + config.spot.iocPriceTolPct) },
      { symbol: `${r.base}/USDT`, side: 'sell', limit: xu.bid * (1 - config.spot.iocPriceTolPct) },
    ] });
    return out;
  }

  async tick() {
    this.polls++;
    const quotes = {};
    await Promise.all(
      EXCHANGE_IDS.map(async (id) => {
        if (this.routeSymbols[id].length) {
          const ex = this.exs[id];
          quotes[id] = ex.has.fetchBidsAsks
            ? await ex.fetchBidsAsks(this.routeSymbols[id])
            : await ex.fetchTickers(this.routeSymbols[id]);
        }
      }),
    );

    const candidates = [];
    for (const r of this.routes) {
      for (const cand of this.topOfBook(r, quotes)) {
        if (cand.gross > this.best.grossPct) this.best = { route: this.routeKey(r, cand.dir), grossPct: cand.gross };
        if (cand.gross >= config.triangular.minNetPct) candidates.push({ ...cand, exId: r.exId, base: r.base });
      }
    }
    if (this.polls % 40 === 0) {
      log.info(`${this.polls} varrimentos | melhor bruto topo do livro: ${this.best.route} ${pct(this.best.grossPct)}`);
      this.best = { route: null, grossPct: -Infinity };
    }

    candidates.sort((a, b) => b.gross - a.gross);
    for (const c of candidates.slice(0, 3)) {
      const until = this.cooldown.get(this.routeKey(c, c.dir)) || 0;
      if (Date.now() < until) continue;
      await this.evaluateAndExecute(c);
    }
  }

  async evaluateAndExecute(c) {
    const ex = this.exs[c.exId];
    const books = {};
    await Promise.all(
      c.legs.map(async (leg) => {
        if (!books[leg.symbol]) books[leg.symbol] = await ex.fetchOrderBook(leg.symbol, 20);
      }),
    );
    for (const leg of c.legs) {
      if (isStale(books[leg.symbol].timestamp)) return;
    }
    const ev = evaluateTriangleRoute({
      startUsd: config.triangular.tradeUsd,
      feeTaker: ex.fees_.spotTaker,
      slippageBuffer: config.triangular.slippageBufferPct,
      legs: c.legs.map((leg) => ({ ...leg, asks: books[leg.symbol].asks, bids: books[leg.symbol].bids })),
    });
    const key = this.routeKey(c, c.dir);
    if (!ev.ok) {
      log.debug(`${key}: ${ev.reason}`);
      return;
    }
    state.opportunitiesSeen++;
    const path = c.legs.map((l) => `${l.side === 'buy' ? '↑' : '↓'}${l.symbol}`).join(' ');
    const line = `${ex.label} ${path} | líquido ${pct(ev.netPct)} (${usd(ev.net, 3)})`;
    if (ev.netPct < config.triangular.minNetPct || ev.net < config.triangular.minNetUsd) {
      recordOpportunity({ strategy: 'tri', symbol: `${c.base} (${ex.id})`, dir: c.dir, netPct: ev.netPct, netUsd: ev.net, executed: false });
      log.info(`oportunidade fraca (profundidade real): ${line}`);
      this.cooldown.set(key, Date.now() + 3000);
      return;
    }
    const blocked = tradingBlockedReason();
    if (blocked) {
      recordOpportunity({ strategy: 'tri', symbol: `${c.base} (${ex.id})`, dir: c.dir, netPct: ev.netPct, netUsd: ev.net, executed: false, note: blocked });
      log.warn(`oportunidade ignorada (${blocked}): ${line}`);
      return;
    }

    log.info(`EXECUTAR: ${line}`);
    const result = await executeTriangularArb({ ex, startUsd: config.triangular.tradeUsd, legs: c.legs, evaluation: ev });
    state.spotTrades++;
    recordOpportunity({ strategy: 'tri', symbol: `${c.base} (${ex.id})`, dir: c.dir, netPct: ev.netPct, netUsd: result.pnlUsd, executed: true });
    recordTrade({
      strategy: 'tri',
      symbol: c.base,
      ex: c.exId,
      dir: c.dir,
      path,
      expectedNetUsd: ev.net,
      pnlUsd: result.pnlUsd,
      ok: result.ok,
      detail: result.detail,
    });
    save();
    this.cooldown.set(key, Date.now() + config.triangular.cooldownMs);
    const tag = config.live ? '💰' : '🧪';
    const msg = `${tag} TRI ${c.base} ${c.dir} em ${ex.label} | P&L ${usd(result.pnlUsd, 3)} (esperado ${usd(ev.net, 3)})${result.ok ? '' : ' ⚠️ FALHA'}`;
    log.info(msg);
    if (config.live || !result.ok) notify(msg);
  }
}
