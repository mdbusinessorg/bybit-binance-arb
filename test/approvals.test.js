import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvals } from '../src/lab.js';

const opp = (id, expiresAt = Date.now() + 5000) => ({
  id, symbol: 'BTC/USDT', buyVenue: 'bybit', sellVenue: 'binance',
  status: 'PENDING_APPROVAL', confidence: 80, detectedAt: Date.now(), expiresAt,
  measurements: { netUsd: 1.2, netBps: 12 },
  explanation: { finalDecision: 'VALID' },
});

test('approvals: add/get/remove e snapshot', () => {
  approvals.list.length = 0;
  let ran = 0;
  const o = opp('t1');
  approvals.add(o, () => ran++);
  assert.equal(approvals.get('t1').opp.symbol, 'BTC/USDT');
  const snap = approvals.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].dir, 'bybit->binance');
  assert.equal(snap[0].measurements.netUsd, 1.2);
  approvals.get('t1').execute();
  assert.equal(ran, 1);
  approvals.remove('t1');
  assert.equal(approvals.get('t1'), undefined);
});

test('approvals: expire remove pendentes fora do TTL', () => {
  approvals.list.length = 0;
  approvals.add(opp('old', Date.now() - 1), () => {});
  approvals.add(opp('new'), () => {});
  approvals.expire();
  assert.equal(approvals.get('old'), undefined);
  assert.ok(approvals.get('new'));
  approvals.list.length = 0;
});

test('approvals: cap de 50 entradas', () => {
  approvals.list.length = 0;
  for (let i = 0; i < 60; i++) approvals.add(opp('o' + i), () => {});
  assert.equal(approvals.list.length, 50);
  approvals.list.length = 0;
});
