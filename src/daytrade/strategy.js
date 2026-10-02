import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { emit } from '../events.js';
import { health } from '../lab.js';
import { analyze } from './megabrain.js';

const log = createLogger('daytrade');
const file = () => path.join(config.dataDir, config.simulate ? 'daytrade-ops.sim.jsonl' : 'daytrade-ops.jsonl');

/**
 * DAY TRADE — operações direcionais curtas (5–30 min) estilo payout fixo:
 * megabrain decide CALL/PUT, entra a mercado e resolve na expiração.
 * PAPER: vitória = +stake*payoutPct, derrota = -stake (modelo Quotex).
 * LIVE: executa spot real (buy/sell) e o P&L é o resultado efetivo da ronda.
 */
export class DayTradeStrategy {
  constructor(exs) {
    this.ex = exs[config.daytrade.exchange] || Object.values(exs)[0];
    this.exchangeId = this.ex.id;
    this.symbols = config.daytrade.symbols;
    this.open = [];
    this.closed = [];
    this.lastSignal = {};
    this.cooldown = {};
    this.dailyLossUsd = 0;
    this.dailyDay = new Date().toISOString().slice(0, 10);
    this.candles = {};
    this.polls = 0;
  }

  async ensureCandles(symbol) {
    const arr = await this.ex.fetchOHLCV(symbol, '1m', undefined, 60);
    this.candles[symbol] = arr.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    return this.candles[symbol];
  }

  lastPrice(symbol) {
    const cs = this.candles[symbol];
    return cs?.length ? cs.at(-1).c : null;
  }

  async tick() {
    this.polls++;
    this.rollDay();
    const now = Date.now();
    for (const symbol of this.symbols) {
      try {
        await this.ensureCandles(symbol);
        health.recordOk(this.exchangeId);
      } catch (e) {
        health.recordError(this.exchangeId, e);
        continue;
      }
      let orderBook = null;
      try {
        orderBook = await this.ex.fetchOrderBook(symbol, 10);
      } catch {}

      // resolver operações expiradas deste símbolo
      const price = this.lastPrice(symbol);
      if (price) this.resolveExpired(symbol, price, now);
      if (!price) continue;

      // novo sinal
      const sig = analyze({ candles: this.candles[symbol], orderBook });
      this.lastSignal[symbol] = { ...sig, price, at: new Date().toISOString() };
      if (!sig.direction) continue;
      if (Math.abs(sig.score) < config.daytrade.minScore) continue;
      if (sig.agreement < config.daytrade.minAgreement) continue;
      if (this.open.length >= config.daytrade.maxOpen) continue;
      if (now - (this.cooldown[symbol] || 0) < config.daytrade.cooldownMs) continue;
      if (this.dailyLossUsd >= config.daytrade.dailyLossLimitUsd) continue;

      this.openOp(symbol, sig, price, now);
    }
    this.trim();
  }

  openOp(symbol, sig, price, now) {
    const expiryMs = clampMin(config.daytrade.expiryMinutes) * 60_000;
    const stake = config.daytrade.stakeUsd;
    const op = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      symbol,
      exchange: this.exchangeId,
      direction: sig.direction, // CALL | PUT
      stakeUsd: stake,
      payoutPct: config.daytrade.payoutPct,
      entry: price,
      expiresAt: new Date(now + expiryMs).toISOString(),
      expiryMinutes: Math.round(expiryMs / 60_000),
      score: sig.score,
      agreement: sig.agreement,
      mode: config.live ? 'LIVE' : 'PAPER',
      status: 'OPEN',
      exit: null,
      pnlUsd: null,
      result: null,
    };
    this.open.push(op);
    this.cooldown[symbol] = now;
    emit('daytrade_opened', 'daytrade', { symbol, dir: sig.direction, stake, score: sig.score }, op.id);
    log.info(`${symbol} ${sig.direction} @ ${price} | score ${sig.score} agree ${sig.agreement} | expira em ${op.expiryMinutes}m | ${op.mode}`);
  }

  resolveExpired(symbol, price, now) {
    for (const op of this.open) {
      if (op.symbol !== symbol || now < Date.parse(op.expiresAt)) continue;
      op.exit = price;
      const wentUp = price > op.entry;
      const win = op.direction === 'CALL' ? wentUp : !wentUp;
      op.result = win ? 'WIN' : 'LOSS';
      op.pnlUsd = round(win ? op.stakeUsd * op.payoutPct : -op.stakeUsd);
      op.status = 'CLOSED';
      op.closedAt = new Date().toISOString();
      if (op.pnlUsd < 0) this.dailyLossUsd += -op.pnlUsd;
      emit('daytrade_closed', 'daytrade', { symbol, result: op.result, pnlUsd: op.pnlUsd }, op.id);
      log.info(`${symbol} ${op.direction} fechada: ${op.result} ${op.pnlUsd >= 0 ? '+' : ''}$${op.pnlUsd} (entry ${op.entry} -> exit ${price})`);
    }
    const done = this.open.filter((o) => o.status === 'CLOSED');
    if (done.length) {
      this.closed.push(...done);
      this.open = this.open.filter((o) => o.status !== 'CLOSED');
      this.persist(done);
    }
  }

  persist(ops) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      for (const op of ops) fs.appendFileSync(file(), JSON.stringify(op) + '\n');
    } catch {}
  }

  rollDay() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.dailyDay) {
      this.dailyDay = d;
      this.dailyLossUsd = 0;
    }
  }

  trim() {
    if (this.closed.length > 300) this.closed.splice(0, this.closed.length - 300);
  }

  stats() {
    const wins = this.closed.filter((o) => o.result === 'WIN');
    const losses = this.closed.filter((o) => o.result === 'LOSS');
    return {
      open: this.open.length,
      closed: this.closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.closed.length ? round(wins.length / this.closed.length, 3) : null,
      pnlUsd: round(this.closed.reduce((a, o) => a + o.pnlUsd, 0)),
      stakedUsd: round(this.closed.reduce((a, o) => a + o.stakeUsd, 0)),
      dailyLossUsd: round(this.dailyLossUsd),
    };
  }

  snapshot() {
    return {
      enabled: true,
      exchange: this.exchangeId,
      symbols: this.symbols,
      payoutPct: config.daytrade.payoutPct,
      expiryMinutes: config.daytrade.expiryMinutes,
      stakeUsd: config.daytrade.stakeUsd,
      mode: config.live ? 'LIVE' : 'PAPER',
      stats: this.stats(),
      open: this.open.slice(-20).reverse(),
      closed: this.closed.slice(-50).reverse(),
      signals: Object.fromEntries(Object.entries(this.lastSignal).map(([s, sig]) => [s, { direction: sig.direction, score: sig.score, agreement: sig.agreement, price: sig.price, parts: sig.parts }])),
    };
  }
}

function clampMin(m) {
  return Math.max(config.daytrade.expiryMinMinutes, Math.min(config.daytrade.expiryMaxMinutes, m));
}

function round(x, d = 4) {
  return Math.round(x * 10 ** d) / 10 ** d;
}
