/**
 * Modelo de slippage: estima custo de execução por (exchange, symbol, side, size),
 * considerando profundidade real, spread e volatilidade recente. Mantém histórico
 * de slippage realizado (P50/P90/P99) para comparar esperado vs realizado.
 */

const MAX_HIST = 500;

export class SlippageModel {
  constructor() {
    this.history = new Map(); // key `${exchange}:${symbol}` -> bps realizados
    this.volatility = new Map(); // key -> [{ts, mid}]
  }

  key(exchange, symbol) {
    return `${exchange}:${symbol}`;
  }

  observeMid(exchange, symbol, mid, ts = Date.now()) {
    const k = this.key(exchange, symbol);
    let a = this.volatility.get(k);
    if (!a) this.volatility.set(k, (a = []));
    const last = a[a.length - 1];
    if (last && ts - last.ts < 500) return;
    a.push({ ts, mid });
    const cutoff = ts - 15 * 60_000;
    while (a.length && a[0].ts < cutoff) a.shift();
  }

  /** Volatilidade: desvio padrão dos retornos de mid nos últimos 15min, em bps. */
  volatilityBps(exchange, symbol) {
    const a = this.volatility.get(this.key(exchange, symbol)) || [];
    if (a.length < 5) return null;
    const rets = [];
    for (let i = 1; i < a.length; i++) rets.push((a[i].mid - a[i - 1].mid) / a[i - 1].mid);
    const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
    const varr = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / rets.length;
    return Math.sqrt(varr) * 10_000;
  }

  /**
   * Estimativa de slippage em bps para executar quoteUsd.
   * bookImpactBps: impacto medido no livro (do VWAP vs mid).
   * Conservador = book impact + spread/2 + componente de volatilidade.
   */
  estimate({ bookImpactBps = 0, spreadBps = 0, volatilityBps = 0, quoteUsd = 0 }) {
    const vol = Math.min(50, volatilityBps || 0);
    const estimated = bookImpactBps + spreadBps / 4 + vol * 0.15;
    const conservative = bookImpactBps * 1.5 + spreadBps / 2 + vol * 0.35 + (quoteUsd > 250 ? 2 : 0);
    const { p50, p90, p99 } = this.percentiles();
    return {
      estimatedSlippageBps: round2(Math.max(0.5, estimated)),
      conservativeSlippageBps: round2(Math.max(1, conservative, p90 ?? 0)),
      historicalP50: p50,
      historicalP90: p90,
      historicalP99: p99,
    };
  }

  recordRealized(exchange, symbol, bps) {
    if (!Number.isFinite(bps)) return;
    const k = this.key(exchange, symbol);
    let a = this.history.get(k);
    if (!a) this.history.set(k, (a = []));
    a.push(bps);
    if (a.length > MAX_HIST) a.shift();
  }

  percentiles(exchange = null, symbol = null) {
    let all = [];
    if (exchange) all = this.history.get(this.key(exchange, symbol)) || [];
    else for (const a of this.history.values()) all = all.concat(a);
    if (!all.length) return { p50: null, p90: null, p99: null };
    const s = all.slice().sort((x, y) => x - y);
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return { p50: round2(pick(0.5)), p90: round2(pick(0.9)), p99: round2(pick(0.99)) };
  }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
