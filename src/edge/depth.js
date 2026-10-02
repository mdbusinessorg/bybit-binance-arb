import { vwapForQuote, vwapForAmount } from '../math.js';

/**
 * Análise de profundidade do order book.
 * Nunca assumir que o primeiro nível executa toda a quantidade.
 */

export const DEPTH_SIZES_USD = [10, 25, 50, 100, 250, 500, 1000];

/** VWAP executável de compra para vários tamanhos em quote (USDT). */
export function executableBuyCurve(asks, midPrice, sizes = DEPTH_SIZES_USD) {
  return sizes.map((usd) => {
    const r = vwapForQuote(asks, usd);
    const impactBps = r.avgPrice ? ((r.avgPrice - midPrice) / midPrice) * 10_000 : null;
    return { usd, avgPrice: r.avgPrice, filledBase: r.filled, costUsd: r.cost, impactBps, fullyFilled: r.cost >= usd * 0.98 };
  });
}

/** VWAP executável de venda para vários tamanhos em quote (USDT). */
export function executableSellCurve(bids, midPrice, sizes = DEPTH_SIZES_USD) {
  return sizes.map((usd) => {
    const base = usd / midPrice;
    const r = vwapForAmount(bids, base);
    const impactBps = r.avgPrice ? ((midPrice - r.avgPrice) / midPrice) * 10_000 : null;
    return { usd, avgPrice: r.avgPrice, filledBase: r.filled, proceedsUsd: r.cost, impactBps, fullyFilled: r.filled >= base * 0.999 };
  });
}

export function calculateExecutableBuyPrice(asks, quoteUsd, midPrice) {
  const r = vwapForQuote(asks, quoteUsd);
  if (!r.avgPrice) return null;
  return { avgPrice: r.avgPrice, filled: r.filled, cost: r.cost, slippageBps: ((r.avgPrice - midPrice) / midPrice) * 10_000 };
}

export function calculateExecutableSellPrice(bids, amountBase, midPrice) {
  const r = vwapForAmount(bids, amountBase);
  if (!r.avgPrice) return null;
  return { avgPrice: r.avgPrice, filled: r.filled, proceeds: r.cost, slippageBps: ((midPrice - r.avgPrice) / midPrice) * 10_000 };
}

/** Profundidade total disponível nos dois lados, em quote. */
export function calculateDepth(book, midPrice, levels = 20) {
  const bidDepth = (book.bids || []).slice(0, levels).reduce((a, [p, s]) => a + p * s, 0);
  const askDepth = (book.asks || []).slice(0, levels).reduce((a, [p, s]) => a + p * s, 0);
  const depthImbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  return { bidDepthUsd: bidDepth, askDepthUsd: askDepth, depthImbalance };
}

/** Maior quantidade executável abaixo de um impacto máximo (bps). */
export function maxExecutableQuote(asks, midPrice, maxImpactBps) {
  let cost = 0;
  let qty = 0;
  for (const [p, s] of asks) {
    if (((p - midPrice) / midPrice) * 10_000 > maxImpactBps) break;
    cost += p * s;
    qty += s;
  }
  return { maxQuoteUsd: cost, maxBaseQty: qty };
}

/** Classificação ORDERBOOK_THIN | ORDERBOOK_NORMAL | ORDERBOOK_DEEP. */
export function classifyDepth(book, midPrice, quoteUsd, thinFactor = 3, deepFactor = 30) {
  const { bidDepthUsd, askDepthUsd } = calculateDepth(book, midPrice);
  const shallow = Math.min(bidDepthUsd, askDepthUsd);
  if (!Number.isFinite(shallow) || shallow <= 0) return 'ORDERBOOK_THIN';
  const ratio = shallow / Math.max(1, quoteUsd);
  if (ratio < thinFactor) return 'ORDERBOOK_THIN';
  if (ratio >= deepFactor) return 'ORDERBOOK_DEEP';
  return 'ORDERBOOK_NORMAL';
}

/** Probabilidade de fill para um tamanho, dada a liquidez visível (0..1). */
export function fillProbability(availableQuoteUsd, wantedQuoteUsd) {
  if (wantedQuoteUsd <= 0) return 1;
  const r = availableQuoteUsd / wantedQuoteUsd;
  if (r >= 4) return 1;
  if (r >= 2) return 0.9;
  if (r >= 1.2) return 0.75;
  if (r >= 1) return 0.5;
  if (r >= 0.5) return 0.25;
  return 0.05;
}
