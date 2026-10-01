import 'dotenv/config';

const argv = new Set(process.argv.slice(2));

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variável ${name} inválida: "${v}"`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase());
}

function list(name, def) {
  const v = process.env[name];
  if (!v) return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const LIVE = argv.has('--live') || bool('LIVE', false);
const SIMULATE = argv.has('--sim') || bool('SIMULATE', false);

export const config = {
  live: LIVE && !SIMULATE,
  simulate: SIMULATE,
  demo: bool('DEMO_TRADING', false),
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir: process.env.DATA_DIR || './data',
  // exchanges ativas: 'bybit,binance' (arbitragem cross-exchange) ou só 'bybit' (cash-and-carry)
  exchanges: list('EXCHANGES', ['bybit', 'binance']).map((s) => s.toLowerCase()).filter((s) => ['bybit', 'binance'].includes(s)),

  bybit: {
    apiKey: process.env.BYBIT_API_KEY || '',
    secret: process.env.BYBIT_API_SECRET || '',
    // VIP0 crypto-crypto spot: 0.10% / 0.10% ; USDT perp: 0.02% maker / 0.055% taker
    spotMaker: num('BYBIT_SPOT_MAKER_FEE', 0.001),
    spotTaker: num('BYBIT_SPOT_TAKER_FEE', 0.001),
    swapMaker: num('BYBIT_SWAP_MAKER_FEE', 0.0002),
    swapTaker: num('BYBIT_SWAP_TAKER_FEE', 0.00055),
  },
  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    secret: process.env.BINANCE_API_SECRET || '',
    // VIP0 spot: 0.10% (0.075% com desconto BNB) ; USDT-M perp: 0.02% maker / 0.05% taker (0.045% c/ BNB)
    spotMaker: num('BINANCE_SPOT_MAKER_FEE', 0.001),
    spotTaker: num('BINANCE_SPOT_TAKER_FEE', 0.001),
    swapMaker: num('BINANCE_SWAP_MAKER_FEE', 0.0002),
    swapTaker: num('BINANCE_SWAP_TAKER_FEE', 0.0005),
  },

  spot: {
    enabled: bool('SPOT_ARB_ENABLED', true),
    symbols: list('SPOT_SYMBOLS', [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT',
      'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'LTC/USDT',
      'TON/USDT', 'SUI/USDT', 'APT/USDT', 'ARB/USDT', 'OP/USDT',
      'NEAR/USDT', 'PEPE/USDT', 'WIF/USDT', 'TIA/USDT', 'SEI/USDT',
    ]),
    tradeUsd: num('SPOT_TRADE_USD', 50),
    minNetPct: num('SPOT_MIN_NET_PCT', 0.15) / 100,
    minNetUsd: num('SPOT_MIN_NET_USD', 0.05),
    slippageBufferPct: num('SPOT_SLIPPAGE_BUFFER_PCT', 0.03) / 100,
    pollMs: num('SPOT_POLL_MS', 1500),
    maxSpreadPct: num('SPOT_MAX_SPREAD_PCT', 3) / 100,
    iocPriceTolPct: num('SPOT_IOC_TOL_PCT', 0.05) / 100,
    legMismatchTolPct: num('SPOT_LEG_MISMATCH_TOL_PCT', 2) / 100,
    cooldownMs: num('SPOT_SYMBOL_COOLDOWN_MS', 10_000),
  },

  funding: {
    enabled: bool('FUNDING_ARB_ENABLED', true),
    symbols: list('FUNDING_SYMBOLS', []),
    positionUsd: num('FUNDING_POSITION_USD', 100),
    leverage: num('FUNDING_LEVERAGE', 2),
    minSpread8hPct: num('FUNDING_MIN_SPREAD_8H_PCT', 0.01) / 100,
    minNetAprPct: num('FUNDING_MIN_NET_APR_PCT', 15) / 100,
    exitSpread8hPct: num('FUNDING_EXIT_SPREAD_8H_PCT', 0.002) / 100,
    exitConfirmations: num('FUNDING_EXIT_CONFIRMATIONS', 3),
    maxHoldHours: num('FUNDING_MAX_HOLD_HOURS', 72),
    expectedHoldHours: num('FUNDING_EXPECTED_HOLD_HOURS', 24),
    maxBasisPct: num('FUNDING_MAX_BASIS_PCT', 0.1) / 100,
    maxOpenPositions: num('FUNDING_MAX_OPEN_POSITIONS', 3),
    pollMs: num('FUNDING_POLL_MS', 60_000),
    useMakerEntry: bool('FUNDING_USE_MAKER_ENTRY', false),
    minVolume24hUsd: num('FUNDING_MIN_VOLUME_24H_USD', 5_000_000),
    marginAlertRatio: num('FUNDING_MARGIN_ALERT_RATIO', 0.5),
    // só abrir quando o próximo settlement da perna que recebe está a <= N min (0 = sempre)
    entryWindowMin: num('FUNDING_ENTRY_WINDOW_MIN', 45),
    // não fechar por "spread desapareceu" antes disto (evita pagar 4 taxas por uma oscilação)
    minHoldHours: num('FUNDING_MIN_HOLD_HOURS', 8),
    // stop-loss nas pernas: fechar se o P&L de preço (basis) cair abaixo de -X% do notional
    maxLegLossPct: num('FUNDING_MAX_LEG_LOSS_PCT', 0.6) / 100,
  },

  // ---------- Estratégia 3: cash-and-carry numa só exchange (spot long + perp short) ----------
  carry: {
    enabled: bool('CARRY_ENABLED', true),
    exchange: (process.env.CARRY_EXCHANGE || 'bybit').toLowerCase(),
    symbols: list('CARRY_SYMBOLS', []),
    positionUsd: num('CARRY_POSITION_USD', 50),
    leverage: num('CARRY_LEVERAGE', 2),
    minRate8hPct: num('CARRY_MIN_RATE_8H_PCT', 0.01) / 100,
    minNetAprPct: num('CARRY_MIN_NET_APR_PCT', 12) / 100,
    exitRate8hPct: num('CARRY_EXIT_RATE_8H_PCT', 0.002) / 100,
    exitConfirmations: num('CARRY_EXIT_CONFIRMATIONS', 3),
    minHoldHours: num('CARRY_MIN_HOLD_HOURS', 8),
    maxHoldHours: num('CARRY_MAX_HOLD_HOURS', 168),
    expectedHoldHours: num('CARRY_EXPECTED_HOLD_HOURS', 48),
    maxBasisCostPct: num('CARRY_MAX_BASIS_COST_PCT', 0.1) / 100,
    maxLegLossPct: num('CARRY_MAX_LEG_LOSS_PCT', 0.6) / 100,
    maxOpenPositions: num('CARRY_MAX_OPEN_POSITIONS', 3),
    pollMs: num('CARRY_POLL_MS', 60_000),
    entryWindowMin: num('CARRY_ENTRY_WINDOW_MIN', 45),
    topN: num('CARRY_TOP_N', 8),
  },

  // ---------- Filtros de qualidade (funding + carry): o que separa carry real de ruído ----------
  quality: {
    minVolume24hUsd: num('QUALITY_MIN_VOLUME_24H_USD', 5_000_000),
    minOpenInterestUsd: num('QUALITY_MIN_OPEN_INTEREST_USD', 2_000_000),
    maxPositionOiRatio: num('QUALITY_MAX_POSITION_OI_RATIO', 0.001),
    minListingDays: num('QUALITY_MIN_LISTING_DAYS', 14),
    persistenceHours: num('QUALITY_PERSISTENCE_HOURS', 24),
    minHistoryPeriods: num('QUALITY_MIN_HISTORY_PERIODS', 3),
    requireHistory: bool('QUALITY_REQUIRE_HISTORY', true),
    maxSignFlips: num('QUALITY_MAX_SIGN_FLIPS', 1),
    blacklist: list('QUALITY_BLACKLIST', []),
  },

  risk: {
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 10),
    maxOpenNotionalUsd: num('MAX_OPEN_NOTIONAL_USD', 500),
    maxConsecutiveFailures: num('MAX_CONSECUTIVE_FAILURES', 3),
    staleDataMs: num('STALE_DATA_MS', 5000),
    killSwitchFile: process.env.KILL_SWITCH_FILE || './STOP',
    maxTradesPerHour: num('MAX_TRADES_PER_HOUR', 30),
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    reportEveryMin: num('TELEGRAM_REPORT_EVERY_MIN', 60),
  },

  web: {
    port: num('PORT', 0),
    token: process.env.WEB_TOKEN || '',
  },
};

export function modeLabel() {
  if (config.simulate) return 'SIMULAÇÃO (dados sintéticos)';
  if (config.live) return config.demo ? 'LIVE (conta DEMO)' : 'LIVE (dinheiro real)';
  return 'DRY-RUN (dados reais, sem ordens)';
}

export function validateForLive() {
  if (!config.exchanges.length) throw new Error('EXCHANGES vazio — configura bybit e/ou binance');
  const missing = [];
  for (const id of config.exchanges) {
    if (!config[id].apiKey || !config[id].secret) missing.push(`${id.toUpperCase()}_API_KEY/${id.toUpperCase()}_API_SECRET`);
  }
  if (missing.length) {
    throw new Error(`Modo LIVE requer chaves API em falta: ${missing.join(', ')}`);
  }
}
