import { config } from '../config.js';

/**
 * Normalização de market data.
 * Cada snapshot vira NormalizedMarketData:
 * { exchange, symbol, baseAsset, quoteAsset, bid, ask, bidSize, askSize,
 *   orderBook, timestampExchange, timestampReceived, sequence, latencyMs,
 *   dataAgeMs, status, dataQualityScore, anomalies }
 * Estados: LIVE | STALE | DEGRADED | OFFLINE
 * Anomalias: NEGATIVE_LATENCY, FUTURE_TIMESTAMP, MISSING_TIMESTAMP,
 *   INVALID_PRICE, EMPTY_BOOK, TIMESTAMP_ANOMALY
 */

const SKEW_TOLERANCE_MS = 2000;
const FRESH = () => config.lab.dataFreshnessMs;
const DEGRADED = () => config.lab.degradedDataMs;
const OFFLINE = () => config.lab.offlineDataMs;

export function normalizeBook(exchange, symbol, rawBook, receivedAt = Date.now()) {
  const anomalies = [];
  const ts = rawBook?.timestamp ?? (rawBook?.datetime ? Date.parse(rawBook.datetime) : null);
  const exchangeTs = Number.isFinite(ts) ? ts : null;
  if (exchangeTs === null) anomalies.push('MISSING_TIMESTAMP');

  const bids = rawBook?.bids || [];
  const asks = rawBook?.asks || [];
  if (!bids.length || !asks.length) anomalies.push('EMPTY_BOOK');

  const bid = bids[0]?.[0];
  const ask = asks[0]?.[0];
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) {
    anomalies.push('INVALID_PRICE');
  }

  let latencyMs = null;
  if (exchangeTs !== null) {
    latencyMs = receivedAt - exchangeTs;
    if (latencyMs < 0) {
      if (latencyMs >= -SKEW_TOLERANCE_MS) {
        latencyMs = 0; // skew pequeno tolerado (clock do servidor vs relógio local)
      } else {
        anomalies.push(latencyMs < -60_000 ? 'FUTURE_TIMESTAMP' : 'NEGATIVE_LATENCY');
        latencyMs = null; // rejeita a métrica até correção (clock skew)
      }
    }
  }
  const dataAgeMs = latencyMs ?? receivedAt - (exchangeTs ?? receivedAt);

  let status = 'LIVE';
  if (anomalies.includes('EMPTY_BOOK') || anomalies.includes('INVALID_PRICE')) status = 'OFFLINE';
  else if (dataAgeMs > OFFLINE()) status = 'OFFLINE';
  else if (dataAgeMs > DEGRADED()) status = 'DEGRADED';
  else if (dataAgeMs > FRESH() || anomalies.length) status = 'STALE';

  const [baseAsset, quoteAsset] = symbol.split('/');
  const q = dataQuality({ dataAgeMs, anomalies, latencyMs, bookDepth: Math.min(bids.length, asks.length) });

  return {
    exchange,
    symbol,
    baseAsset,
    quoteAsset: (quoteAsset || '').split(':')[0],
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    bidSize: bids[0]?.[1] ?? null,
    askSize: asks[0]?.[1] ?? null,
    orderBook: { bids, asks },
    timestampExchange: exchangeTs,
    timestampReceived: receivedAt,
    sequence: rawBook?.nonce ?? null,
    latencyMs,
    dataAgeMs,
    status,
    dataQualityScore: q,
    anomalies,
  };
}

/** Normaliza um ticker leve (fetchBidsAsks) sem order book completo. */
export function normalizeTicker(exchange, symbol, t, receivedAt = Date.now()) {
  const ts = t?.timestamp ?? (t?.datetime ? Date.parse(t.datetime) : null);
  const anomalies = [];
  if (!Number.isFinite(ts)) anomalies.push('MISSING_TIMESTAMP');
  if (!Number.isFinite(t?.bid) || !Number.isFinite(t?.ask) || t.bid <= 0 || t.ask <= 0 || t.bid >= t.ask) {
    anomalies.push('INVALID_PRICE');
  }
  let latencyMs = null;
  if (Number.isFinite(ts)) {
    latencyMs = receivedAt - ts;
    if (latencyMs < 0) {
      if (latencyMs >= -SKEW_TOLERANCE_MS) {
        latencyMs = 0;
      } else {
        anomalies.push(latencyMs < -60_000 ? 'FUTURE_TIMESTAMP' : 'NEGATIVE_LATENCY');
        latencyMs = null;
      }
    }
  }
  const dataAgeMs = latencyMs ?? 0;
  let status = 'LIVE';
  if (anomalies.includes('INVALID_PRICE')) status = 'OFFLINE';
  else if (dataAgeMs > OFFLINE()) status = 'OFFLINE';
  else if (dataAgeMs > DEGRADED()) status = 'DEGRADED';
  else if (dataAgeMs > FRESH() || anomalies.length) status = 'STALE';
  const [baseAsset, quoteAsset] = symbol.split('/');
  return {
    exchange,
    symbol,
    baseAsset,
    quoteAsset: (quoteAsset || '').split(':')[0],
    bid: t?.bid ?? null,
    ask: t?.ask ?? null,
    bidSize: t?.bidVolume ?? null,
    askSize: t?.askVolume ?? null,
    orderBook: null,
    timestampExchange: Number.isFinite(ts) ? ts : null,
    timestampReceived: receivedAt,
    sequence: t?.nonce ?? null,
    latencyMs,
    dataAgeMs,
    status,
    dataQualityScore: dataQuality({ dataAgeMs, anomalies, latencyMs, bookDepth: 0 }),
    anomalies,
  };
}

function dataQuality({ dataAgeMs, anomalies, latencyMs, bookDepth }) {
  let score = 100;
  // freshness (até -50)
  score -= Math.min(50, (dataAgeMs / Math.max(1, FRESH())) * 25);
  // latency medida
  if (latencyMs === null) score -= 10;
  else score -= Math.min(15, latencyMs / 200);
  // anomalias
  score -= anomalies.length * 15;
  if (anomalies.includes('MISSING_TIMESTAMP')) score -= 5;
  // completude do livro
  if (bookDepth === 0) score -= 15;
  else if (bookDepth < 5) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}
