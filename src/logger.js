import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

fs.mkdirSync(config.dataDir, { recursive: true });
const logFile = path.join(config.dataDir, 'bot.log');

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const msg = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
    .join(' ');
  const line = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line);
  fs.appendFile(logFile, line + '\n', () => {});
}

export function createLogger(tag) {
  return {
    debug: (...a) => write('debug', tag, a),
    info: (...a) => write('info', tag, a),
    warn: (...a) => write('warn', tag, a),
    error: (...a) => write('error', tag, a),
  };
}
