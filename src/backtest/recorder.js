import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Grava frames de order book para replay/backtest (data/frames-YYYYMMDD.jsonl).
 * Ativa-se com RECORD_MARKET_DATA=true.
 */
const file = () => path.join(config.dataDir, `frames-${new Date().toISOString().slice(0, 10)}.jsonl`);

export function recordFrame(booksByExchange) {
  if (!config.lab.record) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(file(), JSON.stringify({ t: Date.now(), books: booksByExchange }) + '\n');
  } catch {}
}

/** Carrega frames de um ficheiro jsonl (ou de todos os frames-*.jsonl do dataDir). */
export function loadFrames(filePath = null) {
  const files = filePath
    ? [filePath]
    : fs.readdirSync(config.dataDir).filter((f) => f.startsWith('frames-') && f.endsWith('.jsonl')).map((f) => path.join(config.dataDir, f)).sort();
  const frames = [];
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (line.trim()) frames.push(JSON.parse(line));
      }
    } catch {}
  }
  frames.sort((a, b) => a.t - b.t);
  return frames;
}

/** Gerador sintético de frames para backtest sem dados gravados nem rede. */
export function syntheticFrames({ exchanges, symbol, frames = 500, startPrice = 100, seed = 42 }) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let mid = startPrice;
  const out = [];
  const bias = Object.fromEntries(exchanges.map((id) => [id, 0]));
  let t = Date.now() - frames * 1000;
  for (let i = 0; i < frames; i++) {
    t += 1000;
    mid *= 1 + (rand() - 0.5) * 0.004;
    const books = {};
    for (const id of exchanges) {
      // dislocação persistente com choques ocasionais (às vezes > taxas => sinais)
      bias[id] = bias[id] * 0.9 + (rand() - 0.5) * 0.0006;
      if (rand() < 0.03) bias[id] += (rand() - 0.5) * 0.02;
      const exMid = mid * (1 + bias[id] + (rand() - 0.5) * 0.001);
      const spread = exMid * 0.0005 * (1 + rand() * 2);
      const bids = [];
      const asks = [];
      for (let l = 0; l < 20; l++) {
        bids.push([exMid - spread / 2 - l * exMid * 0.0002, (0.5 + rand() * 3) * (100 / exMid)]);
        asks.push([exMid + spread / 2 + l * exMid * 0.0002, (0.5 + rand() * 3) * (100 / exMid)]);
      }
      books[id] = { [symbol]: { timestamp: t - Math.floor(rand() * 1500), bids, asks } };
    }
    out.push({ t, books });
  }
  return out;
}
