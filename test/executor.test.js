import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// DATA_DIR isolado antes de importar os módulos (config/state leem env no import)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-test-'));
process.env.DATA_DIR = tmp;
process.env.KILL_SWITCH_FILE = path.join(tmp, 'STOP');

const { config } = await import('../src/config.js');
const { executeSpotArb, executeTriangularArb } = await import('../src/executor.js');
const { state } = await import('../src/state.js');

function fakeEx(id, createOrderImpl) {
  const orders = new Map();
  let seq = 0;
  return {
    id,
    label: id,
    canTrade: true,
    fees_: { spotMaker: 0.001, spotTaker: 0.001, swapMaker: 0.0002, swapTaker: 0.0005 },
    market: (s) => ({ symbol: s, base: s.split('/')[0], quote: s.split('/')[1], spot: true }),
    amountToPrecision: (s, a) => Number(a).toFixed(6),
    priceToPrecision: (s, p) => Number(p).toFixed(6),
    fetchOrder: async (oid) => orders.get(oid),
    createOrder: async (symbol, type, side, amount, price, params = {}) => {
      const o = createOrderImpl({ symbol, type, side, amount, price, params });
      const order = { id: `${id}-${++seq}`, status: 'closed', ...o };
      orders.set(order.id, order);
      return order;
    },
  };
}

const filledOrder = ({ symbol, type, side, amount, price }, px) => ({
  symbol, type, side, amount, price, filled: amount, remaining: 0,
  cost: amount * (price ?? px), average: price ?? px,
  fee: { cost: amount * (price ?? px) * 0.001, currency: 'USDT' },
});

before(() => {
  config.live = true; // exercitar os caminhos de execução real com exchanges falsas
});

test('spot arb live: pernas equilibradas -> ok e pnl positivo', async () => {
  const buy = fakeEx('a', (o) => filledOrder(o, 100));
  const sell = fakeEx('b', (o) => filledOrder(o, 101));
  const r = await executeSpotArb({
    buyEx: buy, sellEx: sell, symbol: 'X/USDT', amount: 1,
    buyLimit: 100.1, sellLimit: 100.9, evaluation: {},
  });
  assert.equal(r.ok, true);
  // ordens executam ao preço-limite: 100.9 - 100.1 - taxas ≈ 0.599
  assert.ok(r.pnlUsd > 0.4 && r.pnlUsd < 0.9, `pnl=${r.pnlUsd}`);
});

test('spot arb live: venda falha -> desfaz excesso comprado a mercado', async () => {
  const calls = [];
  const buy = fakeEx('a', (o) => {
    calls.push(['a', o]);
    return filledOrder(o, 100);
  });
  const sell = fakeEx('b', () => {
    throw new Error('insufficient balance');
  });
  const r = await executeSpotArb({
    buyEx: buy, sellEx: sell, symbol: 'X/USDT', amount: 1,
    buyLimit: 100.1, sellLimit: 100.9, evaluation: {},
  });
  assert.equal(r.ok, true); // o unwind vendeu o excesso na exchange de compra
  const marketSell = calls.find(([, o]) => o.type === 'market' && o.side === 'sell');
  assert.ok(marketSell, 'devia ter vendido o excesso a mercado na exchange A');
  assert.equal(r.detail.unwinds.length, 1);
});

test('spot arb live: falha nas duas pernas + falha no unwind -> unbalanced', async () => {
  let i = 0;
  const buy = fakeEx('a', () => {
    i++;
    if (i === 1) return filledOrder({ symbol: 'X/USDT', amount: 1, price: 100 }, 100);
    throw new Error('network down'); // unwind falha
  });
  const sell = fakeEx('b', () => {
    throw new Error('rejected');
  });
  const before = state.consecutiveFailures;
  const r = await executeSpotArb({
    buyEx: buy, sellEx: sell, symbol: 'X/USDT', amount: 1,
    buyLimit: 100.1, sellLimit: 100.9, evaluation: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.detail.unbalanced, true);
  assert.equal(state.consecutiveFailures, before + 1);
});

test('triangular live: rota completa gera pnl da diferença in/out', async () => {
  const seen = [];
  const ex = fakeEx('okx', (o) => {
    seen.push(o.symbol);
    if (o.symbol === 'X/USDT') return filledOrder(o, 100); // 1 X por 100 USDT
    if (o.symbol === 'X/BTC') return { ...filledOrder(o, 0.0011), cost: o.amount * 0.0011 }; // recebe BTC
    if (o.symbol === 'BTC/USDT') return { ...filledOrder(o, 110000), cost: o.amount * 110000 };
    throw new Error(`inesperado ${o.symbol}`);
  });
  const r = await executeTriangularArb({
    ex,
    startUsd: 100,
    legs: [
      { symbol: 'X/USDT', side: 'buy', limit: 100 },
      { symbol: 'X/BTC', side: 'sell', limit: 0.0011 },
      { symbol: 'BTC/USDT', side: 'sell', limit: 110000 },
    ],
    evaluation: {},
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['X/USDT', 'X/BTC', 'BTC/USDT']);
  assert.ok(r.pnlUsd > 9, `pnl=${r.pnlUsd}`); // ~110 - taxas - 100
});

test('triangular live: perna 2 falha -> unwind do ativo para USDT', async () => {
  const seen = [];
  const ex = fakeEx('okx', (o) => {
    seen.push([o.symbol, o.type]);
    if (o.symbol === 'X/USDT' && o.side === 'buy') return filledOrder(o, 100);
    if (o.symbol === 'X/BTC') throw new Error('order rejected');
    if (o.symbol === 'X/USDT' && o.side === 'sell') return { ...filledOrder(o, 99), cost: o.amount * 99 };
    throw new Error(`inesperado ${o.symbol} ${o.side}`);
  });
  const r = await executeTriangularArb({
    ex,
    startUsd: 100,
    legs: [
      { symbol: 'X/USDT', side: 'buy', limit: 100 },
      { symbol: 'X/BTC', side: 'sell', limit: 0.0011 },
      { symbol: 'BTC/USDT', side: 'sell', limit: 110000 },
    ],
    evaluation: {},
  });
  assert.equal(r.ok, false);
  const unwind = seen.find(([s, t]) => s === 'X/USDT' && t === 'market');
  assert.ok(unwind, 'devia ter vendido X a mercado para recuperar USDT');
  assert.ok(r.pnlUsd < 0, `pnl=${r.pnlUsd}`); // ~99 - 100 - taxas
});
