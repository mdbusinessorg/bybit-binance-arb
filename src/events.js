import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Registo de eventos do sistema (data/events.jsonl) + ring buffer em memória.
 * Cada evento: { eventId, timestamp, type, source, payload, correlationId }.
 * Tipos usados: market_snapshot, orderbook_update, opportunity_detected,
 * opportunity_rejected, opportunity_expired, simulation_started,
 * simulation_completed, risk_event, exchange_error, latency_event,
 * strategy_event, backtest_event.
 */

const MAX_RING = 2000;
const ring = [];
const eventsFile = () => path.join(config.dataDir, config.simulate ? 'events.sim.jsonl' : 'events.jsonl');

// contadores técnicos para /metrics
export const counters = {
  messagesPerSec: 0,
  orderbookUpdatesPerSec: 0,
  errorsPerMin: 0,
  wsReconnects: 0,
  queueDepth: 0,
  _windowStart: Date.now(),
  _msg: 0,
  _ob: 0,
  _err: 0,
};

function rollWindow() {
  const now = Date.now();
  const dt = now - counters._windowStart;
  if (dt >= 10_000) {
    counters.messagesPerSec = (counters._msg / dt) * 1000;
    counters.orderbookUpdatesPerSec = (counters._ob / dt) * 1000;
    counters.errorsPerMin = (counters._err / dt) * 60_000;
    counters._msg = 0;
    counters._ob = 0;
    counters._err = 0;
    counters._windowStart = now;
  }
}

export function emit(type, source, payload = {}, correlationId = null) {
  const evt = {
    eventId: crypto.randomUUID(),
    timestamp: Date.now(),
    type,
    source,
    payload,
    correlationId,
  };
  ring.push(evt);
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
  counters._msg++;
  if (type === 'orderbook_update' || type === 'market_snapshot') counters._ob++;
  if (type === 'exchange_error' || type === 'risk_event') counters._err++;
  rollWindow();
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(eventsFile(), JSON.stringify(evt) + '\n');
  } catch {}
  return evt;
}

export function recentEvents(limit = 200, type = null) {
  const src = type ? ring.filter((e) => e.type === type) : ring;
  return src.slice(-limit);
}
