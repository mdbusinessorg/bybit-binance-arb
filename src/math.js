/**
 * Funções puras de cálculo (testáveis sem rede).
 */

/**
 * Preço médio ponderado (VWAP) para consumir `amountBase` de um lado do livro.
 * levels: [[price, size], ...] já ordenado (asks crescente / bids decrescente).
 * Devolve { avgPrice, filled, cost } — filled pode ser < amountBase se faltar liquidez.
 */
export function vwapForAmount(levels, amountBase) {
  let remaining = amountBase;
  let cost = 0;
  let filled = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(size, remaining);
    cost += take * price;
    filled += take;
    remaining -= take;
  }
  return { avgPrice: filled > 0 ? cost / filled : null, filled, cost };
}

/**
 * VWAP para gastar `quoteUsd` (comprar com X USDT).
 */
export function vwapForQuote(levels, quoteUsd) {
  let remainingQuote = quoteUsd;
  let filled = 0;
  let cost = 0;
  for (const [price, size] of levels) {
    if (remainingQuote <= 0) break;
    const maxByQuote = remainingQuote / price;
    const take = Math.min(size, maxByQuote);
    cost += take * price;
    filled += take;
    remainingQuote -= take * price;
  }
  return { avgPrice: filled > 0 ? cost / filled : null, filled, cost };
}

/**
 * Lucro líquido de uma arbitragem spot cross-exchange, pré-financiada
 * (USDT na exchange de compra, moeda na exchange de venda — sem transferências).
 *
 * @param {object} p
 * @param {Array} p.buyAsks   asks da exchange onde compramos
 * @param {Array} p.sellBids  bids da exchange onde vendemos
 * @param {number} p.tradeUsd notional alvo em USDT
 * @param {number} p.buyFee   taxa taker da exchange de compra (fração)
 * @param {number} p.sellFee  taxa taker da exchange de venda (fração)
 * @param {number} p.slippageBuffer fração de segurança extra
 */
export function evaluateSpotArb({ buyAsks, sellBids, tradeUsd, buyFee, sellFee, slippageBuffer = 0 }) {
  const buy = vwapForQuote(buyAsks, tradeUsd);
  if (!buy.avgPrice || buy.filled <= 0) return null;
  const amount = buy.filled;
  const sell = vwapForAmount(sellBids, amount);
  if (!sell.avgPrice || sell.filled < amount * 0.999) {
    return { ok: false, reason: 'liquidez insuficiente no lado da venda', amount };
  }
  const buyCost = buy.cost;
  const sellProceeds = sell.cost;
  const fees = buyCost * buyFee + sellProceeds * sellFee;
  const buffer = buyCost * slippageBuffer;
  const gross = sellProceeds - buyCost;
  const net = gross - fees - buffer;
  const grossPct = gross / buyCost;
  const netPct = net / buyCost;
  return {
    ok: true,
    amount,
    buyPrice: buy.avgPrice,
    sellPrice: sell.avgPrice,
    buyCost,
    sellProceeds,
    fees,
    buffer,
    gross,
    grossPct,
    net,
    netPct,
  };
}

/**
 * Normaliza uma taxa de funding para um intervalo de 8h.
 * intervalHours: 1, 4 ou 8 tipicamente.
 */
export function normalizeFundingTo8h(rate, intervalHours) {
  if (!intervalHours || intervalHours <= 0) return rate;
  return rate * (8 / intervalHours);
}

/**
 * Avalia arbitragem de funding entre duas exchanges (long perp numa, short perp na outra).
 *
 * Convenção: funding positivo => longs pagam shorts.
 * Queremos SHORT onde funding é MAIOR e LONG onde funding é MENOR.
 *
 * @param {object} p
 * @param {number} p.rateA8h  funding 8h normalizado na exchange A
 * @param {number} p.rateB8h  funding 8h normalizado na exchange B
 * @param {number} p.priceA   preço (mark/last) na A
 * @param {number} p.priceB   preço na B
 * @param {number} p.feeA     taxa por ordem na A (fração) — entrada e saída
 * @param {number} p.feeB     taxa por ordem na B
 * @param {number} p.expectedHoldHours horas que esperamos manter a posição
 */
export function evaluateFundingArb({ rateA8h, rateB8h, priceA, priceB, feeA, feeB, expectedHoldHours = 24 }) {
  const spread8h = Math.abs(rateA8h - rateB8h);
  // short onde o funding é maior (recebemos), long onde é menor (pagamos menos/recebemos)
  const shortOn = rateA8h > rateB8h ? 'A' : 'B';
  const longOn = shortOn === 'A' ? 'B' : 'A';
  const shortPrice = shortOn === 'A' ? priceA : priceB;
  const longPrice = longOn === 'A' ? priceA : priceB;
  // basis: se compramos (long) mais caro do que vendemos (short) perdemos isto ao fechar quando convergir
  const basisPct = (longPrice - shortPrice) / shortPrice;
  // 4 ordens no total: abrir long, abrir short, fechar long, fechar short
  const roundTripFeesPct = 2 * feeA + 2 * feeB;
  const periods = expectedHoldHours / 8;
  const grossPct = spread8h * periods;
  const netPct = grossPct - roundTripFeesPct - Math.max(0, basisPct);
  const netAprPct = expectedHoldHours > 0 ? netPct * (365 * 24 / expectedHoldHours) : 0;
  const grossAprPct = spread8h * 3 * 365;
  const breakEvenHours = spread8h > 0 ? ((roundTripFeesPct + Math.max(0, basisPct)) / spread8h) * 8 : Infinity;
  return {
    spread8h,
    shortOn,
    longOn,
    basisPct,
    roundTripFeesPct,
    grossPct,
    netPct,
    grossAprPct,
    netAprPct,
    breakEvenHours,
  };
}

/**
 * Avalia uma rota de arbitragem triangular dentro de UMA exchange
 * (ex.: USDT -> X -> BTC -> USDT). As pernas executam em sequência;
 * a saída de cada uma alimenta a próxima.
 *
 * @param {object} p
 * @param {number} p.startUsd   quantidade inicial na moeda de partida (USDT)
 * @param {number} p.feeTaker   taxa taker por perna (fração)
 * @param {number} p.slippageBuffer margem extra (fração do startUsd)
 * @param {Array}  p.legs [{ symbol, side, asks?, bids? }]
 *   side 'buy'  -> gasta quote e recebe base (usa asks)
 *   side 'sell' -> gasta base e recebe quote (usa bids)
 * @returns {{ok:boolean, outUsd?:number, net?:number, netPct?:number, legs?:Array, reason?:string}}
 */
export function evaluateTriangleRoute({ startUsd, feeTaker, slippageBuffer = 0, legs }) {
  let amount = startUsd; // unidades da moeda de input da próxima perna (primeira = USDT)
  const outLegs = [];
  for (const leg of legs) {
    if (leg.side === 'buy') {
      const r = vwapForQuote(leg.asks, amount);
      if (!r.avgPrice || r.cost < amount * 0.98) {
        return { ok: false, reason: `liquidez insuficiente em ${leg.symbol} (buy)` };
      }
      const received = r.filled * (1 - feeTaker);
      outLegs.push({ ...leg, spent: r.cost, received, price: r.avgPrice });
      amount = received;
    } else {
      const r = vwapForAmount(leg.bids, amount);
      if (!r.avgPrice || r.filled < amount * 0.999) {
        return { ok: false, reason: `liquidez insuficiente em ${leg.symbol} (sell)` };
      }
      const received = r.cost * (1 - feeTaker);
      outLegs.push({ ...leg, spent: r.filled, received, price: r.avgPrice });
      amount = received;
    }
  }
  const gross = amount - startUsd;
  const buffer = startUsd * slippageBuffer;
  const net = gross - buffer;
  return { ok: true, outUsd: amount, gross, buffer, net, netPct: net / startUsd, legs: outLegs };
}

export function pct(x, digits = 3) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(digits)}%`;
}

export function usd(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  return `${x >= 0 ? '' : '-'}$${Math.abs(x).toFixed(digits)}`;
}
