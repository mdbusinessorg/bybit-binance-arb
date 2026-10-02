import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTriangleRoute } from '../src/math.js';

const FEE = 0.001;

// X cotado a 100 USDT; BTC a 100_000 USDT; X/BTC "justo" seria 0.001.
const X_USDT = { symbol: 'X/USDT', asks: [[100, 10]], bids: [[100, 10]] };
const BTC_USDT = { symbol: 'BTC/USDT', asks: [[100_000, 1]], bids: [[100_000, 1]] };

test('triangular fwd: X/BTC acima do justo gera lucro líquido', () => {
  const ev = evaluateTriangleRoute({
    startUsd: 100,
    feeTaker: FEE,
    slippageBuffer: 0,
    legs: [
      { ...X_USDT, side: 'buy' },
      { symbol: 'X/BTC', side: 'sell', bids: [[0.0011, 10]] }, // 10% acima do justo
      { ...BTC_USDT, side: 'sell' },
    ],
  });
  assert.ok(ev.ok);
  // 1 X comprado por 100 -> vendido por 0.0011 BTC -> vendido por ~110 USDT (menos 3 taxas)
  assert.ok(ev.outUsd > 109.5 && ev.outUsd < 110.1, `outUsd=${ev.outUsd}`);
  assert.ok(ev.net > 0);
  assert.equal(ev.legs.length, 3);
});

test('triangular rev: X/USDT abaixo do justo gera lucro', () => {
  const ev = evaluateTriangleRoute({
    startUsd: 100,
    feeTaker: FEE,
    slippageBuffer: 0,
    legs: [
      { ...BTC_USDT, side: 'buy' },
      { symbol: 'X/BTC', side: 'buy', asks: [[0.0009, 10]] }, // X mais barato em BTC
      { ...X_USDT, side: 'sell' },
    ],
  });
  assert.ok(ev.ok);
  assert.ok(ev.outUsd > 110.5, `outUsd=${ev.outUsd}`);
  assert.ok(ev.net > 0);
});

test('triangular: preços justos dão líquido negativo (3 taxas)', () => {
  const ev = evaluateTriangleRoute({
    startUsd: 100,
    feeTaker: FEE,
    legs: [
      { ...X_USDT, side: 'buy' },
      { symbol: 'X/BTC', side: 'sell', bids: [[0.001, 10]] },
      { ...BTC_USDT, side: 'sell' },
    ],
  });
  assert.ok(ev.ok);
  assert.ok(ev.net < 0, 'sem distorção, as taxas comem o retorno');
  assert.ok(Math.abs(ev.netPct + 0.003) < 0.0005);
});

test('triangular: liquidez insuficiente numa perna é sinalizada', () => {
  const ev = evaluateTriangleRoute({
    startUsd: 100,
    feeTaker: FEE,
    legs: [
      { ...X_USDT, side: 'buy' },
      { symbol: 'X/BTC', side: 'sell', bids: [[0.001, 0.1]] }, // só 0.1 X de liquidez
      { ...BTC_USDT, side: 'sell' },
    ],
  });
  assert.equal(ev.ok, false);
});
