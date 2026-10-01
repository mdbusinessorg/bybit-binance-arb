/**
 * Filtros de "qualidade" de uma oportunidade — o que separa funding real de ruído:
 * mercados em delisting/novos, falta de open interest, histórico instável.
 */
import { config } from './config.js';
import { createLogger } from './logger.js';
import { normalizeFundingTo8h, summarizeFunding } from './math.js';

const log = createLogger('filters');

/**
 * Motivo para excluir um mercado perp (ou null se saudável):
 * - inativo / em delisting (Bybit deliveryTime != 0, Binance status != TRADING, contractType != PERPETUAL)
 * - listado há menos de `minListingDays` (funding de lançamento é extremo e não persiste)
 * - na blacklist configurada
 */
export function marketHealthIssue(market, { minListingDays = config.quality.minListingDays, blacklist = config.quality.blacklist, now = Date.now() } = {}) {
  if (!market) return 'mercado desconhecido';
  if (market.active === false) return 'mercado inativo';
  const base = market.base;
  if (blacklist.includes(base) || blacklist.includes(market.symbol)) return 'blacklist';
  const info = market.info || {};
  if (market.swap) {
    if (market.expiry) return 'tem data de expiração/delisting';
    const delivery = Number(info.deliveryTime || 0);
    if (delivery > 0) return `delisting agendado (${new Date(delivery).toISOString().slice(0, 10)})`;
    if (info.contractType && info.contractType !== 'PERPETUAL' && info.contractType !== 'LinearPerpetual') return `contrato ${info.contractType}`;
    if (info.status && !/^(TRADING|Trading)$/.test(info.status)) return `estado ${info.status}`;
  }
  const created = market.created || Number(info.launchTime || info.onboardDate || 0);
  if (created && minListingDays > 0 && now - created < minListingDays * 86_400_000) {
    return `listado há ${((now - created) / 86_400_000).toFixed(0)} dias (< ${minListingDays})`;
  }
  return null;
}

/**
 * Cache de histórico de funding por exchange+símbolo. Devolve o resumo das últimas `hours` horas
 * (taxas normalizadas a 8h). Resultado guardado durante `ttlMs` para não martelar a API.
 */
export class FundingHistoryCache {
  constructor(ttlMs = 60 * 60_000) {
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  async summary(ex, symbol, hours = config.quality.persistenceHours) {
    const key = `${ex.id}:${symbol}:${hours}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    let value = null;
    try {
      const since = Date.now() - hours * 3600_000;
      const rows = await ex.fetchFundingRateHistory(symbol, since, 200);
      const market = ex.markets[symbol];
      const intervalH = intervalHours(market);
      const rates = rows
        .filter((r) => (r.timestamp || 0) >= since && typeof r.fundingRate === 'number')
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((r) => normalizeFundingTo8h(r.fundingRate, intervalH));
      value = summarizeFunding(rates);
    } catch (e) {
      log.debug(`${ex.label} histórico de funding ${symbol} falhou: ${e.message}`);
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

export function intervalHours(market) {
  const info = market?.info || {};
  if (info.fundingInterval) {
    const minutes = Number(info.fundingInterval);
    if (Number.isFinite(minutes) && minutes > 0) return minutes / 60;
  }
  if (info.fundingIntervalHours) return Number(info.fundingIntervalHours);
  return 8;
}

/**
 * Open interest em USD (cache curta). Bybit devolve-o já no ticker; Binance via fetchOpenInterest.
 */
export class OpenInterestCache {
  constructor(ttlMs = 10 * 60_000) {
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  fromTicker(ticker) {
    const v = Number(ticker?.info?.openInterestValue);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  async valueUsd(ex, symbol, price, ticker) {
    const fromT = this.fromTicker(ticker);
    if (fromT) return fromT;
    const key = `${ex.id}:${symbol}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    let value = null;
    try {
      if (typeof ex.fetchOpenInterest === 'function') {
        const oi = await ex.fetchOpenInterest(symbol);
        if (Number.isFinite(oi?.openInterestValue) && oi.openInterestValue > 0) value = oi.openInterestValue;
        else if (Number.isFinite(oi?.openInterestAmount) && price) {
          const cs = ex.markets[symbol]?.contractSize || 1;
          value = oi.openInterestAmount * cs * price;
        }
      }
    } catch (e) {
      log.debug(`${ex.label} open interest ${symbol} falhou: ${e.message}`);
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

/**
 * Aplica os filtros de qualidade comuns a uma oportunidade de funding/carry.
 * Devolve null se passa, ou o motivo da rejeição. `history` omitido (undefined) = não verificar
 * histórico; null = histórico pedido mas indisponível.
 */
export function qualityIssue({ history, oiUsd, volumeUsd, positionUsd, minMean8h, requireSameSign = true }) {
  const q = config.quality;
  if (volumeUsd !== null && volumeUsd !== undefined && volumeUsd < q.minVolume24hUsd) return `volume 24h ${Math.round(volumeUsd / 1e6)}M < ${q.minVolume24hUsd / 1e6}M`;
  if (oiUsd !== null && oiUsd !== undefined) {
    if (oiUsd < q.minOpenInterestUsd) return `open interest ${Math.round(oiUsd / 1e6)}M < ${q.minOpenInterestUsd / 1e6}M`;
    if (positionUsd && positionUsd > oiUsd * q.maxPositionOiRatio) return `posição > ${q.maxPositionOiRatio * 100}% do open interest`;
  }
  if (history === undefined) return null;
  if (history && history.n >= q.minHistoryPeriods) {
    if (history.mean8h < minMean8h) return `média ${q.persistenceHours}h ${(history.mean8h * 100).toFixed(4)}%/8h abaixo do mínimo`;
    if (requireSameSign && history.flips > q.maxSignFlips) return `sinal do funding mudou ${history.flips}x em ${q.persistenceHours}h`;
    if (requireSameSign && history.min8h < 0 && Math.abs(history.min8h) > history.mean8h) return 'funding já esteve fortemente negativo';
  } else if (q.requireHistory) {
    return history ? `histórico insuficiente (${history.n} períodos)` : 'sem histórico de funding';
  }
  return null;
}
