import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFunding, evaluateCarry, minutesTo } from '../src/math.js';
import { marketHealthIssue, qualityIssue } from '../src/filters.js';

const DAY = 86_400_000;
const healthy = { symbol: 'SOL/USDT:USDT', base: 'SOL', swap: true, active: true, created: Date.now() - 400 * DAY, info: { deliveryTime: '0', status: 'Trading' } };
const hist = (n, mean) => ({ n, mean8h: mean, min8h: mean, max8h: mean, flips: 0, stddev: 0 });

test('summarizeFunding: média, extremos e mudanças de sinal', () => {
  const s = summarizeFunding([0.0001, 0.0002, -0.0001, 0.0003]);
  assert.equal(s.n, 4);
  assert.ok(Math.abs(s.mean8h - 0.000125) < 1e-12);
  assert.equal(s.min8h, -0.0001);
  assert.equal(s.max8h, 0.0003);
  assert.equal(s.flips, 2);
  assert.equal(summarizeFunding([]).n, 0);
});

test('evaluateCarry: funding positivo cobre 4 taxas e basis negativa conta como custo', () => {
  const ev = evaluateCarry({ rate8h: 0.0005, spotAsk: 100, perpBid: 99.95, spotFee: 0.001, perpFee: 0.00055, expectedHoldHours: 48 });
  assert.ok(Math.abs(ev.basisPct - -0.0005) < 1e-12);
  assert.ok(Math.abs(ev.basisCostPct - 0.0005) < 1e-12);
  assert.ok(Math.abs(ev.roundTripFeesPct - 0.0031) < 1e-12);
  assert.ok(Math.abs(ev.grossPct - 0.003) < 1e-12);
  assert.ok(ev.netPct < 0, 'em 48h ainda não paga as taxas + basis');
  assert.ok(ev.breakEvenHours > 48);
  const longer = evaluateCarry({ rate8h: 0.0005, spotAsk: 100, perpBid: 100.1, spotFee: 0.001, perpFee: 0.00055, expectedHoldHours: 168 });
  assert.equal(longer.basisCostPct, 0, 'perp acima do spot não é custo');
  assert.ok(longer.netPct > 0);
  assert.ok(longer.netAprPct > 0.1);
});

test('evaluateCarry: funding negativo nunca é oportunidade', () => {
  const ev = evaluateCarry({ rate8h: -0.0003, spotAsk: 100, perpBid: 100, spotFee: 0.001, perpFee: 0.0005 });
  assert.ok(ev.netPct < 0);
  assert.equal(ev.breakEvenHours, Infinity);
});

test('minutesTo: minutos até timestamp', () => {
  const now = 1_000_000;
  assert.equal(minutesTo(now + 30 * 60_000, now), 30);
  assert.equal(minutesTo(null, now), null);
});

test('marketHealthIssue: delisting, novo, inativo, blacklist', () => {
  assert.equal(marketHealthIssue(healthy, { blacklist: [] }), null);
  assert.match(marketHealthIssue({ ...healthy, info: { deliveryTime: String(Date.now() + 3 * DAY) } }, { blacklist: [] }), /delisting/);
  assert.match(marketHealthIssue({ ...healthy, created: Date.now() - 2 * DAY }, { minListingDays: 14, blacklist: [] }), /listado há/);
  assert.match(marketHealthIssue({ ...healthy, active: false }, { blacklist: [] }), /inativo/);
  assert.match(marketHealthIssue({ ...healthy, info: { status: 'SETTLING' } }, { blacklist: [] }), /estado/);
  assert.equal(marketHealthIssue(healthy, { blacklist: ['SOL'] }), 'blacklist');
  assert.equal(marketHealthIssue({ ...healthy, info: { status: 'TRADING', contractType: 'PERPETUAL' } }, { blacklist: [] }), null);
});

test('qualityIssue: volume, open interest, tamanho vs OI, histórico', () => {
  const base = { history: hist(6, 0.0005), oiUsd: 50e6, volumeUsd: 50e6, positionUsd: 100, minMean8h: 0.0001 };
  assert.equal(qualityIssue(base), null);
  assert.match(qualityIssue({ ...base, volumeUsd: 1e6 }), /volume/);
  assert.match(qualityIssue({ ...base, oiUsd: 1e6 }), /open interest/);
  assert.match(qualityIssue({ ...base, oiUsd: 3e6, positionUsd: 10_000 }), /% do open interest/);
  assert.match(qualityIssue({ ...base, history: hist(6, 0.00001) }), /média/);
  assert.match(qualityIssue({ ...base, history: { ...hist(6, 0.0005), flips: 3 } }), /sinal do funding mudou/);
  assert.match(qualityIssue({ ...base, history: hist(1, 0.0005) }), /histórico insuficiente/);
  assert.match(qualityIssue({ ...base, history: null }), /sem histórico/);
  assert.equal(qualityIssue({ oiUsd: 50e6, volumeUsd: 50e6, positionUsd: 100 }), null, 'sem history = não verificar histórico');
  assert.equal(qualityIssue({ oiUsd: null, volumeUsd: null, positionUsd: 100 }), null, 'dados em falta não bloqueiam liquidez');
});
