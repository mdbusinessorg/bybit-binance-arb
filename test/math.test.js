import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vwapForAmount, vwapForQuote, evaluateSpotArb, evaluateFundingArb, normalizeFundingTo8h } from '../src/math.js';

test('vwapForAmount consome vários níveis', () => {
  const r = vwapForAmount([[100, 1], [101, 1], [102, 5]], 2.5);
  assert.equal(r.filled, 2.5);
  assert.ok(Math.abs(r.cost - (100 + 101 + 0.5 * 102)) < 1e-9);
  assert.ok(Math.abs(r.avgPrice - r.cost / 2.5) < 1e-9);
});

test('vwapForAmount devolve filled parcial se faltar liquidez', () => {
  const r = vwapForAmount([[100, 1]], 3);
  assert.equal(r.filled, 1);
});

test('vwapForQuote gasta exatamente o quote', () => {
  const r = vwapForQuote([[100, 0.3], [110, 10]], 50);
  assert.ok(Math.abs(r.cost - 50) < 1e-9);
  assert.ok(Math.abs(r.filled - (0.3 + 20 / 110)) < 1e-9);
});

test('spot arb: spread abaixo das taxas dá líquido negativo', () => {
  const ev = evaluateSpotArb({
    buyAsks: [[100, 10]],
    sellBids: [[100.1, 10]],
    tradeUsd: 100,
    buyFee: 0.001,
    sellFee: 0.001,
  });
  assert.ok(ev.ok);
  assert.ok(Math.abs(ev.grossPct - 0.001) < 1e-9);
  assert.ok(ev.net < 0, 'spread de 0.1% não cobre 0.2% de taxas');
});

test('spot arb: spread de 0.5% com taxas 0.2% e buffer 0.03% dá ~0.27% líquido', () => {
  const ev = evaluateSpotArb({
    buyAsks: [[100, 10]],
    sellBids: [[100.5, 10]],
    tradeUsd: 100,
    buyFee: 0.001,
    sellFee: 0.001,
    slippageBuffer: 0.0003,
  });
  assert.ok(ev.ok);
  // gross 0.5 - fees (0.1 + 0.1005) - buffer 0.03 = 0.2695
  assert.ok(Math.abs(ev.net - 0.2695) < 1e-6, `net=${ev.net}`);
  assert.ok(Math.abs(ev.netPct - 0.002695) < 1e-8);
});

test('spot arb: profundidade insuficiente no lado da venda é sinalizada', () => {
  const ev = evaluateSpotArb({ buyAsks: [[100, 10]], sellBids: [[101, 0.1]], tradeUsd: 100, buyFee: 0.001, sellFee: 0.001 });
  assert.equal(ev.ok, false);
});

test('normalizeFundingTo8h', () => {
  assert.equal(normalizeFundingTo8h(0.0001, 4), 0.0002);
  assert.equal(normalizeFundingTo8h(0.0001, 8), 0.0001);
  assert.equal(normalizeFundingTo8h(0.0001, 1), 0.0008);
});

test('funding arb: escolhe short onde o funding é maior e calcula break-even', () => {
  const ev = evaluateFundingArb({
    rateA8h: 0.0005, // Bybit paga 0.05%/8h aos shorts
    rateB8h: 0.0001,
    priceA: 100,
    priceB: 100,
    feeA: 0.00055,
    feeB: 0.0005,
    expectedHoldHours: 24,
  });
  assert.equal(ev.shortOn, 'A');
  assert.equal(ev.longOn, 'B');
  assert.ok(Math.abs(ev.spread8h - 0.0004) < 1e-12);
  // taxas: 2*0.055% + 2*0.05% = 0.21% ; spread 0.04%/8h -> 42h para break-even
  assert.ok(Math.abs(ev.roundTripFeesPct - 0.0021) < 1e-12);
  assert.ok(Math.abs(ev.breakEvenHours - 42) < 1e-6, `breakEven=${ev.breakEvenHours}`);
  // em 24h ainda não cobre as taxas -> líquido negativo
  assert.ok(ev.netPct < 0);
});

test('funding arb: basis desfavorável (long mais caro) reduz o líquido', () => {
  const base = { rateA8h: 0.001, rateB8h: 0, feeA: 0.0002, feeB: 0.0002, expectedHoldHours: 48 };
  const flat = evaluateFundingArb({ ...base, priceA: 100, priceB: 100 });
  const bad = evaluateFundingArb({ ...base, priceA: 100, priceB: 100.2 }); // long em B (mais caro)
  assert.ok(bad.netPct < flat.netPct);
  assert.ok(Math.abs(bad.basisPct - 0.002) < 1e-9);
});
