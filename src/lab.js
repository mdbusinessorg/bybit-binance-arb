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
