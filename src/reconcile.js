import { config } from './config.js';
import { createLogger } from './logger.js';
import { state, save } from './state.js';
import { emit } from './events.js';

const log = createLogger('reconcile');

/**
 * RECONCILIAÇÃO — compara o estado interno (posições funding registadas)
 * com o estado real das exchanges (posições/saldos via API autenticada).
 * Corre periodicamente quando há chaves; reporta divergências e marca
 * posições órfãs (internas sem correspondente real).
 */
export class Reconciler {
  constructor(exs) {
    this.exs = exs;
    this.lastRunAt = 0;
    this.intervalMs = 5 * 60_000; // 5 min
    this.result = { ok: true, checkedAt: null, divergences: [], positions: [] };
  }

  hasKeys() {
    return config.exchanges.some((id) => config[id]?.apiKey);
  }

  async tick() {
    if (Date.now() - this.lastRunAt < this.intervalMs) return;
    if (!this.hasKeys() || config.simulate) return;
    this.lastRunAt = Date.now();
    await this.run().catch((e) => log.warn(`reconciliação falhou: ${e.message}`));
  }

  async run() {
    const divergences = [];
    const positionRows = [];
    const internal = Object.values(state.fundingPositions || {});

    for (const pos of internal) {
      let realLong = null;
      let realShort = null;
      try {
        const pLong = await this.exs[pos.longId]?.fetchPositions?.([pos.symbol]);
        realLong = (pLong || []).find((p) => p.symbol === pos.symbol && Math.abs(p.contracts || 0) > 0);
      } catch {}
      try {
        const pShort = await this.exs[pos.shortId]?.fetchPositions?.([pos.symbol]);
        realShort = (pShort || []).find((p) => p.symbol === pos.symbol && Math.abs(p.contracts || 0) > 0);
      } catch {}
      const orphan = pos.longId !== pos.shortId ? !realLong || !realShort : !realLong && !realShort;
      positionRows.push({ symbol: pos.symbol, longId: pos.longId, shortId: pos.shortId, realLong: Boolean(realLong), realShort: Boolean(realShort), orphan });
      if (orphan) {
        divergences.push(`${pos.symbol}: posição interna sem correspondente na exchange`);
      }
    }

    this.result = { ok: divergences.length === 0, checkedAt: new Date().toISOString(), divergences, positions: positionRows };
    if (divergences.length) {
      log.warn(`reconciliação: ${divergences.length} divergência(s): ${divergences.join(' | ')}`);
      emit('reconciliation_divergence', 'reconcile', { count: divergences.length });
    } else {
      log.info(`reconciliação OK: ${internal.length} posições verificadas`);
      emit('reconciliation_ok', 'reconcile', { positions: internal.length });
    }
    save();
  }
}
