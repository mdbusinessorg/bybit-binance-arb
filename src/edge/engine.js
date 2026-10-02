import crypto from 'node:crypto';
import { config } from '../config.js';
import { vwapForQuote, vwapForAmount } from '../math.js';
import { classifyDepth, calculateDepth, fillProbability } from './depth.js';
import { detectRegime, regimeFactor } from '../risk/regime.js';
import { emit } from '../events.js';

/**
 * MOTOR DE EDGE — a cadeia de validação central.
 * Uma oportunidade NÃO é "spread > X": é NET_EDGE positivo depois de taxas,
 * slippage estimado, latência, custos e buffer de segurança, com TTL,
 * confidence score, reason codes e objeto de explicação.
 */

export const REASON = {
  NET_EDGE_TOO_LOW: 'NET_EDGE_TOO_LOW',
  STALE_DATA: 'STALE_DATA',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  HIGH_SLIPPAGE: 'HIGH_SLIPPAGE',
  HIGH_LATENCY: 'HIGH_LATENCY',
  EXCHANGE_DEGRADED: 'EXCHANGE_DEGRADED',
  PARTIAL_FILL_RISK: 'PARTIAL_FILL_RISK',
  VOLATILITY_TOO_HIGH: 'VOLATILITY_TOO_HIGH',
  RISK_LIMIT: 'RISK_LIMIT',
  INVALID_ORDERBOOK: 'INVALID_ORDERBOOK',
  DATA_QUALITY_LOW: 'DATA_QUALITY_LOW',
  SPREAD_ANOMALY: 'SPREAD_ANOMALY',
};

const REASON_PT = {
  NET_EDGE_TOO_LOW: 'edge líquido abaixo do limiar exigido',
  STALE_DATA: 'dados de mercado obsoletos',
  INSUFFICIENT_LIQUIDITY: 'liquidez insuficiente no livro',
  HIGH_SLIPPAGE: 'slippage estimado acima do máximo',
  HIGH_LATENCY: 'latência acima do máximo',
  EXCHANGE_DEGRADED: 'exchange degradada ou offline',
  PARTIAL_FILL_RISK: 'risco elevado de fill parcial',
  VOLATILITY_TOO_HIGH: 'volatilidade acima do limiar',
  RISK_LIMIT: 'limite de risco atingido',
  INVALID_ORDERBOOK: 'order book inválido',
  DATA_QUALITY_LOW: 'qualidade de dados baixa',
  SPREAD_ANOMALY: 'spread anómalo — provável erro de dados',
};

export class EdgeEngine {
  constructor({ slippage, governor, health }) {
    this.slippage = slippage;
    this.governor = governor;
    this.health = health;
    this.metrics = {
      detected: 0, validated: 0, rejected: 0, expired: 0,
      byReason: {},
    };
  }

  ttlMs() {
    return config.lab.opportunityTtlMs;
  }

  /** Edge exigido dinâmico: base + buffers por regime/volatilidade/latência. */
  requiredEdgeBps({ baseEdgeBps, regime, volatilityBps = 0, latencyMs = 0 }) {
    const f = regimeFactor(regime);
    const b =
      baseEdgeBps +
      Math.min(30, (volatilityBps || 0) * 0.2) + // volatilityBuffer
      Math.min(15, (latencyMs / 100) * 2) + // latencyBuffer
      config.lab.executionBufferBps; // executionBuffer
    return b * f.edgeFactor;
  }

  /**
   * Valida uma oportunidade spot cross-exchange com order books reais.
   * snapshots: NormalizedMarketData para buyVenue e sellVenue (com orderBook).
   * Devolve um objeto Opportunity completo com veredicto VALID|REJECTED.
   */
  evaluateCrossExchange({ symbol, buySnap, sellSnap, tradeUsd, buyFee, sellFee, detectedAt, maxSpreadPct }) {
    const now = detectedAt ?? Date.now();
    const opp = {
      id: crypto.randomUUID(),
      strategy: 'spot',
      symbol,
      buyVenue: buySnap.exchange,
      sellVenue: sellSnap.exchange,
      detectedAt: detectedAt ?? now,
      createdAt: now,
      expiresAt: now + this.ttlMs(),
      status: 'DETECTED',
      reasonCode: null,
      explanation: {},
    };
    this.metrics.detected++;
    const reject = (code, details = {}) => {
      opp.status = 'REJECTED';
      opp.reasonCode = code;
      opp.explanation.finalDecision = `REJECTED — ${REASON_PT[code] || code}`;
      Object.assign(opp.explanation, details);
      this.metrics.rejected++;
      this.metrics.byReason[code] = (this.metrics.byReason[code] || 0) + 1;
      emit('opportunity_rejected', 'edge', { id: opp.id, symbol, code });
      return opp;
    };

    // 1. freshness / TTL dos dados
    const maxAge = Math.max(buySnap.dataAgeMs, sellSnap.dataAgeMs);
    if (buySnap.status === 'OFFLINE' || sellSnap.status === 'OFFLINE') {
      return reject(REASON.STALE_DATA, { latencyReason: `snapshot offline (age=${maxAge}ms)` });
    }
    if (buySnap.status !== 'LIVE' || sellSnap.status !== 'LIVE') {
      return reject(REASON.STALE_DATA, { latencyReason: `dados ${buySnap.status}/${sellSnap.status} (age=${maxAge}ms)` });
    }
    // 2. qualidade
    const minQ = Math.min(buySnap.dataQualityScore, sellSnap.dataQualityScore);
    if (minQ < config.lab.minDataQuality) {
      return reject(REASON.DATA_QUALITY_LOW, { dataQualityScore: minQ });
    }
    // 3. livros válidos
    const buyBook = buySnap.orderBook;
    const sellBook = sellSnap.orderBook;
    if (!buyBook?.asks?.length || !sellBook?.bids?.length) {
      return reject(REASON.INVALID_ORDERBOOK);
    }
    const midBuy = (buySnap.bid + buySnap.ask) / 2;
    const midSell = (sellSnap.bid + sellSnap.ask) / 2;
    // dislocação cross-venue: mid prices demasiado diferentes => possível símbolo errado/dados maus
    const crossDiff = Math.abs(midSell - midBuy) / midBuy;
    const regime = detectRegime({
      volatilityBps: Math.max(this.slippage.volatilityBps(buySnap.exchange, symbol) || 0, this.slippage.volatilityBps(sellSnap.exchange, symbol) || 0),
      depthUsd: Math.min(calculateDepth(buyBook, midBuy).askDepthUsd, calculateDepth(sellBook, midSell).bidDepthUsd),
      refDepthUsd: tradeUsd * 20,
      maxCrossVenueDiffPct: crossDiff,
      anyExchangeDegraded: !this.health.ok(buySnap.exchange) || !this.health.ok(sellSnap.exchange),
      anyDataDegraded: buySnap.status === 'DEGRADED' || sellSnap.status === 'DEGRADED',
    });
    opp.regime = regime;
    if (crossDiff > (maxSpreadPct ?? config.spot.maxSpreadPct)) {
      return reject(REASON.SPREAD_ANOMALY, { spreadReason: `mid ${buySnap.exchange}=${midBuy} vs ${sellSnap.exchange}=${midSell} (${(crossDiff * 100).toFixed(2)}%)` });
    }

    // 4. VWAP executável real
    const buy = vwapForQuote(buyBook.asks, tradeUsd);
    if (!buy.avgPrice || buy.cost < tradeUsd * 0.98) {
      return reject(REASON.INSUFFICIENT_LIQUIDITY, { liquidityReason: `só ${buy.cost.toFixed(0)}/${tradeUsd} USD de asks em ${buySnap.exchange}` });
    }
    const amount = buy.filled;
    const sell = vwapForAmount(sellBook.bids, amount);
    if (!sell.avgPrice || sell.filled < amount * 0.999) {
      return reject(REASON.INSUFFICIENT_LIQUIDITY, { liquidityReason: `bids insuficientes em ${sellSnap.exchange} para ${amount.toPrecision(4)}` });
    }

    // 5. gross/net edge
    const grossPct = sell.cost / buy.cost - 1;
    const fees = buy.cost * buyFee + sell.cost * sellFee;
    const feesPct = fees / buy.cost;
    // 6. slippage model
    const buyImpactBps = ((buy.avgPrice - midBuy) / midBuy) * 10_000;
    const sellImpactBps = ((midSell - sell.avgPrice) / midSell) * 10_000;
    const spreadBps = ((buySnap.ask - buySnap.bid) / buySnap.bid) * 10_000;
    const vol = Math.max(this.slippage.volatilityBps(buySnap.exchange, symbol) || 0, this.slippage.volatilityBps(sellSnap.exchange, symbol) || 0);
    const slip = this.slippage.estimate({
      bookImpactBps: buyImpactBps + sellImpactBps,
      spreadBps,
      volatilityBps: vol,
      quoteUsd: tradeUsd,
    });
    const slippagePct = slip.conservativeSlippageBps / 10_000;
    // 7. latência -> custo de oportunidade (buffer em %)
    const latencyMs = Math.max(buySnap.latencyMs || 0, sellSnap.latencyMs || 0) + (now - opp.detectedAt);
    const latencyBufferPct = Math.min(0.005, (latencyMs / 1000) * (vol / 10_000) * 0.5 + 0.0002);
    const f = regimeFactor(regime);
    const safetyBufferPct = config.lab.safetyBufferPct * f.bufferFactor;

    const netPct = grossPct - feesPct - slippagePct - latencyBufferPct - safetyBufferPct;
    const netUsd = buy.cost * netPct;
    const grossUsd = sell.cost - buy.cost;

    // 8. fill risk
    const buyAvail = calculateDepth(buyBook, midBuy).askDepthUsd;
    const sellAvail = calculateDepth(sellBook, midSell).bidDepthUsd;
    const fp = Math.min(fillProbability(buyAvail, tradeUsd), fillProbability(sellAvail, buy.cost));
    const depthClass = {
      buy: classifyDepth(buyBook, midBuy, tradeUsd),
      sell: classifyDepth(sellBook, midSell, tradeUsd),
    };

    // 9. required edge
    const reqBps = this.requiredEdgeBps({
      baseEdgeBps: config.lab.baseEdgeBps + feesPct * 10_000,
      regime,
      volatilityBps: vol,
      latencyMs,
    });

    // 10. confidence score 0-100
    const { score, pos, neg } = confidence({
      minDataQ: minQ,
      depthClasses: Object.values(depthClass),
      fillProb: fp,
      slippageBps: slip.conservativeSlippageBps,
      volatilityBps: vol,
      latencyMs,
      netMarginBps: netPct * 10_000 - reqBps,
    });

    opp.measurements = {
      grossSpreadPct: grossPct, grossUsd,
      feesPct, slippagePct, latencyBufferPct, safetyBufferPct,
      netEdgePct: netPct, netUsd, netBps: netPct * 10_000,
      requiredEdgeBps: reqBps,
      estimatedSlippageBps: slip.estimatedSlippageBps,
      conservativeSlippageBps: slip.conservativeSlippageBps,
      buyVwap: buy.avgPrice, sellVwap: sell.avgPrice, amount,
      latencyMs, dataAgeMs: maxAge,
      depthClass, fillProbability: fp, partialFillRisk: 1 - fp,
      volatilityBps: vol, crossVenueDiffPct: crossDiff,
      entryVwapCurveAvailable: true,
    };
    opp.confidence = score;
    opp.confidenceFactors = { positive: pos, negative: neg };
    opp.explanation = {
      spreadReason: `gross ${(grossPct * 100).toFixed(3)}% em ${buySnap.exchange}->${sellSnap.exchange}`,
      feeReason: `taxas ${(feesPct * 100).toFixed(3)}%`,
      slippageReason: `slippage conservador ${slip.conservativeSlippageBps}bps (est. ${slip.estimatedSlippageBps}bps)`,
      latencyReason: `latência ${latencyMs}ms -> buffer ${(latencyBufferPct * 100).toFixed(3)}%`,
      riskReason: `regime ${regime}, edge exigido ${reqBps.toFixed(1)}bps`,
      liquidityReason: `depth ${depthClass.buy}/${depthClass.sell}, fillProb ${(fp * 100).toFixed(0)}%`,
      finalDecision: null,
    };

    // 11. governor gate
    const gate = this.governor.gate({
      exchangeIds: [buySnap.exchange, sellSnap.exchange],
      maxDataAgeMs: maxAge,
      estSlippageBps: slip.conservativeSlippageBps,
      latencyMs,
    });
    if (gate) return reject(gate.code || 'RISK_LIMIT', { riskReason: gate.reason });
    if (vol > config.lab.maxVolatilityBps) {
      return reject(REASON.VOLATILITY_TOO_HIGH, { riskReason: `volatilidade ${vol.toFixed(1)}bps > ${config.lab.maxVolatilityBps}bps` });
    }
    if (fp < config.lab.minFillProbability) {
      return reject(REASON.PARTIAL_FILL_RISK, { liquidityReason: `fillProb ${(fp * 100).toFixed(0)}% < ${config.lab.minFillProbability * 100}%` });
    }
    if (netPct * 10_000 < reqBps || netUsd < config.lab.minNetUsd) {
      return reject(REASON.NET_EDGE_TOO_LOW, {
        finalDecision: `REJECTED — Net edge ${(netPct * 10_000).toFixed(1)}bps < required ${reqBps.toFixed(1)}bps`,
      });
    }

    opp.status = 'VALIDATED';
    opp.explanation.finalDecision = `VALID — net edge ${(netPct * 10_000).toFixed(1)}bps >= required ${reqBps.toFixed(1)}bps, confidence ${score}`;
    this.metrics.validated++;
    emit('opportunity_detected', 'edge', { id: opp.id, symbol, netBps: opp.measurements.netBps, confidence: score });
    return opp;
  }

  expire(opps) {
    const now = Date.now();
    for (const o of opps) {
      if ((o.status === 'DETECTED' || o.status === 'VALIDATED') && now > o.expiresAt) {
        o.status = 'EXPIRED';
        o.signalLifetimeMs = now - o.detectedAt;
        this.metrics.expired++;
        emit('opportunity_expired', 'edge', { id: o.id, symbol: o.symbol });
      }
    }
  }
}

function confidence({ minDataQ, depthClasses, fillProb, slippageBps, volatilityBps, latencyMs, netMarginBps }) {
  let score = 50;
  const pos = [];
  const neg = [];
  score += (minDataQ - 70) * 0.4;
  if (minDataQ >= 85) pos.push('dados frescos e completos');
  else if (minDataQ < 70) neg.push('qualidade de dados reduzida');
  if (depthClasses.every((d) => d === 'ORDERBOOK_DEEP')) { score += 15; pos.push('livros profundos'); }
  else if (depthClasses.includes('ORDERBOOK_THIN')) { score -= 15; neg.push('liquidez superficial'); }
  if (fillProb >= 0.9) { score += 10; pos.push('alta probabilidade de fill'); }
  else if (fillProb < 0.5) { score -= 15; neg.push('risco de fill parcial'); }
  if (slippageBps <= 5) { score += 8; pos.push('slippage estimado baixo'); }
  else if (slippageBps > 15) { score -= 12; neg.push('slippage estimado alto'); }
  if (volatilityBps <= 15) { score += 5; pos.push('volatilidade baixa'); }
  else if (volatilityBps > 40) { score -= 12; neg.push('volatilidade alta'); }
  if (latencyMs < 500) { score += 5; pos.push('latência baixa'); }
  else if (latencyMs > 2000) { score -= 10; neg.push('latência alta'); }
  if (netMarginBps > 10) { score += 10; pos.push('margem confortável sobre o edge exigido'); }
  else if (netMarginBps < 3) { score -= 8; neg.push('margem fina sobre o edge exigido'); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), pos, neg };
}
