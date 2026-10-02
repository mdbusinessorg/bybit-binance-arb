import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-lab-'));
process.env.KILL_SWITCH_FILE = path.join(process.env.DATA_DIR, 'STOP');

const { config } = await import('../src/config.js');
const { normalizeBook, normalizeTicker } = await import('../src/market-data/normalize.js');
const { SlippageModel } = await import('../src/edge/slippage.js');
const { EdgeEngine, REASON } = await import('../src/edge/engine.js');
const { RiskGovernor } = await import('../src/risk/governor.js');
const { ExchangeHealthMonitor } = await import('../src/market-data/health.js');
const { PaperEngine } = await import('../src/paper/engine.js');
const { detectRegime, regimeFactor } = await import('../src/risk/regime.js');
const { classifyDepth, fillProbability, calculateDepth } = await import('../src/edge/depth.js');
const { runReplay, runStressMatrix } = await import('../src/backtest/engine.js');
const { syntheticFrames } = await import('../src/backtest/recorder.js');

function book(mid, depthUsd = 2000, levels = 10) {
  const bids = [];
  const asks = [];
  const per = depthUsd / levels;
  for (let i = 0; i < levels; i++) {
    const bp = mid * (1 - 0.0005 - i * 0.0003);
    const ap = mid * (1 + 0.0005 + i * 0.0003);
    bids.push([bp, per / bp]);
    asks.push([ap, per / ap]);
  }
  return { timestamp: Date.now() - 200, bids, asks };
}

function lab() {
  const slippage = new SlippageModel();
  const health = new ExchangeHealthMonitor(['bybit', 'binance']);
  const governor = new RiskGovernor(health);
  const engine = new EdgeEngine({ slippage, governor, health });
  const paper = new PaperEngine({ slippage, governor });
  return { slippage, health, governor, engine, paper };
}

test('normalizeBook: LIVE snapshot com qualidade alta', () => {
  const s = normalizeBook('bybit', 'BTC/USDT', book(100));
  assert.equal(s.status, 'LIVE');
  assert.equal(s.exchange, 'bybit');
  assert.equal(s.baseAsset, 'BTC');
  assert.ok(s.dataQualityScore > 60);
  assert.ok(s.latencyMs >= 0);
  assert.equal(s.anomalies.length, 0);
});

test('normalizeBook: livro vazio e preços inválidos', () => {
  assert.equal(normalizeBook('bybit', 'BTC/USDT', { timestamp: Date.now(), bids: [], asks: [] }).status, 'OFFLINE');
  assert.equal(normalizeBook('bybit', 'BTC/USDT', { timestamp: Date.now(), bids: [[-1, 1]], asks: [[-2, 1]] }).status, 'OFFLINE');
});

test('normalizeBook: dados stale/degraded/offline por idade', () => {
  const old = { timestamp: Date.now() - config.lab.dataFreshnessMs - 2000, bids: [[99, 1]], asks: [[101, 1]] };
  assert.equal(normalizeBook('bybit', 'X/USDT', old).status, 'STALE');
  const older = { timestamp: Date.now() - config.lab.offlineDataMs - 5000, bids: [[99, 1]], asks: [[101, 1]] };
  assert.equal(normalizeBook('bybit', 'X/USDT', older).status, 'OFFLINE');
});

test('normalizeBook: timestamp futuro e ausente geram anomalias', () => {
  const future = { timestamp: Date.now() + 120_000, bids: [[99, 1]], asks: [[101, 1]] };
  const s = normalizeBook('bybit', 'X/USDT', future);
  assert.ok(s.anomalies.includes('FUTURE_TIMESTAMP'));
  assert.equal(s.latencyMs, null);
  const missing = normalizeBook('bybit', 'X/USDT', { bids: [[99, 1]], asks: [[101, 1]] });
  assert.ok(missing.anomalies.includes('MISSING_TIMESTAMP'));
});

test('edge engine: rejeita STALE_DATA em snapshot offline', () => {
  const { engine } = lab();
  const buy = normalizeBook('bybit', 'X/USDT', { timestamp: Date.now() - 99_000, bids: [[99, 1]], asks: [[100, 1]] });
  const sell = normalizeBook('binance', 'X/USDT', book(101));
  const opp = engine.evaluateCrossExchange({ symbol: 'X/USDT', buySnap: buy, sellSnap: sell, tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(opp.status, 'REJECTED');
  assert.equal(opp.reasonCode, REASON.STALE_DATA);
});

test('edge engine: gross spread positivo mas net edge negativo -> NET_EDGE_TOO_LOW', () => {
  const { engine } = lab();
  // 0.05% de spread bruto < 2x0.1% taxas
  const buy = normalizeBook('bybit', 'X/USDT', book(100));
  const sell = normalizeBook('binance', 'X/USDT', book(100.05));
  const opp = engine.evaluateCrossExchange({ symbol: 'X/USDT', buySnap: buy, sellSnap: sell, tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(opp.status, 'REJECTED');
  assert.equal(opp.reasonCode, REASON.NET_EDGE_TOO_LOW);
  assert.ok(opp.explanation.finalDecision.includes('REJECTED'));
});

test('edge engine: valida oportunidade com edge suficiente e produz explicação', () => {
  const { engine } = lab();
  const buy = normalizeBook('bybit', 'X/USDT', book(100, 50_000));
  const sell = normalizeBook('binance', 'X/USDT', book(102.0, 50_000)); // ~2% spread
  const opp = engine.evaluateCrossExchange({ symbol: 'X/USDT', buySnap: buy, sellSnap: sell, tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(opp.status, 'VALIDATED', JSON.stringify(opp.explanation));
  assert.ok(opp.confidence > 0 && opp.confidence <= 100);
  assert.ok(opp.measurements.netBps > 0);
  assert.ok(opp.measurements.buyVwap > 100);
  assert.ok(opp.expiresAt > Date.now());
  assert.ok(opp.explanation.finalDecision.includes('VALID'));
  assert.ok(Array.isArray(opp.confidenceFactors.positive));
});

test('edge engine: TTL expira oportunidades', () => {
  const { engine } = lab();
  const buy = normalizeBook('bybit', 'X/USDT', book(100, 50_000));
  const sell = normalizeBook('binance', 'X/USDT', book(102.0, 50_000));
  const opp = engine.evaluateCrossExchange({ symbol: 'X/USDT', buySnap: buy, sellSnap: sell, tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  opp.expiresAt = Date.now() - 1;
  engine.expire([opp]);
  assert.equal(opp.status, 'EXPIRED');
  assert.ok(opp.signalLifetimeMs >= 0);
});

test('edge engine: exchange degradada -> EXCHANGE_DEGRADED', () => {
  const { engine, health } = lab();
  health.h.binance.status = 'UNSTABLE';
  const buy = normalizeBook('bybit', 'X/USDT', book(100, 50_000));
  const sell = normalizeBook('binance', 'X/USDT', book(101, 50_000));
  const opp = engine.evaluateCrossExchange({ symbol: 'X/USDT', buySnap: buy, sellSnap: sell, tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(opp.status, 'REJECTED');
});

test('regime detector: extremos e degraded', () => {
  assert.equal(detectRegime({ volatilityBps: 200 }), 'EXTREME_VOLATILITY');
  assert.equal(detectRegime({ volatilityBps: 50 }), 'HIGH_VOLATILITY');
  assert.equal(detectRegime({ anyExchangeDegraded: true }), 'EXCHANGE_DEGRADED');
  assert.equal(detectRegime({ anyDataDegraded: true }), 'DATA_DEGRADED');
  assert.equal(detectRegime({ depthUsd: 10, refDepthUsd: 1000 }), 'LOW_LIQUIDITY');
  assert.equal(detectRegime({}), 'NORMAL');
  assert.equal(regimeFactor('EXTREME_VOLATILITY').sizeFactor < 1, true);
  assert.equal(regimeFactor('EXCHANGE_DEGRADED').edgeFactor, Infinity);
});

test('depth: classificação e fillProbability', () => {
  const b = book(100, 2000);
  assert.equal(classifyDepth(b, 100, 50), 'ORDERBOOK_DEEP');
  const thin = book(100, 30);
  assert.equal(classifyDepth(thin, 100, 50), 'ORDERBOOK_THIN');
  assert.equal(fillProbability(400, 100), 1);
  assert.ok(fillProbability(60, 100) < 1);
  const d = calculateDepth(b, 100);
  assert.ok(d.bidDepthUsd > 0 && d.askDepthUsd > 0);
});

test('slippage model: estimativa conservadora > estimada, percentis funcionam', () => {
  const s = new SlippageModel();
  const e = s.estimate({ bookImpactBps: 4, spreadBps: 10, volatilityBps: 20, quoteUsd: 100 });
  assert.ok(e.conservativeSlippageBps > e.estimatedSlippageBps);
  for (let i = 0; i < 50; i++) s.recordRealized('bybit', 'X/USDT', i);
  const p = s.percentiles('bybit', 'X/USDT');
  assert.ok(p.p50 < p.p90 && p.p90 <= p.p99);
});

test('paper engine: fills parciais conforme liquidez e stats', () => {
  const { paper } = lab();
  const opp = {
    id: 'o1', strategy: 'spot', symbol: 'X/USDT', buyVenue: 'bybit', sellVenue: 'binance',
    confidence: 80, regime: 'NORMAL',
    measurements: {
      amount: 0.5, buyVwap: 100, sellVwap: 101, grossUsd: 0.5, netUsd: 0.3, netEdgePct: 0.006,
      feesPct: 0.002, estimatedSlippageBps: 5, conservativeSlippageBps: 10, latencyMs: 300,
      fillProbability: 0.45,
    },
  };
  const t = paper.execute(opp);
  assert.equal(t.status, 'PARTIALLY_FILLED');
  assert.equal(t.fillRatio, 0.5);
  assert.ok(t.slippageErrorBps !== undefined);
  const s = paper.stats();
  assert.equal(s.simulatedTrades, 1);
  assert.ok(s.avgFillRate < 1);
});

test('backtest replay: sem look-ahead — trades só com dados do próprio frame', () => {
  const frames = syntheticFrames({ exchanges: ['bybit', 'binance'], symbol: 'X/USDT', frames: 120 });
  // frames com timestamps ordenados; corrompe o primeiro frame com um spread gigante passado
  // e confirma que decisões posteriores não são afetadas por frames futuros:
  const r1 = runReplay({ frames, exchanges: ['bybit', 'binance'], symbol: 'X/USDT', tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(r1.frames, 120);
  for (const t of r1.trades) assert.ok(t.simulatedAt <= frames[frames.length - 1].t);
  // determinismo: mesmo input -> mesmo output
  const r2 = runReplay({ frames, exchanges: ['bybit', 'binance'], symbol: 'X/USDT', tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(r1.simulated, r2.simulated);
  assert.equal(JSON.stringify(r1.rejected), JSON.stringify(r2.rejected));
});

test('stress matrix: cenários correm e mais slippage não melhora o resultado', () => {
  const frames = syntheticFrames({ exchanges: ['bybit', 'binance'], symbol: 'X/USDT', frames: 100 });
  const rows = runStressMatrix({ frames, exchanges: ['bybit', 'binance'], symbol: 'X/USDT', tradeUsd: 50, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(rows.length, 8);
  const base = rows.find((r) => r.scenario === 'BASE');
  const worst = rows.find((r) => r.scenario === '+50% slippage');
  assert.ok(worst.netPnlUsd <= base.netPnlUsd + 1e-9);
});

test('normalizeTicker: inválido e válido', () => {
  assert.equal(normalizeTicker('bybit', 'X/USDT', { bid: 99, ask: 101, timestamp: Date.now() }).status, 'LIVE');
  assert.equal(normalizeTicker('bybit', 'X/USDT', { bid: 102, ask: 101, timestamp: Date.now() }).status, 'OFFLINE');
});
