import { config } from '../config.js';

/**
 * Detetor de regime de mercado:
 * NORMAL | LOW_LIQUIDITY | HIGH_VOLATILITY | EXTREME_VOLATILITY | DISLOCATED |
 * DATA_DEGRADED | EXCHANGE_DEGRADED
 * Em regimes de maior risco: edge exigido sobe, tamanho simulado desce.
 */
export function detectRegime({ volatilityBps = null, depthUsd = null, refDepthUsd = null, maxCrossVenueDiffPct = 0, anyDataDegraded = false, anyExchangeDegraded = false }) {
  const t = config.lab.regime;
  if (anyDataDegraded) return 'DATA_DEGRADED';
  if (anyExchangeDegraded) return 'EXCHANGE_DEGRADED';
  if (volatilityBps !== null && volatilityBps >= t.extremeVolBps) return 'EXTREME_VOLATILITY';
  if (volatilityBps !== null && volatilityBps >= t.highVolBps) return 'HIGH_VOLATILITY';
  if (maxCrossVenueDiffPct >= t.dislocatedPct) return 'DISLOCATED';
  if (depthUsd !== null && refDepthUsd && depthUsd < refDepthUsd * t.lowLiquidityFactor) return 'LOW_LIQUIDITY';
  return 'NORMAL';
}

export function regimeFactor(regime) {
  switch (regime) {
    case 'NORMAL': return { edgeFactor: 1, sizeFactor: 1, bufferFactor: 1 };
    case 'LOW_LIQUIDITY': return { edgeFactor: 1.5, sizeFactor: 0.5, bufferFactor: 1.5 };
    case 'HIGH_VOLATILITY': return { edgeFactor: 1.75, sizeFactor: 0.5, bufferFactor: 2 };
    case 'EXTREME_VOLATILITY': return { edgeFactor: 3, sizeFactor: 0.25, bufferFactor: 3 };
    case 'DISLOCATED': return { edgeFactor: 2, sizeFactor: 0.5, bufferFactor: 2 };
    case 'DATA_DEGRADED':
    case 'EXCHANGE_DEGRADED': return { edgeFactor: Infinity, sizeFactor: 0, bufferFactor: 3 };
    default: return { edgeFactor: 1, sizeFactor: 1, bufferFactor: 1 };
  }
}
