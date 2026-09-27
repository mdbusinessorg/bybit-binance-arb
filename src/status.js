/**
 * Estado do robô e histórico de trades.
 *   npm run status
 *   npm run status -- --resume   (retomar após paragem por circuit breaker)
 *   npm run status -- --reset    (apagar estado — NÃO apaga posições reais nas exchanges)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, modeLabel } from './config.js';
import { state, save, resetState } from './state.js';
import { usd, pct } from './math.js';

const args = process.argv.slice(2);

if (args.includes('--reset')) {
  resetState();
  console.log('estado apagado.');
}
if (args.includes('--resume')) {
  state.halted = false;
  state.haltReason = null;
  state.consecutiveFailures = 0;
  save();
  if (fs.existsSync(config.risk.killSwitchFile)) fs.unlinkSync(config.risk.killSwitchFile);
  console.log('robô retomado (circuit breakers limpos).');
}

console.log(`modo: ${modeLabel()}`);
console.log(`iniciado: ${state.startedAt}`);
console.log(`P&L hoje: ${usd(state.dailyPnlUsd, 3)} | total: ${usd(state.totalPnlUsd, 3)}`);
console.log(`trades spot: ${state.spotTrades} | funding: ${state.fundingTrades} | oportunidades avaliadas: ${state.opportunitiesSeen}`);
console.log(`parado: ${state.halted ? `SIM (${state.haltReason})` : 'não'} | falhas consecutivas: ${state.consecutiveFailures}`);

const positions = Object.values(state.fundingPositions);
if (positions.length) {
  console.log('\nposições funding abertas:');
  for (const p of positions) {
    const h = (Date.now() - p.openedAt) / 3600_000;
    console.log(
      `  ${p.symbol}: long ${p.longId} @${p.entryLong} / short ${p.shortId} @${p.entryShort} | ${p.contracts} contratos (${usd(p.notionalUsd)}) | ` +
        `${h.toFixed(1)}h | spread entrada ${pct(p.entrySpread8h, 4)} | funding acumulado ${usd(p.fundingAccruedUsd, 3)}`,
    );
  }
}

const tradesFile = path.join(config.dataDir, config.simulate ? 'trades.sim.jsonl' : 'trades.jsonl');
if (fs.existsSync(tradesFile)) {
  const lines = fs.readFileSync(tradesFile, 'utf8').trim().split('\n').filter(Boolean);
  const trades = lines.map((l) => JSON.parse(l));
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  console.log(`\núltimos trades (${trades.length} total, ${wins} positivos, ${trades.length - wins} negativos):`);
  for (const t of trades.slice(-15)) {
    console.log(`  ${t.ts.slice(0, 19)} [${t.mode}] ${t.strategy.padEnd(7)} ${t.symbol.padEnd(16)} P&L ${usd(t.pnlUsd, 3).padStart(9)} ${t.ok ? '' : '⚠️'}${t.reason ? ` (${t.reason})` : ''}`);
  }
}
