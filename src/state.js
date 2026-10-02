import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, config.simulate ? 'state.sim.json' : 'state.json');
const tradesFile = path.join(config.dataDir, config.simulate ? 'trades.sim.jsonl' : 'trades.jsonl');

function today() {
  return new Date().toISOString().slice(0, 10);
}

const defaults = () => ({
  startedAt: new Date().toISOString(),
  day: today(),
  dailyPnlUsd: 0,
  totalPnlUsd: 0,
  spotTrades: 0,
  fundingTrades: 0,
  consecutiveFailures: 0,
  halted: false,
  haltReason: null,
  fundingPositions: {},
  recentTradeTimestamps: [],
  opportunitiesSeen: 0,
  opportunities: [],
  lastReportAt: 0,
});

export let state = load();

function load() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = { ...defaults(), ...parsed };
    if (s.day !== today()) {
      s.day = today();
      s.dailyPnlUsd = 0;
      if (s.haltReason === 'daily-loss') {
        s.halted = false;
        s.haltReason = null;
      }
    }
    return s;
  } catch {
    return defaults();
  }
}

export function save() {
  if (state.day !== today()) {
    state.day = today();
    state.dailyPnlUsd = 0;
    if (state.haltReason === 'daily-loss') {
      state.halted = false;
      state.haltReason = null;
    }
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function recordTrade(trade) {
  const entry = { ts: new Date().toISOString(), mode: config.simulate ? 'sim' : config.live ? 'live' : 'dry', ...trade };
  fs.appendFileSync(tradesFile, JSON.stringify(entry) + '\n');
  if (typeof trade.pnlUsd === 'number') {
    state.dailyPnlUsd += trade.pnlUsd;
    state.totalPnlUsd += trade.pnlUsd;
  }
  state.recentTradeTimestamps = state.recentTradeTimestamps.filter((t) => Date.now() - t < 3600_000);
  state.recentTradeTimestamps.push(Date.now());
  save();
}

export function resetState() {
  state = defaults();
  save();
}

/** Regista uma oportunidade avaliada (executada ou não) para o painel web. Mantém as últimas 200. */
export function recordOpportunity(opp) {
  state.opportunities.push({ ts: new Date().toISOString(), ...opp });
  if (state.opportunities.length > 200) state.opportunities = state.opportunities.slice(-200);
}

export function recentTrades(limit = 50) {
  try {
    const lines = fs.readFileSync(tradesFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
