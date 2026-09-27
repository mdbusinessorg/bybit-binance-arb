import ccxt from 'ccxt';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { createMockExchange } from './mock.js';

const log = createLogger('exchanges');

export const EXCHANGE_IDS = ['bybit', 'binance'];

function buildReal(id) {
  const c = config[id];
  const opts = {
    apiKey: c.apiKey || undefined,
    secret: c.secret || undefined,
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
  if (config.demo && c.apiKey) {
    ex.enableDemoTrading(true);
    log.info(`${id}: demo trading ativado`);
  }
  ex.fees_ = {
    spotMaker: c.spotMaker,
    spotTaker: c.spotTaker,
    swapMaker: c.swapMaker,
    swapTaker: c.swapTaker,
  };
  ex.label = id === 'bybit' ? 'Bybit' : 'Binance';
  ex.canTrade = Boolean(c.apiKey && c.secret);
  return ex;
}

/**
 * Cria as duas exchanges (Bybit e Binance). Em modo --sim devolve mocks com
 * dados sintéticos para testar a lógica sem rede.
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

/** Símbolos spot presentes em ambas as exchanges. */
export function commonSpotSymbols(exs, wanted) {
  return wanted.filter((s) => EXCHANGE_IDS.every((id) => exs[id].markets[s]?.spot && exs[id].markets[s].active !== false));
}

/** Símbolos perp USDT lineares presentes em ambas as exchanges. */
export function commonSwapSymbols(exs, wanted = []) {
  const inBoth = (s) => EXCHANGE_IDS.every((id) => {
    const m = exs[id].markets[s];
    return m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false;
  });
  if (wanted.length) return wanted.filter(inBoth);
  return Object.keys(exs.bybit.markets).filter(inBoth);
}

/** Converte 'BTC/USDT' -> 'BTC/USDT:USDT' */
export function toSwapSymbol(spotSymbol) {
  return spotSymbol.includes(':') ? spotSymbol : `${spotSymbol}:USDT`;
}

export function other(id) {
  return id === 'bybit' ? 'binance' : 'bybit';
}
