/**
 * Estatísticas de oportunidades para afinar limiares: o que o robô viu, porque rejeitou,
 * e o melhor valor por hora (persistido em data/stats.jsonl).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, config.simulate ? 'stats.sim.jsonl' : 'stats.jsonl');
const latest = {}; // strategy -> { at, items: [...] }
const hourly = {}; // strategy -> { hour, best, symbol, seen, accepted }

function hourKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 13);
}

/** Guarda a lista atual de candidatos (com motivo de rejeição) de uma estratégia. */
export function setCandidates(strategy, items) {
  latest[strategy] = { at: new Date().toISOString(), items: items.slice(0, 15) };
}

export function candidates() {
  return latest;
}

/** Regista o melhor valor visto (spread/rate) e persiste o máximo de cada hora. */
export function recordBest(strategy, symbol, value, accepted = false) {
  const h = hourKey();
  let cur = hourly[strategy];
  if (cur && cur.hour !== h) {
    flush(strategy, cur);
    cur = null;
  }
  if (!cur) cur = hourly[strategy] = { hour: h, best: -Infinity, symbol: null, seen: 0, accepted: 0 };
  cur.seen++;
  if (accepted) cur.accepted++;
  if (Number.isFinite(value) && value > cur.best) {
    cur.best = value;
    cur.symbol = symbol;
  }
}

function flush(strategy, cur) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ hour: cur.hour, strategy, best: Number.isFinite(cur.best) ? cur.best : null, symbol: cur.symbol, seen: cur.seen, accepted: cur.accepted }) + '\n');
  } catch {}
}

export function hourlyHistory(limit = 72) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function flushAll() {
  for (const [strategy, cur] of Object.entries(hourly)) flush(strategy, cur);
}
