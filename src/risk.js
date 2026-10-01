import fs from 'node:fs';
import { config } from './config.js';
import { state, save } from './state.js';
import { createLogger } from './logger.js';
import { notify } from './notify.js';

const log = createLogger('risk');

/**
 * Circuit breakers. Devolve null se pode negociar, ou uma string com o motivo do bloqueio.
 */
export function tradingBlockedReason() {
  if (fs.existsSync(config.risk.killSwitchFile)) return `kill switch (ficheiro ${config.risk.killSwitchFile} existe)`;
  if (state.halted) return `robô parado: ${state.haltReason}`;
  if (state.dailyPnlUsd <= -Math.abs(config.risk.maxDailyLossUsd)) {
    halt('daily-loss', `perda diária ${state.dailyPnlUsd.toFixed(2)} USD atingiu o limite ${config.risk.maxDailyLossUsd} USD`);
    return `limite de perda diária atingido`;
  }
  if (state.consecutiveFailures >= config.risk.maxConsecutiveFailures) {
    halt('failures', `${state.consecutiveFailures} falhas consecutivas de execução`);
    return `falhas consecutivas`;
  }
  const recent = state.recentTradeTimestamps.filter((t) => Date.now() - t < 3600_000);
  if (recent.length >= config.risk.maxTradesPerHour) return `limite de ${config.risk.maxTradesPerHour} trades/hora`;
  return null;
}

export function openNotionalUsd() {
  const all = [...Object.values(state.fundingPositions), ...Object.values(state.carryPositions || {})];
  return all.reduce((acc, p) => acc + (p.notionalUsd || 0), 0);
}

export function canOpenNotional(extraUsd) {
  return openNotionalUsd() + extraUsd <= config.risk.maxOpenNotionalUsd;
}

export function halt(reason, detail) {
  if (state.halted) return;
  state.halted = true;
  state.haltReason = reason;
  save();
  log.error(`ROBÔ PARADO (${reason}): ${detail}`);
  notify(`🛑 ROBÔ PARADO (${reason})\n${detail}\n\nPara retomar: apaga o ficheiro STOP (se existir) e corre \`npm run status -- --resume\`.`);
}

export function recordFailure(err) {
  state.consecutiveFailures += 1;
  save();
  log.warn(`falha de execução #${state.consecutiveFailures}: ${err?.message || err}`);
}

export function recordSuccess() {
  if (state.consecutiveFailures !== 0) {
    state.consecutiveFailures = 0;
    save();
  }
}

export function isStale(timestamp) {
  if (!timestamp) return false;
  return Date.now() - timestamp > config.risk.staleDataMs;
}
