import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { emit } from '../events.js';
import { fillProbability } from '../edge/depth.js';

/**
 * PAPER TRADING ENGINE — SIGNAL -> SIMULATED ORDER -> SIMULATED FILL ->
 * POSITION UPDATE -> PNL UPDATE -> ANALYTICS.
 * Não assume fill de 100%: simula 25/50/75/100% conforme a liquidez.
 * Estados: DETECTED VALIDATED SIMULATED PARTIALLY_FILLED FILLED EXPIRED REJECTED FAILED
 */

const file = () => path.join(config.dataDir, config.simulate ? 'paper-trades.sim.jsonl' : 'paper-trades.jsonl');
const MAX_MEM = 500;

export class PaperEngine {
  constructor({ slippage, governor }) {
    this.slippage = slippage;
    this.governor = governor;
    this.trades = [];
  }

  /**
   * Simula a execução de uma oportunidade VALIDATED.
   * Devolve o paper trade gravado.
   */
  execute(opp, { appliedSlippageBps = null } = {}) {
    const m = opp.measurements;
    const slipBps = appliedSlippageBps ?? m.conservativeSlippageBps;
    const slipPct = slipBps / 10_000;
    const corr = opp.id;
    emit('simulation_started', 'paper', { id: opp.id, symbol: opp.symbol }, corr);

    // fill simulado pela liquidez
    const fp = m.fillProbability ?? 1;
    const fillRatio = fp >= 0.95 ? 1 : fp >= 0.7 ? 0.75 : fp >= 0.4 ? 0.5 : fp >= 0.2 ? 0.25 : 0;

    let status;
    let grossPnl = 0;
    let netPnl = 0;
    let rejectionReason = null;
    if (fillRatio === 0) {
      status = 'FAILED';
      rejectionReason = 'no simulated fill — liquidez insuficiente';
    } else {
      // piora o preço efetivo pelo slippage simulado
      const effectiveNetPct = m.netEdgePct - slipPct + m.estimatedSlippageBps / 10_000; // já incluído parcialmente: usa-se netEdge - extra slippage
      const extraSlip = Math.max(0, slipPct - m.estimatedSlippageBps / 10_000);
      const tradeUsd = m.buyVwap * m.amount;
      grossPnl = m.grossUsd * fillRatio;
      netPnl = (m.netUsd - tradeUsd * extraSlip) * fillRatio;
      status = fillRatio >= 1 ? 'FILLED' : 'PARTIALLY_FILLED';
    }

    const realizedSlippageBps = slipBps;
    const trade = {
      id: crypto.randomUUID(),
      opportunityId: opp.id,
      timestamp: new Date().toISOString(),
      mode: 'PAPER TRADE',
      strategy: opp.strategy,
      exchangeA: opp.buyVenue,
      exchangeB: opp.sellVenue ?? null,
      symbol: opp.symbol,
      side: 'buy->sell',
      quantity: m.amount * fillRatio,
      expectedEntry: m.buyVwap,
      simulatedEntry: m.buyVwap ? m.buyVwap * (1 + slipPct / 2) : null,
      expectedExit: m.sellVwap,
      simulatedExit: m.sellVwap ? m.sellVwap * (1 - slipPct / 2) : null,
      feesPct: m.feesPct,
      expectedSlippageBps: m.estimatedSlippageBps,
      realizedSlippageBps,
      slippageErrorBps: Math.round((realizedSlippageBps - m.estimatedSlippageBps) * 100) / 100,
      latencyMs: m.latencyMs,
      fillRatio,
      fillProbability: m.fillProbability,
      grossPnL: round(grossPnl),
      netPnL: round(netPnl),
      status,
      rejectionReason,
      confidence: opp.confidence,
      regime: opp.regime,
    };
    this.trades.push(trade);
    if (this.trades.length > MAX_MEM) this.trades.splice(0, this.trades.length - MAX_MEM);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.appendFileSync(file(), JSON.stringify(trade) + '\n');
    } catch {}
    if (status !== 'FAILED') this.slippage?.recordRealized(opp.buyVenue, opp.symbol, realizedSlippageBps);
    this.governor?.recordSimulatedLoss(netPnl);
    emit('simulation_completed', 'paper', { id: trade.id, status, netPnL: trade.netPnL }, corr);
    return trade;
  }

  stats() {
    const t = this.trades;
    const filled = t.filter((x) => x.status === 'FILLED' || x.status === 'PARTIALLY_FILLED');
    const wins = filled.filter((x) => x.netPnL > 0);
    const pnls = filled.map((x) => x.netPnL);
    const grossProfit = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const grossLoss = -pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    // drawdown sobre a curva cumulativa
    let peak = 0;
    let cum = 0;
    let maxDd = 0;
    for (const p of pnls) {
      cum += p;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDd) maxDd = peak - cum;
    }
    const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const sd = pnls.length > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1)) : null;
    return {
      simulatedTrades: filled.length,
      failed: t.filter((x) => x.status === 'FAILED').length,
      winRate: filled.length ? wins.length / filled.length : null,
      netPnlUsd: round(pnls.reduce((a, b) => a + b, 0)),
      avgNetPnlUsd: round(mean),
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
      maxDrawdownUsd: round(maxDd),
      sharpeLike: sd ? round((mean / sd) * Math.sqrt(pnls.length)) : null,
      avgSlippageBps: filled.length ? round(filled.reduce((a, x) => a + x.realizedSlippageBps, 0) / filled.length) : null,
      avgLatencyMs: filled.length ? Math.round(filled.reduce((a, x) => a + x.latencyMs, 0) / filled.length) : null,
      avgFillRate: filled.length ? round(filled.reduce((a, x) => a + x.fillRatio, 0) / filled.length) : null,
      returnDistribution: distribution(pnls),
    };
  }
}

function distribution(pnls) {
  const buckets = { '<-0.5': 0, '-0.5..-0.1': 0, '-0.1..0': 0, '0..0.1': 0, '0.1..0.5': 0, '>0.5': 0 };
  for (const p of pnls) {
    if (p < -0.5) buckets['<-0.5']++;
    else if (p < -0.1) buckets['-0.5..-0.1']++;
    else if (p < 0) buckets['-0.1..0']++;
    else if (p < 0.1) buckets['0..0.1']++;
    else if (p < 0.5) buckets['0.1..0.5']++;
    else buckets['>0.5']++;
  }
  return buckets;
}

function round(x, d = 4) {
  return Math.round(x * 10 ** d) / 10 ** d;
}
