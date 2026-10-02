import { config } from '../config.js';
import { runReplay, runStressMatrix, walkForward } from './engine.js';
import { loadFrames, syntheticFrames } from './recorder.js';
import { pct, usd } from '../math.js';

/**
 * CLI de backtest / replay / stress test.
 * Uso:
 *   npm run backtest                          -> replay dos frames gravados (ou sintéticos)
 *   npm run backtest -- --synthetic           -> frames sintéticos
 *   npm run backtest -- --file data/frames-X.jsonl
 *   npm run backtest -- --stress              -> matriz de stress
 *   npm run backtest -- --walkforward         -> walk-forward por janelas
 *   npm run backtest -- --symbol BTC/USDT --frames 800
 */
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const symbol = argVal('--symbol', 'BTC/USDT');
const exchanges = config.exchanges;
const buyFee = config[exchanges[0]].spotTaker;
const sellFee = config[exchanges[1]].spotTaker;

let frames;
if (has('--synthetic') || (!has('--file') && loadFrames().length === 0)) {
  const n = Number(argVal('--frames', 800));
  console.log(`a gerar ${n} frames sintéticos para ${symbol} em ${exchanges.join(', ')}...`);
  frames = syntheticFrames({ exchanges, symbol, frames: n });
} else {
  frames = loadFrames(has('--file') ? argVal('--file') : null);
  console.log(`${frames.length} frames carregados`);
}
if (!frames.length) {
  console.error('sem frames — grava dados com RECORD_MARKET_DATA=true ou usa --synthetic');
  process.exit(1);
}

const base = { exchanges, symbol, tradeUsd: config.spot.tradeUsd, buyFee, sellFee, maxSpreadPct: config.spot.maxSpreadPct };

if (has('--stress')) {
  console.log('\n=== STRESS MATRIX ===');
  const rows = runStressMatrix({ ...base, frames });
  console.table(rows);
} else if (has('--walkforward')) {
  console.log('\n=== WALK-FORWARD ===');
  const rows = walkForward({ ...base, frames, windowSize: Math.floor(frames.length / 4), step: Math.floor(frames.length / 8) });
  console.table(rows);
} else {
  console.log('\n=== REPLAY ===');
  const r = runReplay({ ...base, frames });
  console.log(`frames processados: ${r.frames}`);
  console.log(`sinais simulados:   ${r.simulated}`);
  console.log(`rejeitados:       ${Object.values(r.rejected).reduce((a, b) => a + b, 0)} ${JSON.stringify(r.rejected)}`);
  console.log(`expirados (TTL):  ${r.expired}`);
  console.log(`false opportunity rate: ${r.falseOpportunityRate === null ? 'n/a' : pct(r.falseOpportunityRate, 1)}`);
  const s = r.paperStats;
  console.log(`net P&L: ${usd(s.netPnlUsd, 3)} | win rate: ${s.winRate === null ? 'n/a' : pct(s.winRate, 1)} | profit factor: ${s.profitFactor ?? 'n/a'} | max DD: ${usd(s.maxDrawdownUsd, 3)}`);
  console.log(`avg slippage: ${s.avgSlippageBps ?? 'n/a'}bps | avg latência: ${s.avgLatencyMs ?? 'n/a'}ms | avg fill: ${s.avgFillRate ?? 'n/a'}`);
  if (r.trades.length) {
    console.log('\núltimos trades simulados:');
    for (const t of r.trades.slice(-10)) {
      console.log(`  ${t.simulatedAt ? new Date(t.simulatedAt).toISOString().slice(11, 19) : t.timestamp} ${t.symbol} ${t.exchangeA}->${t.exchangeB} ${t.status} fill=${(t.fillRatio * 100).toFixed(0)}% net=${usd(t.netPnL, 3)}`);
    }
  }
}
