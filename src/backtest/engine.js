import { EdgeEngine, REASON } from '../edge/engine.js';
import { SlippageModel } from '../edge/slippage.js';
import { RiskGovernor } from '../risk/governor.js';
import { PaperEngine } from '../paper/engine.js';
import { normalizeBook } from '../market-data/normalize.js';
import { ExchangeHealthMonitor } from '../market-data/health.js';
import { emit } from '../events.js';

/**
 * BACKTEST / MARKET REPLAY — reproduz snapshots históricos como se fossem
 * tempo real. SEM look-ahead: cada decisão só usa dados daquele timestamp.
 * Suporta stress testing (multiplicadores de slippage/latência/liquidez) e
 * walk-forward (janelas train/validation/out-of-sample sobre o stream).
 *
 * Input: stream de "frames" [{ t, books: { exchangeId: { symbol: rawBook } } }]
 * (ver recorder.js — pode ser gravado em live ou gerado sinteticamente).
 */

export function runReplay({ frames, exchanges, symbol, tradeUsd, buyFee, sellFee, maxSpreadPct, stress = {} }) {
  const slip = new SlippageModel();
  const health = new ExchangeHealthMonitor(exchanges);
  const governor = new RiskGovernor(health);
  const engine = new EdgeEngine({ slippage: slip, governor, health });
  const paper = new PaperEngine({ slippage: slip, governor });
  const out = {
    frames: 0,
    signals: [],
    trades: [],
    rejected: {},
    expired: 0,
    simulated: 0,
  };
  const open = [];
  for (const frame of frames) {
    out.frames++;
    const { t, books } = frame;
    const pairBooks = collectPairBooks(books, exchanges, symbol);
    for (const [buyId, sellId, bb, sb] of pairBooks) {
      const buySnap = normalizeBook(buyId, symbol, bb, t);
      const sellSnap = normalizeBook(sellId, symbol, sb, t);
      slip.observeMid(buyId, symbol, (buySnap.bid + buySnap.ask) / 2, t);
      slip.observeMid(sellId, symbol, (sellSnap.bid + sellSnap.ask) / 2, t);
      if (stress.latencyFactor) {
        buySnap.dataAgeMs *= stress.latencyFactor;
        sellSnap.dataAgeMs *= stress.latencyFactor;
        if (buySnap.latencyMs) buySnap.latencyMs *= stress.latencyFactor;
        if (sellSnap.latencyMs) sellSnap.latencyMs *= stress.latencyFactor;
      }
      const opp = engine.evaluateCrossExchange({
        symbol,
        buySnap,
        sellSnap,
        tradeUsd: tradeUsd * (stress.sizeFactor ?? 1),
        buyFee: buyFee * (stress.feeFactor ?? 1),
        sellFee: sellFee * (stress.feeFactor ?? 1),
        detectedAt: t,
        maxSpreadPct,
      });
      if (opp.status === 'REJECTED') {
        out.rejected[opp.reasonCode] = (out.rejected[opp.reasonCode] || 0) + 1;
        continue;
      }
      // stress: reduz liquidez -> menor fillProbability; aumenta slippage
      const appliedSlippageBps = opp.measurements.conservativeSlippageBps * (stress.slippageFactor ?? 1);
      if (stress.liquidityFactor) opp.measurements.fillProbability = Math.max(0, opp.measurements.fillProbability * stress.liquidityFactor);
      open.push(opp);
      out.simulated++;
      const tr = paper.execute(opp, { appliedSlippageBps });
      tr.simulatedAt = t;
      out.trades.push(tr);
    }
    // TTL: expira oportunidades antigas ainda no pipeline
    for (const o of open) {
      if (t > o.expiresAt && o.status !== 'EXPIRED') {
        o.status = 'EXPIRED';
        o.signalLifetimeMs = t - o.detectedAt;
        out.expired++;
      }
    }
  }
  const stats = paper.stats();
  return {
    ...out,
    metrics: engine.metrics,
    paperStats: stats,
    falseOpportunityRate: out.simulated + engine.metrics.rejected > 0
      ? (engine.metrics.rejected + out.expired) / (out.simulated + engine.metrics.rejected + out.expired)
      : null,
  };
}

function collectPairBooks(books, exchanges, symbol) {
  const out = [];
  for (let i = 0; i < exchanges.length; i++) {
    for (let j = 0; j < exchanges.length; j++) {
      if (i === j) continue;
      const bb = books[exchanges[i]]?.[symbol];
      const sb = books[exchanges[j]]?.[symbol];
      if (bb && sb) out.push([exchanges[i], exchanges[j], bb, sb]);
    }
  }
  return out;
}

/** Stress test: corre o replay base + cenários e compara. */
export function runStressMatrix(args) {
  const scenarios = [
    { name: 'BASE', slippageFactor: 1, latencyFactor: 1 },
    { name: '+10% slippage', slippageFactor: 1.1 },
    { name: '+25% slippage', slippageFactor: 1.25 },
    { name: '+50% slippage', slippageFactor: 1.5 },
    { name: '2x latency', latencyFactor: 2 },
    { name: '3x latency', latencyFactor: 3 },
    { name: 'lower liquidity', liquidityFactor: 0.5 },
    { name: '2x fees', feeFactor: 2 },
  ];
  return scenarios.map((s) => {
    const r = runReplay({ ...args, stress: s });
    return {
      scenario: s.name,
      simulated: r.simulated,
      rejected: Object.values(r.rejected).reduce((a, b) => a + b, 0),
      expired: r.expired,
      netPnlUsd: r.paperStats.netPnlUsd,
      winRate: r.paperStats.winRate,
      maxDrawdownUsd: r.paperStats.maxDrawdownUsd,
      falseOpportunityRate: r.falseOpportunityRate,
    };
  });
}

/** Walk-forward: divide o stream em janelas e corre replay em cada uma. */
export function walkForward({ frames, windowSize, step, ...args }) {
  const out = [];
  for (let start = 0; start + windowSize <= frames.length; start += step) {
    const slice = frames.slice(start, start + windowSize);
    const r = runReplay({ ...args, frames: slice });
    out.push({
      window: `${new Date(slice[0].t).toISOString()} -> ${new Date(slice[slice.length - 1].t).toISOString()}`,
      inSample: start === 0 ? 'TRAINING' : 'VALIDATION',
      netPnlUsd: r.paperStats.netPnlUsd,
      simulated: r.simulated,
      falseOpportunityRate: r.falseOpportunityRate,
    });
  }
  return out;
}
