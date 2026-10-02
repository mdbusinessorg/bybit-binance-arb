import test from 'node:test';
import assert from 'node:assert/strict';
import { rsiScore, elderScore, macdScore, bollingerScore, momentumScore, candleScore, orderBookScore, ema } from '../src/daytrade/indicators.js';
import { analyze, BOOKS } from '../src/daytrade/megabrain.js';

const mkCandles = (closes, v = 100) => closes.map((c, i) => ({ t: i * 60_000, o: closes[Math.max(0, i - 1)], h: c * 1.001, l: c * 0.999, c, v }));

test('ema: primeira parte igual ao valor inicial e converge', () => {
  const e = ema([10, 10, 10, 12, 12, 12], 3);
  assert.equal(e[0], 10);
  assert.ok(e.at(-1) > e[0]);
});

test('rsiScore: tendência de queda forte -> positivo (oversold)', () => {
  const down = mkCandles(Array.from({ length: 30 }, (_, i) => 100 - i));
  assert.ok(rsiScore(down) > 0.5);
  const up = mkCandles(Array.from({ length: 30 }, (_, i) => 100 + i));
  assert.ok(rsiScore(up) < -0.5);
});

test('elderScore e macdScore: sobem com uptrend sustentado', () => {
  const up = mkCandles(Array.from({ length: 60 }, (_, i) => 100 + i * 0.5));
  assert.ok(elderScore(up) > 0);
  assert.ok(macdScore(up) >= 0);
});

test('bollingerScore: fecho acima da banda superior -> negativo', () => {
  const flat = Array.from({ length: 20 }, () => 100);
  flat.push(110); // pico para fora da banda
  assert.ok(bollingerScore(mkCandles(flat)) < 0);
});

test('momentumScore e candleScore respondem à direção', () => {
  const up = mkCandles(Array.from({ length: 25 }, (_, i) => 100 + i), 200);
  assert.ok(momentumScore(up) > 0);
  assert.ok(candleScore(up) > 0);
});

test('orderBookScore: imbalance de bids -> positivo', () => {
  const ob = { bids: [[100, 10], [99, 10]], asks: [[101, 1], [102, 1]] };
  assert.ok(orderBookScore(ob) > 0.5);
  assert.equal(orderBookScore(null), 0);
});

test('megabrain: uptrend forte dá CALL com score positivo e partes preenchidas', () => {
  const candles = mkCandles(Array.from({ length: 60 }, (_, i) => 100 + i * 0.4), 150);
  const r = analyze({ candles, orderBook: { bids: [[100, 5]], asks: [[101, 5]] } });
  assert.equal(r.direction, 'CALL');
  assert.ok(r.score > 0);
  assert.equal(r.parts.length, BOOKS.length);
  assert.ok(r.agreement > 0.5);
  for (const p of r.parts) assert.ok(p.score >= -1 && p.score <= 1);
});

test('megabrain: candles insuficientes não rebenta', () => {
  const r = analyze({ candles: mkCandles([100, 101]), orderBook: null });
  assert.ok(Math.abs(r.score) <= 1);
});
