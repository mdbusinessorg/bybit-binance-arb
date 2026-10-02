import { createLogger } from '../logger.js';
import { emit } from '../events.js';
import { config } from '../config.js';

const log = createLogger('ex-health');

/**
 * Monitor de saúde por exchange: latência de API, taxa de erro, dados stale,
 * eventos 429, estado da ligação. Estados: HEALTHY | DEGRADED | UNSTABLE | OFFLINE.
 * Uma exchange degradada deixa de ser fonte válida de sinais.
 */
export class ExchangeHealthMonitor {
  constructor(ids) {
    this.h = {};
    for (const id of ids) {
      this.h[id] = {
        status: 'HEALTHY',
        apiLatencyMs: [],
        errors: [],
        stale: [],
        rateLimitEvents: [],
        lastOkAt: 0,
        lastErrorAt: 0,
        consecutiveErrors: 0,
        reconnects: 0,
        obUpdates: 0,
        obWindowStart: Date.now(),
        obUpdatesPerSec: 0,
      };
    }
  }

  recordOk(id, latencyMs = null) {
    const h = this.h[id];
    if (!h) return;
    h.lastOkAt = Date.now();
    h.consecutiveErrors = 0;
    if (latencyMs !== null && latencyMs >= 0) {
      h.apiLatencyMs.push(latencyMs);
      if (h.apiLatencyMs.length > 200) h.apiLatencyMs.shift();
    }
    this.refresh(id);
  }

  recordError(id, err) {
    const h = this.h[id];
    if (!h) return;
    const is429 = /429|rate ?limit|too many/i.test(err?.message || '');
    h.errors.push(Date.now());
    h.lastErrorAt = Date.now();
    h.consecutiveErrors++;
    if (is429) {
      h.rateLimitEvents.push(Date.now());
      emit('exchange_error', 'health', { exchange: id, kind: 'RATE_LIMIT_429', message: String(err?.message || err).slice(0, 200) });
    } else {
      emit('exchange_error', 'health', { exchange: id, kind: 'API_ERROR', message: String(err?.message || err).slice(0, 200) });
    }
    this.refresh(id);
  }

  recordStale(id) {
    const h = this.h[id];
    if (!h) return;
    h.stale.push(Date.now());
    this.refresh(id);
  }

  recordObUpdate(id) {
    const h = this.h[id];
    if (!h) return;
    h.obUpdates++;
    const dt = Date.now() - h.obWindowStart;
    if (dt >= 10_000) {
      h.obUpdatesPerSec = (h.obUpdates / dt) * 1000;
      h.obUpdates = 0;
      h.obWindowStart = Date.now();
    }
  }

  refresh(id) {
    const h = this.h[id];
    const now = Date.now();
    const win = 60_000;
    h.errors = h.errors.filter((t) => now - t < win);
    h.stale = h.stale.filter((t) => now - t < win);
    h.rateLimitEvents = h.rateLimitEvents.filter((t) => now - t < 300_000);
    const silentMs = now - (h.lastOkAt || now);
    const prev = h.status;
    if (h.consecutiveErrors >= 5 || (h.lastOkAt && silentMs > config.lab.exchangeOfflineMs)) h.status = 'OFFLINE';
    else if (h.consecutiveErrors >= 3 || h.errors.length >= 10) h.status = 'UNSTABLE';
    else if (h.consecutiveErrors >= 1 || h.stale.length >= 8 || silentMs > config.lab.exchangeOfflineMs / 2) h.status = 'DEGRADED';
    else h.status = 'HEALTHY';
    if (prev !== h.status) {
      log.warn(`${id}: ${prev} -> ${h.status} (erros/min=${h.errors.length}, stale/min=${h.stale.length}, consec=${h.consecutiveErrors})`);
      emit('risk_event', 'health', { exchange: id, from: prev, to: h.status });
    }
  }

  p95(id) {
    const a = h0(this.h[id]?.apiLatencyMs);
    if (!a.length) return null;
    return a[Math.floor(a.length * 0.95)];
  }

  snapshot() {
    const out = {};
    for (const [id, h] of Object.entries(this.h)) {
      out[id] = {
        status: h.status,
        apiLatencyP95Ms: this.p95(id),
        errorsPerMin: h.errors.length,
        stalePerMin: h.stale.length,
        rateLimitEvents5m: h.rateLimitEvents.length,
        consecutiveErrors: h.consecutiveErrors,
        obUpdatesPerSec: Math.round(h.obUpdatesPerSec * 10) / 10,
        reconnects: h.reconnects,
        lastOkAt: h.lastOkAt || null,
      };
    }
    return out;
  }

  ok(id) {
    const s = this.h[id]?.status;
    return s === 'HEALTHY' || s === 'DEGRADED';
  }
}

function h0(a) {
  return (a || []).slice().sort((x, y) => x - y);
}
