import { SlippageModel } from './edge/slippage.js';
import { ExchangeHealthMonitor } from './market-data/health.js';
import { RiskGovernor } from './risk/governor.js';
import { EdgeEngine } from './edge/engine.js';
import { PaperEngine } from './paper/engine.js';
import { EXCHANGE_IDS } from './exchanges.js';

/**
 * Instâncias partilhadas do laboratório — uma por processo.
 * DATA -> EDGE -> RISK -> SIMULATION -> ANALYTICS.
 */
export const slippage = new SlippageModel();
export const health = new ExchangeHealthMonitor(EXCHANGE_IDS);
export const governor = new RiskGovernor(health);
export const edge = new EdgeEngine({ slippage, governor, health });
export const paper = new PaperEngine({ slippage, governor });

/** Instância da estratégia day-trade (definida em index.js quando ativa). */
export const daytrade = { instance: null };

/** Instância da estratégia spot (definida em index.js; usada p/ balances e execução manual). */
export const spot = { instance: null };

/**
 * Fila de aprovação manual (MANUAL_APPROVAL=true): oportunidades VALIDATED
 * ficam pendentes até o utilizador executar/rejeitar no painel.
 * Cada entrada: { opp, execute, createdAt } — execute() corre o caminho
 * live/paper normal da estratégia.
 */
export const approvals = {
  list: [],
  add(opp, execute) {
    this.list.push({ opp, execute, createdAt: Date.now() });
    if (this.list.length > 50) this.list.splice(0, this.list.length - 50);
  },
  get(id) {
    return this.list.find((a) => a.opp.id === id);
  },
  remove(id) {
    const i = this.list.findIndex((a) => a.opp.id === id);
    if (i >= 0) this.list.splice(i, 1);
  },
  expire() {
    const now = Date.now();
    for (const a of [...this.list]) {
      if (now > a.opp.expiresAt) {
        a.opp.status = 'EXPIRED';
        a.opp.signalLifetimeMs = now - a.opp.detectedAt;
        this.remove(a.opp.id);
      }
    }
  },
  snapshot() {
    this.expire();
    return this.list.map((a) => ({
      id: a.opp.id,
      symbol: a.opp.symbol,
      dir: `${a.opp.buyVenue}->${a.opp.sellVenue}`,
      status: a.opp.status,
      confidence: a.opp.confidence,
      detectedAt: a.opp.detectedAt,
      expiresAt: a.opp.expiresAt,
      measurements: a.opp.measurements,
      explanation: a.opp.explanation,
    }));
  },
};
