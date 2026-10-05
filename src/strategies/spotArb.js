import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { pct, usd } from '../math.js';
import { executeSpotArb } from '../executor.js';
import { state, save, recordTrade, recordOpportunity } from '../state.js';
import { tradingBlockedReason } from '../risk.js';
import { notify } from '../notify.js';
import { commonSpotSymbols, EXCHANGE_IDS, orderedPairs } from '../exchanges.js';
import { normalizeTicker, normalizeBook } from '../market-data/normalize.js';
import { edge, paper, slippage, health, approvals } from '../lab.js';
import { recordFrame } from '../backtest/recorder.js';
import { emit } from '../events.js';

const log = createLogger('spot');

export class SpotArbStrategy {
  constructor(exs) {
    this.exs = exs;
    this.symbols = commonSpotSymbols(exs, config.spot.symbols);
    this.pairs = orderedPairs();
    this.cooldown = new Map();
    this.balances = Object.fromEntries(EXCHANGE_IDS.map((id) => [id, null]));
    this.balancesAt = 0;
    this.polls = 0;
    this.best = { symbol: null, grossPct: -Infinity, dir: null };
    this.open = []; // oportunidades no pipeline (para TTL)
    this.thresholds = {};
    for (const [buyId, sellId] of this.pairs) {
      this.thresholds[`${buyId}->${sellId}`] = this.minGrossPct(buyId, sellId);
    }
    const minT = Math.min(...Object.values(this.thresholds));
    log.info(`símbolos comuns: ${this.symbols.length}/${config.spot.symbols.length} -> ${this.symbols.join(', ')}`);
    log.info(
      `pares ${EXCHANGE_IDS.join('↔')} (${this.pairs.length} direções) | limiar bruto mínimo ${pct(minT, 3)} ` +
        `(a validação real é feita pelo edge engine), tamanho alvo ${usd(config.spot.tradeUsd)}`,
    );
  }

  minGrossPct(buyId, sellId) {
    return this.exs[buyId].fees_.spotTaker + this.exs[sellId].fees_.spotTaker + config.spot.minNetPct + config.spot.slippageBufferPct;
  }

  async refreshBalances(force = false) {
    const hasKeys = EXCHANGE_IDS.some((id) => config[id]?.apiKey);
    if (!config.live && !config.simulate && !hasKeys) return;
    if (!force && Date.now() - this.balancesAt < 60_000) return;
    const res = await Promise.allSettled(EXCHANGE_IDS.map((id) => this.exs[id].fetchBalance({ type: 'spot' })));
    EXCHANGE_IDS.forEach((id, i) => {
      if (res[i].status === 'fulfilled') {
        this.balances[id] = res[i].value;
        health.recordOk(id);
      } else {
        health.recordError(id, res[i].reason);
        log.warn(`${id} fetchBalance falhou: ${res[i].reason?.message}`);
      }
    });
    this.balancesAt = Date.now();
  }

  free(id, currency) {
    const b = this.balances[id];
    if (!b) return Infinity;
    return Number(b.free?.[currency] ?? b[currency]?.free ?? 0);
  }

  async tick() {
    this.polls++;
    const receivedAt = Date.now();
    const quotes = {};
    const snaps = {};
    await Promise.all(
      EXCHANGE_IDS.map(async (id) => {
        const t0 = Date.now();
        try {
          const ex = this.exs[id];
          quotes[id] = ex.has.fetchBidsAsks
            ? await ex.fetchBidsAsks(this.symbols)
            : await ex.fetchTickers(this.symbols);
          health.recordOk(id, Date.now() - t0);
        } catch (e) {
          health.recordError(id, e);
          quotes[id] = {};
        }
      }),
    );
    const candidates = [];

    for (const symbol of this.symbols) {
      for (const id of EXCHANGE_IDS) {
        const t = quotes[id]?.[symbol];
        if (!t) continue;
        snaps[`${id}:${symbol}`] = snaps[`${id}:${symbol}`] || normalizeTicker(id, symbol, t, receivedAt);
        const snap = snaps[`${id}:${symbol}`];
        if (snap.bid && snap.ask) slippage.observeMid(id, symbol, (snap.bid + snap.ask) / 2);
        if (snap.status !== 'LIVE') health.recordStale(id);
      }
      for (const [buyId, sellId] of this.pairs) {
        const s1 = snaps[`${buyId}:${symbol}`];
        const s2 = snaps[`${sellId}:${symbol}`];
        if (!s1?.ask || !s2?.bid) continue;
        if (s1.status === 'OFFLINE' || s2.status === 'OFFLINE') continue;
        const grossPct = (s2.bid - s1.ask) / s1.ask;
        if (grossPct > this.best.grossPct) this.best = { symbol, grossPct, dir: `${buyId}->${sellId}` };
        const threshold = this.thresholds[`${buyId}->${sellId}`];
        if (grossPct >= threshold && grossPct <= config.spot.maxSpreadPct) {
          candidates.push({ symbol, buyId, sellId, grossPct, detectedAt: receivedAt });
        }
      }
    }

    if (this.polls % 40 === 0) {
      log.info(`${this.polls} varrimentos | melhor spread visto: ${this.best.symbol} ${this.best.dir} ${pct(this.best.grossPct)} | edge: ${edge.metrics.validated} validadas/${edge.metrics.rejected} rejeitadas`);
      this.best = { symbol: null, grossPct: -Infinity, dir: null };
    }

    candidates.sort((a, b) => b.grossPct - a.grossPct);
    for (const c of candidates.slice(0, 3)) {
      const until = this.cooldown.get(`${c.buyId}->${c.sellId}:${c.symbol}`) || 0;
      if (Date.now() < until) continue;
      await this.evaluateAndExecute(c);
    }
    edge.expire(this.open);
    this.open = this.open.filter((o) => o.status !== 'EXPIRED' && o.status !== 'REJECTED');
  }

  cooldownFor(c, ms) {
    this.cooldown.set(`${c.buyId}->${c.sellId}:${c.symbol}`, Date.now() + ms);
  }

  async evaluateAndExecute(c) {
    const buyEx = this.exs[c.buyId];
    const sellEx = this.exs[c.sellId];
    const t0 = Date.now();
    let obBuy, obSell;
    try {
      [obBuy, obSell] = await Promise.all([buyEx.fetchOrderBook(c.symbol, 20), sellEx.fetchOrderBook(c.symbol, 20)]);
      health.recordOk(c.buyId);
      health.recordOk(c.sellId);
    } catch (e) {
      health.recordError(c.buyId, e);
      health.recordError(c.sellId, e);
      throw e;
    }
    health.recordObUpdate(c.buyId);
    health.recordObUpdate(c.sellId);
    if (config.lab.record) recordFrame({ [c.buyId]: { [c.symbol]: obBuy }, [c.sellId]: { [c.symbol]: obSell } });

    const buySnap = normalizeBook(c.buyId, c.symbol, obBuy);
    const sellSnap = normalizeBook(c.sellId, c.symbol, obSell);
    emit('orderbook_update', 'spot', { symbol: c.symbol, buy: c.buyId, sell: c.sellId, ageMs: Math.max(buySnap.dataAgeMs, sellSnap.dataAgeMs) });

    await this.refreshBalances();
    let tradeUsd = config.spot.tradeUsd;
    const market = buyEx.market(c.symbol);
    const usdtFree = this.free(c.buyId, 'USDT');
    const baseFree = this.free(c.sellId, market.base);
    const refBid = sellSnap.bid || obSell.bids[0][0];
    tradeUsd = Math.min(tradeUsd, usdtFree * 0.98, baseFree * refBid * 0.98);
    if (!Number.isFinite(tradeUsd)) tradeUsd = config.spot.tradeUsd;
    const minCost = market.limits?.cost?.min || 5;
    if (tradeUsd < Math.max(minCost, 5)) {
      this.cooldownFor(c, 60_000);
      return;
    }

    const opp = edge.evaluateCrossExchange({
      symbol: c.symbol,
      buySnap,
      sellSnap,
      tradeUsd,
      buyFee: buyEx.fees_.spotTaker,
      sellFee: sellEx.fees_.spotTaker,
      detectedAt: c.detectedAt ?? t0,
      maxSpreadPct: config.spot.maxSpreadPct,
    });
    this.open.push(opp);
    state.opportunitiesSeen++;

    const m = opp.measurements || {};
    const line =
      `${c.symbol} ${c.buyId}->${c.sellId} | bruto ${pct(m.grossSpreadPct ?? c.grossPct)} | ` +
      `net edge ${m.netBps !== undefined ? m.netBps.toFixed(1) + 'bps' : 'n/a'} | conf ${opp.confidence ?? 'n/a'} | ${opp.status}`;

    recordOpportunity({
      strategy: 'spot',
      symbol: c.symbol,
      dir: `${c.buyId}->${c.sellId}`,
      grossPct: m.grossSpreadPct ?? c.grossPct,
      netPct: m.netEdgePct,
      netUsd: m.netUsd,
      netBps: m.netBps,
      confidence: opp.confidence,
      regime: opp.regime,
      status: opp.status,
      reasonCode: opp.reasonCode,
      explanation: opp.explanation,
      latencyMs: m.latencyMs,
      slippageBps: m.conservativeSlippageBps,
      fillProbability: m.fillProbability,
      id: opp.id,
      expiresAt: opp.expiresAt,
    });

    if (opp.status === 'REJECTED') {
      log.debug(`rejeitada [${opp.reasonCode}]: ${line}`);
      this.cooldownFor(c, 3000);
      return;
    }

    log.info(`VALIDADA: ${line}`);

    // RESEARCH MODE: só mede sinais, nunca executa (nem paper)
    if (config.lab.researchMode) {
      opp.status = 'SIMULATED';
      emit('strategy_event', 'spot', { kind: 'research_observed', id: opp.id });
      return;
    }

    // MANUAL APPROVAL: fica na fila até o utilizador clicar EXECUTE/IGNORAR no painel
    if (config.lab.manualApproval) {
      opp.status = 'PENDING_APPROVAL';
      approvals.add(opp, () => this.executeOpp(opp, c, buyEx, sellEx, m, tradeUsd));
      emit('approval_pending', 'spot', { id: opp.id, symbol: c.symbol, netUsd: m.netUsd, confidence: opp.confidence });
      log.info(`PENDENTE APROVAÇÃO: ${line}`);
      return;
    }

    return this.executeOpp(opp, c, buyEx, sellEx, m, tradeUsd);
  }

  /** Executa uma oportunidade validada — caminho LIVE ou PAPER (aprovada ou automática). */
  async executeOpp(opp, c, buyEx, sellEx, m, tradeUsd) {
    if (config.live) {
      const blocked = tradingBlockedReason();
      if (blocked) {
        log.warn(`oportunidade ignorada (${blocked}): ${line}`);
        return;
      }
      const amount = Number(buyEx.amountToPrecision(c.symbol, m.amount));
      const result = await executeSpotArb({
        buyEx,
        sellEx,
        symbol: c.symbol,
        amount,
        buyLimit: m.buyVwap * (1 + config.spot.iocPriceTolPct),
        sellLimit: m.sellVwap * (1 - config.spot.iocPriceTolPct),
        evaluation: { buyPrice: m.buyVwap, sellPrice: m.sellVwap, net: m.netUsd, netPct: m.netEdgePct, grossPct: m.grossSpreadPct },
      });
      opp.status = result.ok ? 'FILLED' : 'FAILED';
      state.spotTrades++;
      recordTrade({
        strategy: 'spot',
        symbol: c.symbol,
        buy: c.buyId,
        sell: c.sellId,
        amount,
        expectedNetUsd: m.netUsd,
        pnlUsd: result.pnlUsd,
        ok: result.ok,
        detail: result.detail,
        confidence: opp.confidence,
        regime: opp.regime,
      });
      save();
      this.cooldownFor(c, config.spot.cooldownMs);
      this.balancesAt = 0;
      const msg = `💰 SPOT ${c.symbol}: ${buyEx.label}→${sellEx.label} ${usd(tradeUsd)} | P&L ${usd(result.pnlUsd, 3)} (esperado ${usd(m.netUsd, 3)})${result.ok ? '' : ' ⚠️ FALHA'}`;
      log.info(msg);
      if (config.live || !result.ok) notify(msg);
      return;
    }

    // PAPER TRADING (modo por defeito): execução simulada com fills parciais
    const tr = paper.execute(opp);
    opp.status = tr.status === 'FAILED' ? 'FAILED' : 'FILLED';
    state.spotTrades++;
    recordTrade({
      strategy: 'spot',
      mode: 'paper',
      symbol: c.symbol,
      buy: c.buyId,
      sell: c.sellId,
      amount: tr.quantity,
      expectedNetUsd: m.netUsd,
      pnlUsd: tr.netPnL,
      ok: tr.status !== 'FAILED',
      detail: `paper ${tr.status} fill=${(tr.fillRatio * 100).toFixed(0)}% conf=${opp.confidence}`,
      confidence: opp.confidence,
      regime: opp.regime,
    });
    save();
    this.cooldownFor(c, config.spot.cooldownMs);
    this.balancesAt = 0;
    log.info(`🧪 PAPER ${c.symbol}: ${buyEx.label}→${sellEx.label} fill=${(tr.fillRatio * 100).toFixed(0)}% net=${usd(tr.netPnL, 3)} conf=${opp.confidence}${tr.status === 'FAILED' ? ' ⚠️ FALHOU' : ''}`);
  }
}
