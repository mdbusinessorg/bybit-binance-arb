/**
 * Exchange simulada (modo --sim). Gera preços sintéticos com pequenas
 * divergências entre exchanges e funding rates aleatórios para exercitar
 * toda a lógica do robô sem rede nem chaves.
 */

const BASE_PRICES = {
  BTC: 84_000, ETH: 3_200, SOL: 150, XRP: 2.1, DOGE: 0.18, ADA: 0.72, AVAX: 28,
  LINK: 17, DOT: 5.5, LTC: 95, TON: 4.2, SUI: 2.4, APT: 7.8, ARB: 0.6, OP: 1.3,
  NEAR: 4.1, PEPE: 0.0000095, WIF: 0.9, TIA: 3.6, SEI: 0.31,
};

// estado partilhado entre as duas mocks para que os preços tenham a mesma referência
const shared = { mid: { ...BASE_PRICES }, tick: 0, nextFunding: {} };

function rnd(a, b) {
  return a + Math.random() * (b - a);
}

function precisionFor(price) {
  if (price > 1000) return { amount: 5, price: 2 };
  if (price > 10) return { amount: 3, price: 3 };
  if (price > 0.01) return { amount: 1, price: 5 };
  return { amount: 0, price: 9 };
}

export function createMockExchange(id, feeCfg) {
  const label = id === 'bybit' ? 'Bybit' : 'Binance';
  // enviesamento persistente por exchange para gerar spreads que às vezes excedem as taxas
  const bias = {};
  const funding = {};
  const balances = { USDT: { free: 1000, used: 0, total: 1000 } };
  for (const base of Object.keys(BASE_PRICES)) {
    bias[base] = 0;
    funding[base] = ['SOL', 'DOGE', 'WIF', 'PEPE'].includes(base) ? rnd(0.0003, 0.0012) : rnd(-0.0002, 0.0004);
    balances[base] = { free: 200 / BASE_PRICES[base], used: 0, total: 200 / BASE_PRICES[base] };
  }
  const positions = {};
  const orders = new Map();
  let orderSeq = 0;

  const markets = {};
  for (const base of Object.keys(BASE_PRICES)) {
    const p = precisionFor(BASE_PRICES[base]);
    markets[`${base}/USDT`] = {
      id: `${base}USDT`, symbol: `${base}/USDT`, base, quote: 'USDT', spot: true, swap: false, active: true,
      precision: p, limits: { amount: { min: 0 }, cost: { min: 5 } }, created: Date.now() - 400 * 86_400_000, info: {},
    };
    markets[`${base}/USDT:USDT`] = {
      id: `${base}USDT`, symbol: `${base}/USDT:USDT`, base, quote: 'USDT', settle: 'USDT', spot: false, swap: true,
      linear: true, active: true, contractSize: 1, precision: p, limits: { amount: { min: 0 }, cost: { min: 5 } },
      settle: 'USDT', created: Date.now() - (base === 'SEI' ? 3 : 400) * 86_400_000,
      info: { fundingInterval: ['SUI', 'SEI', 'WIF'].includes(base) && id === 'bybit' ? '240' : '480', deliveryTime: base === 'TIA' ? String(Date.now() + 5 * 86_400_000) : '0' },
    };
  }

  function step() {
    shared.tick++;
    for (const base of Object.keys(BASE_PRICES)) {
      shared.mid[base] *= 1 + rnd(-0.0008, 0.0008);
      // bias segue um processo de reversão à média com choques ocasionais
      bias[base] = bias[base] * 0.9 + rnd(-0.0003, 0.0003);
      if (Math.random() < 0.02) bias[base] += rnd(-0.006, 0.006);
      if (Math.random() < 0.05) funding[base] = Math.max(-0.002, Math.min(0.003, funding[base] + rnd(-0.0003, 0.0003)));
    }
  }

  function mid(base) {
    return shared.mid[base] * (1 + bias[base]);
  }

  function book(symbol, limit = 20) {
    const m = markets[symbol];
    const px = mid(m.base);
    const halfSpread = px * 0.0002;
    const bids = [];
    const asks = [];
    let bp = px - halfSpread;
    let ap = px + halfSpread;
    for (let i = 0; i < limit; i++) {
      const size = (rnd(500, 5000) / px) * (1 + i * 0.3);
      bids.push([bp, size]);
      asks.push([ap, size]);
      bp *= 1 - rnd(0.00005, 0.0002);
      ap *= 1 + rnd(0.00005, 0.0002);
    }
    return { symbol, bids, asks, timestamp: Date.now(), datetime: new Date().toISOString(), nonce: shared.tick };
  }

  const ex = {
    id,
    label,
    canTrade: true,
    markets,
    fees_: {
      spotMaker: feeCfg.spotMaker,
      spotTaker: feeCfg.spotTaker,
      swapMaker: feeCfg.swapMaker,
      swapTaker: feeCfg.swapTaker,
    },
    async loadMarkets() {
      return markets;
    },
    market(symbol) {
      const m = markets[symbol];
      if (!m) throw new Error(`${label}: mercado desconhecido ${symbol}`);
      return m;
    },
    amountToPrecision(symbol, amount) {
      return Number(amount).toFixed(markets[symbol].precision.amount);
    },
    priceToPrecision(symbol, price) {
      return Number(price).toFixed(markets[symbol].precision.price);
    },
    async fetchBidsAsks(symbols) {
      if (id === 'bybit') step();
      const out = {};
      for (const s of symbols) {
        const b = book(s, 1);
        out[s] = { symbol: s, bid: b.bids[0][0], ask: b.asks[0][0], bidVolume: b.bids[0][1], askVolume: b.asks[0][1], timestamp: Date.now() };
      }
      return out;
    },
    async fetchOrderBook(symbol, limit = 20) {
      return book(symbol, limit);
    },
    async fetchTickers(symbols) {
      const out = {};
      const list = symbols || Object.keys(markets);
      for (const s of list) {
        const m = markets[s];
        const px = mid(m.base);
        out[s] = { symbol: s, last: px, bid: px * 0.9998, ask: px * 1.0002, quoteVolume: rnd(2e6, 5e8), timestamp: Date.now(), info: m.swap && id === 'bybit' ? { openInterestValue: String(rnd(5e6, 5e8)) } : {} };
      }
      return out;
    },
    async fetchFundingRates(symbols) {
      const out = {};
      const list = symbols || Object.keys(markets).filter((s) => markets[s].swap);
      for (const s of list) {
        const m = markets[s];
        const interval = id === 'bybit' && ['SUI', 'SEI', 'WIF'].includes(m.base) ? '4h' : '8h';
        out[s] = {
          symbol: s,
          fundingRate: funding[m.base] * (id === 'binance' ? rnd(0.3, 1.2) : 1),
          markPrice: mid(m.base),
          indexPrice: shared.mid[m.base],
          interval,
          // settlement sintético: cada símbolo tem o seu próximo settlement entre 5 e 120 min
          fundingTimestamp: shared.nextFunding[m.base] || (shared.nextFunding[m.base] = Date.now() + rnd(5, 120) * 60_000),
          timestamp: Date.now(),
        };
      }
      return out;
    },
    async fetchBalance(params = {}) {
      const out = { free: {}, used: {}, total: {} };
      for (const [k, v] of Object.entries(balances)) {
        out[k] = v;
        out.free[k] = v.free;
        out.used[k] = v.used;
        out.total[k] = v.total;
      }
      return out;
    },
    async setLeverage() {
      return {};
    },
    async setMarginMode() {
      return {};
    },
    async createOrder(symbol, type, side, amount, price, params = {}) {
      const m = markets[symbol];
      const b = book(symbol, 20);
      const levels = side === 'buy' ? b.asks : b.bids;
      let remaining = Number(amount);
      let cost = 0;
      let filled = 0;
      for (const [lp, ls] of levels) {
        if (remaining <= 0) break;
        if (type === 'limit' && price !== undefined) {
          if (side === 'buy' && lp > price) break;
          if (side === 'sell' && lp < price) break;
        }
        const take = Math.min(ls, remaining);
        cost += take * lp;
        filled += take;
        remaining -= take;
      }
      const feeRate = m.swap ? ex.fees_.swapTaker : ex.fees_.spotTaker;
      const fee = cost * feeRate;
      if (m.spot) {
        if (side === 'buy') {
          balances.USDT.free -= cost + fee;
          balances[m.base].free += filled;
        } else {
          balances[m.base].free -= filled;
          balances.USDT.free += cost - fee;
        }
        balances.USDT.total = balances.USDT.free;
        balances[m.base].total = balances[m.base].free;
      } else {
        const reduceOnly = params.reduceOnly === true;
        const cur = positions[symbol] || { contracts: 0, side: null, entryPrice: 0 };
        const signed = (side === 'buy' ? 1 : -1) * filled;
        const curSigned = (cur.side === 'short' ? -1 : 1) * cur.contracts;
        const newSigned = curSigned + signed;
        if (newSigned === 0 || reduceOnly && Math.abs(newSigned) < 1e-12) {
          delete positions[symbol];
        } else {
          positions[symbol] = {
            symbol,
            contracts: Math.abs(newSigned),
            side: newSigned > 0 ? 'long' : 'short',
            entryPrice: filled > 0 ? cost / filled : cur.entryPrice,
            notional: Math.abs(newSigned) * mid(m.base),
            markPrice: mid(m.base),
            leverage: 2,
            marginRatio: 0.05,
          };
        }
        balances.USDT.free -= fee;
        balances.USDT.total = balances.USDT.free;
      }
      const order = {
        id: String(++orderSeq),
        symbol,
        type,
        side,
        amount: Number(amount),
        price: price ?? null,
        average: filled > 0 ? cost / filled : null,
        filled,
        remaining,
        cost,
        status: remaining > 1e-12 ? 'canceled' : 'closed',
        fee: { cost: fee, currency: 'USDT' },
        timestamp: Date.now(),
      };
      orders.set(order.id, order);
      return order;
    },
    async fetchOrder(orderId) {
      return orders.get(orderId);
    },
    async fetchPositions(symbols) {
      const list = Object.values(positions).map((p) => {
        const m = markets[p.symbol];
        const mk = mid(m.base);
        const dir = p.side === 'long' ? 1 : -1;
        return { ...p, markPrice: mk, notional: p.contracts * mk, unrealizedPnl: dir * (mk - p.entryPrice) * p.contracts };
      });
      return symbols ? list.filter((p) => symbols.includes(p.symbol)) : list;
    },
    async fetchFundingHistory() {
      return [];
    },
    async fetchFundingRateHistory(symbol, since = Date.now() - 86_400_000) {
      const m = markets[symbol];
      const hours = ['SUI', 'SEI', 'WIF'].includes(m.base) && id === 'bybit' ? 4 : 8;
      const out = [];
      for (let t = since; t < Date.now(); t += hours * 3600_000) {
        out.push({ symbol, fundingRate: funding[m.base] * (hours / 8) * rnd(0.7, 1.3), timestamp: t });
      }
      return out;
    },
    async fetchOpenInterest(symbol) {
      const m = markets[symbol];
      const value = m.base === 'WIF' ? 500_000 : rnd(5e6, 5e8);
      return { symbol, openInterestAmount: value / mid(m.base), openInterestValue: id === 'bybit' ? value : undefined };
    },
  };
  return ex;
}
