import { config } from '../config.js';
import { tradingBlockedReason } from '../risk.js';
import { emit } from '../events.js';
import { createLogger } from '../logger.js';

const log = createLogger('governor');

/**
 * RiskGovernor — camada central que controla o sistema inteiro.
 * Limites: MAX_SIMULTANEOUS_SIMULATIONS, MAX_POSITION_SIZE,
 * MAX_DAILY_SIMULATED_LOSS, MAX_CONSECUTIVE_FAILURES, MAX_DATA_AGE,
 * MAX_SLIPPAGE, MAX_LATENCY, MAX_EXCHANGE_ERRORS.
 * Em condição crítica entra SAFE_MODE até recuperação.
 */
export class RiskGovernor {
  constructor(health) {
    this.health = health;
    this.safeMode = false;
    this.safeReason = null;
    this.activeSimulations = 0;
    this.simulatedDailyLoss = 0;
    this.simDay = new Date().toISOString().slice(0, 10);
  }

  rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.simDay) {
      this.simDay = today;
      this.simulatedDailyLoss = 0;
    }
  }

  enterSafe(reason) {
    if (!this.safeMode) {
      this.safeMode = true;
      this.safeReason = reason;
      log.error(`SAFE_MODE ativado: ${reason}`);
      emit('risk_event', 'governor', { kind: 'SAFE_MODE_ON', reason });
    }
  }

  exitSafe() {
    if (this.safeMode) {
      log.warn(`SAFE_MODE desativado (era: ${this.safeReason})`);
      emit('risk_event', 'governor', { kind: 'SAFE_MODE_OFF', reason: this.safeReason });
    }
    this.safeMode = false;
    this.safeReason = null;
  }

  recordSimulatedLoss(usd) {
    this.rollDay();
    if (usd < 0) this.simulatedDailyLoss += -usd;
    if (this.simulatedDailyLoss >= config.lab.maxDailySimulatedLossUsd) {
      this.enterSafe(`perda simulada diária ${this.simulatedDailyLoss.toFixed(2)} >= ${config.lab.maxDailySimulatedLossUsd}`);
    }
  }

  /**
   * Veredicto global antes de considerar uma oportunidade.
   * Devolve null se ok, ou { reason, code }.
   */
  gate({ exchangeIds = [], maxDataAgeMs = 0, estSlippageBps = 0, latencyMs = 0 }) {
    this.rollDay();
    const r = config.lab;
    const blocked = tradingBlockedReason();
    if (blocked) return { reason: blocked, code: 'RISK_LIMIT' };
    if (this.safeMode) {
      // recuperação automática quando tudo volta a HEALTHY
      const healthyNow = exchangeIds.every((id) => this.health.ok(id));
      if (healthyNow && this.simulatedDailyLoss < r.maxDailySimulatedLossUsd) this.exitSafe();
      else return { reason: `SAFE_MODE: ${this.safeReason}`, code: 'RISK_LIMIT' };
    }
    if (this.activeSimulations >= r.maxSimultaneousSimulations) {
      return { reason: `limite de ${r.maxSimultaneousSimulations} simulações em paralelo`, code: 'RISK_LIMIT' };
    }
    for (const id of exchangeIds) {
      if (!this.health.ok(id)) return { reason: `exchange ${id} degradada/offline`, code: 'EXCHANGE_DEGRADED' };
    }
    if (maxDataAgeMs > r.maxDataAgeMs) return { reason: `dados demasiado antigos (${maxDataAgeMs}ms > ${r.maxDataAgeMs}ms)`, code: 'STALE_DATA' };
    if (estSlippageBps > r.maxSlippageBps) return { reason: `slippage estimado ${estSlippageBps}bps > ${r.maxSlippageBps}bps`, code: 'HIGH_SLIPPAGE' };
    if (latencyMs > r.maxLatencyMs) return { reason: `latência ${latencyMs}ms > ${r.maxLatencyMs}ms`, code: 'HIGH_LATENCY' };
    return null;
  }
}
