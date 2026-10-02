import ccxt from 'ccxt';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { createMockExchange } from './mock.js';

const log = createLogger('exchanges');

export const LABELS = { bybit: 'Bybit', binance: 'Binance', okx: 'OKX', kucoin: 'KuCoin' };

export const EXCHANGE_IDS = config.exchanges;

function buildReal(id) {
  const c = config[id];
  const opts = {
    apiKey: c.apiKey || undefined,
    secret: c.secret || undefined,
    password: c.password || undefined,
    enableRateLimit: true,
    timeout: 10_000,
    options: {
      defaultType: 'spot',
      adjustForTimeDifference: true,
      recvWindow: 10_000,
      warnOnFetchOpenOrdersWithoutSymbol: false,
    },
  };
  const ex = new ccxt[id](opts);
  if (config.demo && c.apiKey && ex.has?.enableDemoTrading !== false) {
    try {
      ex.enableDemoTrading(true);
      log.info(`${id}: demo trading ativado`);
    } catch (e) {
      log.warn(`${id}: demo trading não suportado (${e.message})`);
    }
  }
  ex.fees_ = {
    spotMaker: c.spotMaker,
    spotTaker: c.spotTaker,
    swapMaker: c.swapMaker,
    swapTaker: c.swapTaker,
  };
  ex.label = LABELS[id] || id;
  ex.canTrade = Boolean(c.apiKey && c.secret && (!c.needsPassword || c.password));
  return ex;
}

/**
 * Cria as exchanges configuradas (config.exchanges). Em modo --sim devolve
 * mocks com dados sintéticos para testar a lógica sem rede.
 */
export async function createExchanges() {
  const result = {};
  for (const id of EXCHANGE_IDS) {
    result[id] = config.simulate ? createMockExchange(id, config[id]) : buildReal(id);
  }
  await Promise.all(
    EXCHANGE_IDS.map(async (id) => {
      const ex = result[id];
      const t0 = Date.now();
      try {
        await ex.loadMarkets();
      } catch (e) {
        if (/451|403|CloudFront|Unavailable For Legal Reasons|restricted location/i.test(e.message)) {
          throw new Error(
            `${ex.label}: API bloqueada para a região deste servidor (${e.message.slice(0, 120)}...). ` +
              'O robô tem de correr numa região onde a exchange opera — muda a região do deploy (ver README).',
          );
        }
        throw e;
      }
      const spot = Object.values(ex.markets).filter((m) => m.spot && m.active !== false).length;
      const swap = Object.values(ex.markets).filter((m) => m.swap && m.linear && m.active !== false).length;
      log.info(`${ex.label}: mercados carregados (${spot} spot, ${swap} perp lineares) em ${Date.now() - t0}ms`);
    }),
  );
  return result;
}

/** Símbolos spot presentes em TODAS as exchanges ativas. */
export function commonSpotSymbols(exs, wanted) {
  return wanted.filter((s) => EXCHANGE_IDS.every((id) => exs[id].markets[s]?.spot && exs[id].markets[s].active !== false));
}

/** Símbolos perp USDT lineares presentes em TODAS as exchanges ativas. */
export function commonSwapSymbols(exs, wanted = []) {
  const inAll = (s) => EXCHANGE_IDS.every((id) => {
    const m = exs[id].markets[s];
    return m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false;
  });
  if (wanted.length) return wanted.filter(inAll);
  return Object.keys(exs[EXCHANGE_IDS[0]].markets).filter(inAll);
}

/** Converte 'BTC/USDT' -> 'BTC/USDT:USDT' */
export function toSwapSymbol(spotSymbol) {
  return spotSymbol.includes(':') ? spotSymbol : `${spotSymbol}:USDT`;
}

/** Todos os pares ordenados (buyId, sellId) distintos entre as exchanges ativas. */
export function orderedPairs(ids = EXCHANGE_IDS) {
  const out = [];
  for (const a of ids) for (const b of ids) if (a !== b) out.push([a, b]);
  return out;
}

/** Todos os pares não ordenados {a, b} entre as exchanges ativas. */
export function unorderedPairs(ids = EXCHANGE_IDS) {
  const out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  return out;
}
