import { config } from './config.js';
import { createLogger } from './logger.js';
import { recordFailure, recordSuccess } from './risk.js';

const log = createLogger('exec');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function feeOf(order, fallbackRate) {
  if (order?.fee && Number.isFinite(order.fee.cost) && order.fee.currency === 'USDT') return order.fee.cost;
  if (Array.isArray(order?.fees) && order.fees.length) {
    const usdt = order.fees.filter((f) => f.currency === 'USDT').reduce((a, f) => a + (f.cost || 0), 0);
    if (usdt > 0) return usdt;
  }
  return (order?.cost || 0) * fallbackRate;
}

async function ensureFinal(ex, order, symbol, waitMs = 3000) {
  // ordens IOC/market fecham imediatamente; algumas exchanges devolvem status 'open' na resposta
  let o = order;
  const t0 = Date.now();
  while (o && (o.status === 'open' || o.filled === undefined) && Date.now() - t0 < waitMs) {
    await sleep(300);
    try {
      o = await ex.fetchOrder(order.id, symbol);
    } catch (e) {
      log.debug(`${ex.label} fetchOrder falhou: ${e.message}`);
    }
  }
  return o || order;
}

/**
 * Ordem IOC limitada (executa o que conseguir ao preço-limite ou melhor, cancela o resto).
 */
async function placeIoc(ex, symbol, side, amount, limitPrice) {
  const amt = ex.amountToPrecision(symbol, amount);
  const px = ex.priceToPrecision(symbol, limitPrice);
  const order = await ex.createOrder(symbol, 'limit', side, Number(amt), Number(px), { timeInForce: 'IOC' });
  return ensureFinal(ex, order, symbol);
}

async function placeMarket(ex, symbol, side, amount, params = {}) {
  const amt = ex.amountToPrecision(symbol, amount);
  const order = await ex.createOrder(symbol, 'market', side, Number(amt), undefined, params);
  return ensureFinal(ex, order, symbol);
}

/**
 * Executa as duas pernas de uma arbitragem spot em simultâneo (compra na A, venda na B).
 * Se uma perna ficar parcialmente executada e a outra não, desfaz o excesso a mercado.
 *
 * @returns {Promise<{ok:boolean, pnlUsd:number, detail:object}>}
 */
export async function executeSpotArb({ buyEx, sellEx, symbol, amount, buyLimit, sellLimit, evaluation }) {
  const buyFee = buyEx.fees_.spotTaker;
  const sellFee = sellEx.fees_.spotTaker;

  if (!config.live) {
    // dry-run / sim: assume execução ao VWAP calculado
    const pnl = evaluation.gross - evaluation.fees;
    return {
      ok: true,
      pnlUsd: pnl,
      detail: { simulated: true, amount, buyPrice: evaluation.buyPrice, sellPrice: evaluation.sellPrice, fees: evaluation.fees },
    };
  }

  const t0 = Date.now();
  const [buyRes, sellRes] = await Promise.allSettled([
    placeIoc(buyEx, symbol, 'buy', amount, buyLimit),
    placeIoc(sellEx, symbol, 'sell', amount, sellLimit),
  ]);
  const latency = Date.now() - t0;

  const buyOrder = buyRes.status === 'fulfilled' ? buyRes.value : null;
  const sellOrder = sellRes.status === 'fulfilled' ? sellRes.value : null;
  if (buyRes.status === 'rejected') log.error(`${buyEx.label} compra falhou: ${buyRes.reason?.message}`);
  if (sellRes.status === 'rejected') log.error(`${sellEx.label} venda falhou: ${sellRes.reason?.message}`);

  let boughtAmt = buyOrder?.filled || 0;
  let soldAmt = sellOrder?.filled || 0;
  let buyCost = buyOrder?.cost || boughtAmt * (buyOrder?.average || buyLimit);
  let sellProceeds = sellOrder?.cost || soldAmt * (sellOrder?.average || sellLimit);
  let fees = feeOf(buyOrder, buyFee) + feeOf(sellOrder, sellFee);
  const unwinds = [];

  const mismatch = boughtAmt - soldAmt;
  const tol = amount * config.spot.legMismatchTolPct;
  if (Math.abs(mismatch) > tol) {
    try {
      if (mismatch > 0) {
        // comprámos mais do que vendemos -> vender excesso na exchange de compra
        log.warn(`${symbol}: desfazer excesso comprado ${mismatch} em ${buyEx.label}`);
        const u = await placeMarket(buyEx, symbol, 'sell', mismatch);
        unwinds.push({ ex: buyEx.id, side: 'sell', filled: u.filled, cost: u.cost });
        sellProceeds += u.cost || 0;
        soldAmt += u.filled || 0;
        fees += feeOf(u, buyFee);
      } else {
        // vendemos mais do que comprámos -> recomprar excesso na exchange de venda
        log.warn(`${symbol}: recomprar excesso vendido ${-mismatch} em ${sellEx.label}`);
        const u = await placeMarket(sellEx, symbol, 'buy', -mismatch);
        unwinds.push({ ex: sellEx.id, side: 'buy', filled: u.filled, cost: u.cost });
        buyCost += u.cost || 0;
        boughtAmt += u.filled || 0;
        fees += feeOf(u, sellFee);
      }
    } catch (e) {
      log.error(`${symbol}: falha ao desfazer perna (${e.message}) — POSIÇÃO DESEQUILIBRADA, verificar manualmente`);
      recordFailure(e);
      return {
        ok: false,
        pnlUsd: sellProceeds - buyCost - fees,
        detail: { boughtAmt, soldAmt, buyCost, sellProceeds, fees, unwinds, latency, error: e.message, unbalanced: true },
      };
    }
  }

  const pnlUsd = sellProceeds - buyCost - fees;
  const ok = boughtAmt > 0 && soldAmt > 0;
  if (ok) recordSuccess();
  else recordFailure(new Error('nenhuma perna executada'));
  return {
    ok,
    pnlUsd,
    detail: { boughtAmt, soldAmt, buyCost, sellProceeds, fees, unwinds, latency, buyOrderId: buyOrder?.id, sellOrderId: sellOrder?.id },
  };
}

/**
 * Tenta entrar como maker (post-only ao melhor preço) e cai para mercado se não executar a tempo.
 */
async function placeMakerThenMarket(ex, symbol, side, amount, params = {}) {
  if (!config.funding.useMakerEntry) return placeMarket(ex, symbol, side, amount, params);
  const ob = await ex.fetchOrderBook(symbol, 5);
  const px = side === 'buy' ? ob.bids[0][0] : ob.asks[0][0];
  let order;
  try {
    order = await ex.createOrder(symbol, 'limit', side, Number(ex.amountToPrecision(symbol, amount)), Number(ex.priceToPrecision(symbol, px)), {
      ...params,
      postOnly: true,
    });
  } catch (e) {
    log.debug(`${ex.label} post-only rejeitada (${e.message}); a usar mercado`);
    return placeMarket(ex, symbol, side, amount, params);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    order = await ex.fetchOrder(order.id, symbol);
    if (order.status === 'closed') return order;
  }
  try {
    await ex.cancelOrder(order.id, symbol);
  } catch {}
  order = await ex.fetchOrder(order.id, symbol);
  const remaining = amount - (order.filled || 0);
  if (remaining > 0) {
    const m = await placeMarket(ex, symbol, side, remaining, params);
    return {
      ...m,
      filled: (order.filled || 0) + (m.filled || 0),
      cost: (order.cost || 0) + (m.cost || 0),
      fee: { currency: 'USDT', cost: feeOf(order, ex.fees_.swapMaker) + feeOf(m, ex.fees_.swapTaker) },
    };
  }
  return order;
}

/**
 * Abre posição delta-neutra: long perp em `longEx`, short perp em `shortEx`, mesma quantidade.
 */
export async function openFundingPosition({ longEx, shortEx, symbol, contracts, prices }) {
  if (!config.live) {
    const fees = contracts * (prices.long * longEx.fees_.swapTaker + prices.short * shortEx.fees_.swapTaker);
    return { ok: true, contracts, longPrice: prices.long, shortPrice: prices.short, fees, simulated: true };
  }
  for (const ex of [longEx, shortEx]) {
    try {
      await ex.setLeverage(config.funding.leverage, symbol);
    } catch (e) {
      if (!/not modified|110043|leverage/i.test(e.message)) log.warn(`${ex.label} setLeverage: ${e.message}`);
    }
  }
  const [l, s] = await Promise.allSettled([
    placeMakerThenMarket(longEx, symbol, 'buy', contracts),
    placeMakerThenMarket(shortEx, symbol, 'sell', contracts),
  ]);
  const longOrder = l.status === 'fulfilled' ? l.value : null;
  const shortOrder = s.status === 'fulfilled' ? s.value : null;
  if (l.status === 'rejected') log.error(`${longEx.label} long falhou: ${l.reason?.message}`);
  if (s.status === 'rejected') log.error(`${shortEx.label} short falhou: ${s.reason?.message}`);

  const lf = longOrder?.filled || 0;
  const sf = shortOrder?.filled || 0;
  let fees = feeOf(longOrder, longEx.fees_.swapTaker) + feeOf(shortOrder, shortEx.fees_.swapTaker);

  const diff = lf - sf;
  if (Math.abs(diff) > contracts * config.spot.legMismatchTolPct) {
    try {
      if (diff > 0) {
        log.warn(`${symbol}: reduzir long em excesso ${diff} (${longEx.label})`);
        const u = await placeMarket(longEx, symbol, 'sell', diff, { reduceOnly: true });
        fees += feeOf(u, longEx.fees_.swapTaker);
      } else {
        log.warn(`${symbol}: reduzir short em excesso ${-diff} (${shortEx.label})`);
        const u = await placeMarket(shortEx, symbol, 'buy', -diff, { reduceOnly: true });
        fees += feeOf(u, shortEx.fees_.swapTaker);
      }
    } catch (e) {
      recordFailure(e);
      return { ok: false, error: `pernas desequilibradas e falha ao corrigir: ${e.message}`, longFilled: lf, shortFilled: sf, unbalanced: true };
    }
  }
  const finalContracts = Math.min(lf, sf);
  if (finalContracts <= 0) {
    recordFailure(new Error('nenhuma perna executada'));
    return { ok: false, error: 'nenhuma perna executada', fees };
  }
  recordSuccess();
  return {
    ok: true,
    contracts: finalContracts,
    longPrice: longOrder?.average || prices.long,
    shortPrice: shortOrder?.average || prices.short,
    fees,
    longOrderId: longOrder?.id,
    shortOrderId: shortOrder?.id,
  };
}

/**
 * Fecha posição delta-neutra com ordens reduce-only a mercado em ambas as exchanges.
 */
export async function closeFundingPosition({ longEx, shortEx, symbol, contracts, prices }) {
  if (!config.live) {
    const fees = contracts * (prices.long * longEx.fees_.swapTaker + prices.short * shortEx.fees_.swapTaker);
    return { ok: true, longPrice: prices.long, shortPrice: prices.short, fees, simulated: true };
  }
  const [l, s] = await Promise.allSettled([
    placeMarket(longEx, symbol, 'sell', contracts, { reduceOnly: true }),
    placeMarket(shortEx, symbol, 'buy', contracts, { reduceOnly: true }),
  ]);
  const longOrder = l.status === 'fulfilled' ? l.value : null;
  const shortOrder = s.status === 'fulfilled' ? s.value : null;
  const errors = [l, s].filter((r) => r.status === 'rejected').map((r) => r.reason?.message);
  if (errors.length) {
    recordFailure(new Error(errors.join(' | ')));
    log.error(`${symbol}: fecho parcial — ${errors.join(' | ')} — VERIFICAR MANUALMENTE`);
  } else {
    recordSuccess();
  }
  return {
    ok: errors.length === 0,
    longPrice: longOrder?.average || prices.long,
    shortPrice: shortOrder?.average || prices.short,
    fees: feeOf(longOrder, longEx.fees_.swapTaker) + feeOf(shortOrder, shortEx.fees_.swapTaker),
    errors,
  };
}
