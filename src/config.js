import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

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
const DATA_DIR = process.env.DATA_DIR || './data';

// LIVE pode ser ligado/desligado em runtime pelo painel (data/live.flag persiste a escolha)
function liveFlagPath() {
  return path.join(DATA_DIR, 'live.flag');
}
let liveFlag = (LIVE || fs.existsSync(liveFlagPath())) && !SIMULATE;

export function setLive(on) {
  if (on) validateForLive();
  config.live = Boolean(on);
  liveFlag = config.live;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (liveFlag) fs.writeFileSync(liveFlagPath(), `${new Date().toISOString()}\n`);
    else if (fs.existsSync(liveFlagPath())) fs.unlinkSync(liveFlagPath());
  } catch {}
  return liveFlag;
}

export function keysConfigured() {
  const out = {};
  for (const id of EXCHANGES) {
    const c = config[id];
    out[id] = { apiKey: Boolean(c.apiKey), secret: Boolean(c.secret), password: !c.needsPassword || Boolean(c.password), ready: Boolean(c.apiKey && c.secret && (!c.needsPassword || c.password)) };
  }
  return out;
}

// exchanges suportadas e a sua config por defeito (taxas VIP0 públicas)
const EXCHANGE_DEFS = {
  bybit: {
    spotMaker: 0.001, spotTaker: 0.001, swapMaker: 0.0002, swapTaker: 0.00055,
    needsPassword: false,
  },
  binance: {
    spotMaker: 0.001, spotTaker: 0.001, swapMaker: 0.0002, swapTaker: 0.0005,
    needsPassword: false,
  },
  okx: {
    spotMaker: 0.0008, spotTaker: 0.001, swapMaker: 0.0002, swapTaker: 0.0005,
    needsPassword: true, // OKX exige passphrase da API
  },
  kucoin: {
    spotMaker: 0.001, spotTaker: 0.001, swapMaker: 0.0002, swapTaker: 0.0006,
    needsPassword: true, // KuCoin exige passphrase da API
  },
};

function exchangeConfig(id) {
  const p = id.toUpperCase();
  const d = EXCHANGE_DEFS[id];
  return {
    apiKey: process.env[`${p}_API_KEY`] || '',
    secret: process.env[`${p}_API_SECRET`] || '',
    password: process.env[`${p}_API_PASSWORD`] || '',
    spotMaker: num(`${p}_SPOT_MAKER_FEE`, d.spotMaker),
    spotTaker: num(`${p}_SPOT_TAKER_FEE`, d.spotTaker),
    swapMaker: num(`${p}_SWAP_MAKER_FEE`, d.swapMaker),
    swapTaker: num(`${p}_SWAP_TAKER_FEE`, d.swapTaker),
    needsPassword: d.needsPassword,
  };
}

const EXCHANGES = list('EXCHANGES', ['bybit', 'binance']).filter((id) => {
  if (!EXCHANGE_DEFS[id]) {
    console.warn(`exchange desconhecida em EXCHANGES: ${id} (suportadas: ${Object.keys(EXCHANGE_DEFS).join(', ')})`);
    return false;
  }
  return true;
});
if (EXCHANGES.length < 2) throw new Error(`EXCHANGES precisa de >= 2 exchanges suportadas (${Object.keys(EXCHANGE_DEFS).join(', ')}); recebeu: ${EXCHANGES}`);

export const config = {
  live: liveFlag,
  simulate: SIMULATE,
  demo: bool('DEMO_TRADING', false),
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir: DATA_DIR,

  exchanges: EXCHANGES,

  bybit: exchangeConfig('bybit'),
  binance: exchangeConfig('binance'),
  okx: exchangeConfig('okx'),
  kucoin: exchangeConfig('kucoin'),

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
  },

  risk: {
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 10),
    maxOpenNotionalUsd: num('MAX_OPEN_NOTIONAL_USD', 500),
    maxConsecutiveFailures: num('MAX_CONSECUTIVE_FAILURES', 3),
    staleDataMs: num('STALE_DATA_MS', 5000),
    killSwitchFile: process.env.KILL_SWITCH_FILE || './STOP',
    maxTradesPerHour: num('MAX_TRADES_PER_HOUR', 30),
  },

  triangular: {
    enabled: bool('TRI_ARB_ENABLED', false),
    // base dos triângulos: vazio = todas as bases com mercados X/USDT, X/BTC e BTC/USDT na exchange
    symbols: list('TRI_SYMBOLS', []),
    tradeUsd: num('TRI_TRADE_USD', 30),
    minNetPct: num('TRI_MIN_NET_PCT', 0.12) / 100,
    minNetUsd: num('TRI_MIN_NET_USD', 0.03),
    slippageBufferPct: num('TRI_SLIPPAGE_BUFFER_PCT', 0.05) / 100,
    pollMs: num('TRI_POLL_MS', 3000),
    cooldownMs: num('TRI_SYMBOL_COOLDOWN_MS', 10_000),
  },

  // ---------- Day trade direcional (operações 5-30 min, estilo payout fixo) ----------
  daytrade: {
    enabled: bool('DAYTRADE_ENABLED', true),
    exchange: process.env.DAYTRADE_EXCHANGE || '', // vazio = primeira de EXCHANGES
    symbols: list('DAYTRADE_SYMBOLS', ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT', 'SUI/USDT']),
    stakeUsd: num('DAYTRADE_STAKE_USD', 10),
    payoutPct: num('DAYTRADE_PAYOUT_PCT', 0.9),
    expiryMinutes: num('DAYTRADE_EXPIRY_MINUTES', 15),
    expiryMinMinutes: num('DAYTRADE_EXPIRY_MIN_MINUTES', 5),
    expiryMaxMinutes: num('DAYTRADE_EXPIRY_MAX_MINUTES', 30),
    pollMs: num('DAYTRADE_POLL_MS', 15_000),
    maxOpen: num('DAYTRADE_MAX_OPEN', 3),
    minScore: num('DAYTRADE_MIN_SCORE', 0.25),
    minAgreement: num('DAYTRADE_MIN_AGREEMENT', 0.5),
    cooldownMs: num('DAYTRADE_COOLDOWN_MS', 300_000),
    dailyLossLimitUsd: num('DAYTRADE_DAILY_LOSS_LIMIT_USD', 30),
  },

  // ---------- Laboratório de arbitragem (edge engine / paper trading) ----------
  lab: {
    // preset de configuração: conservative | balanced | research
    preset: (process.env.CONFIG_PRESET || 'balanced').toLowerCase(),
    // modo research: nunca executa nada (nem paper) — só mede qualidade de sinal
    researchMode: bool('RESEARCH_MODE', false),
    // grava snapshots de order book para replay/backtest
    record: bool('RECORD_MARKET_DATA', false),
    dataFreshnessMs: num('DATA_FRESHNESS_MS', 3000),
    degradedDataMs: num('DATA_DEGRADED_MS', 10_000),
    offlineDataMs: num('DATA_OFFLINE_MS', 30_000),
    minDataQuality: num('MIN_DATA_QUALITY', 50),
    opportunityTtlMs: num('OPPORTUNITY_TTL_MS', 4000),
    // MANUAL_APPROVAL: oportunidades validadas ficam na fila até clique no painel
    manualApproval: bool('MANUAL_APPROVAL', false),
    baseEdgeBps: num('BASE_EDGE_BPS', 5),
    executionBufferBps: num('EXECUTION_BUFFER_BPS', 3),
    safetyBufferPct: num('SAFETY_BUFFER_PCT', 0.02) / 100,
    minNetUsd: num('LAB_MIN_NET_USD', 0.03),
    minFillProbability: num('MIN_FILL_PROBABILITY', 0.4),
    maxVolatilityBps: num('MAX_VOLATILITY_BPS', 120),
    maxSlippageBps: num('MAX_SLIPPAGE_BPS', 40),
    maxLatencyMs: num('MAX_LATENCY_MS', 8000),
    maxDataAgeMs: num('MAX_DATA_AGE_MS', 8000),
    maxSimultaneousSimulations: num('MAX_SIMULTANEOUS_SIMULATIONS', 4),
    maxDailySimulatedLossUsd: num('MAX_DAILY_SIMULATED_LOSS_USD', 20),
    exchangeOfflineMs: num('EXCHANGE_OFFLINE_MS', 60_000),
    regime: {
      highVolBps: num('REGIME_HIGH_VOL_BPS', 40),
      extremeVolBps: num('REGIME_EXTREME_VOL_BPS', 100),
      dislocatedPct: num('REGIME_DISLOCATED_PCT', 1.5) / 100,
      lowLiquidityFactor: num('REGIME_LOW_LIQ_FACTOR', 0.25),
    },
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    reportEveryMin: num('TELEGRAM_REPORT_EVERY_MIN', 60),
  },

  web: {
    port: num('PORT', 0),
    token: process.env.WEB_TOKEN || '',
    // login do painel: definir ADMIN_PASSWORD ativa autenticação por sessão
    adminUser: process.env.ADMIN_USER || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
  },
};

// ---------- presets do laboratório (só aplicam onde a env não foi definida) ----------
const PRESETS = {
  conservative: {
    baseEdgeBps: 15, minFillProbability: 0.7, minDataQuality: 70,
    maxSlippageBps: 20, maxLatencyMs: 3000, safetyBufferPct: 0.0005,
    maxVolatilityBps: 60, minNetUsd: 0.05,
  },
  balanced: {},
  research: {
    baseEdgeBps: 0, minFillProbability: 0, minDataQuality: 0,
    maxSlippageBps: 10_000, maxLatencyMs: 60_000, safetyBufferPct: 0,
    maxVolatilityBps: 100_000, minNetUsd: -Infinity, researchMode: true,
  },
};
const PRESET_ENV = {
  baseEdgeBps: 'BASE_EDGE_BPS', minFillProbability: 'MIN_FILL_PROBABILITY',
  minDataQuality: 'MIN_DATA_QUALITY', maxSlippageBps: 'MAX_SLIPPAGE_BPS',
  maxLatencyMs: 'MAX_LATENCY_MS', safetyBufferPct: 'SAFETY_BUFFER_PCT',
  maxVolatilityBps: 'MAX_VOLATILITY_BPS', minNetUsd: 'LAB_MIN_NET_USD',
  researchMode: 'RESEARCH_MODE',
};
{
  const p = PRESETS[config.lab.preset];
  if (!p) console.warn(`CONFIG_PRESET desconhecido: ${config.lab.preset} (usar conservative|balanced|research)`);
  else {
    for (const [k, v] of Object.entries(p)) {
      const envName = PRESET_ENV[k];
      if (envName && process.env[envName] !== undefined && process.env[envName] !== '') continue;
      config.lab[k] = v;
    }
  }
}

export function modeLabel() {
  if (config.simulate) return 'SIMULAÇÃO (dados sintéticos)';
  if (config.live) return config.demo ? 'LIVE (conta DEMO)' : 'LIVE (dinheiro real)';
  if (config.lab.researchMode) return 'RESEARCH (dados reais, análise de sinais — sem trades)';
  return 'PAPER TRADING (dados reais, execução simulada)';
}

export function validateForLive() {
  const missing = [];
  for (const id of config.exchanges) {
    const p = id.toUpperCase();
    const c = config[id];
    if (!c.apiKey || !c.secret) missing.push(`${p}_API_KEY/${p}_API_SECRET`);
    if (c.needsPassword && !c.password) missing.push(`${p}_API_PASSWORD`);
  }
  if (missing.length) {
    throw new Error(`Modo LIVE requer chaves API em falta: ${missing.join(', ')}`);
  }
}

// ---------- overrides em tempo de execução (editáveis no painel web) ----------
// Chaves que o painel pode alterar sem reiniciar. Guardadas em DATA_DIR/overrides.json.
export const OVERRIDABLE = {
  'spot.minNetPct': () => config.spot.minNetPct,
  'spot.minNetUsd': () => config.spot.minNetUsd,
  'spot.tradeUsd': () => config.spot.tradeUsd,
  'spot.pollMs': () => config.spot.pollMs,
  'funding.minSpread8hPct': () => config.funding.minSpread8hPct,
  'funding.minNetAprPct': () => config.funding.minNetAprPct,
  'funding.positionUsd': () => config.funding.positionUsd,
  'triangular.minNetPct': () => config.triangular.minNetPct,
  'triangular.tradeUsd': () => config.triangular.tradeUsd,
  'lab.baseEdgeBps': () => config.lab.baseEdgeBps,
  'lab.maxSlippageBps': () => config.lab.maxSlippageBps,
  'lab.maxLatencyMs': () => config.lab.maxLatencyMs,
  'lab.minFillProbability': () => config.lab.minFillProbability,
  'lab.minDataQuality': () => config.lab.minDataQuality,
  'lab.opportunityTtlMs': () => config.lab.opportunityTtlMs,
  'lab.safetyBufferPct': () => config.lab.safetyBufferPct,
  'lab.maxVolatilityBps': () => config.lab.maxVolatilityBps,
  'lab.minNetUsd': () => config.lab.minNetUsd,
  'lab.manualApproval': () => config.lab.manualApproval,
  'spot.enabled': () => config.spot.enabled,
  'funding.enabled': () => config.funding.enabled,
  'triangular.enabled': () => config.triangular.enabled,
  'daytrade.enabled': () => config.daytrade.enabled,
  'daytrade.stakeUsd': () => config.daytrade.stakeUsd,
  'daytrade.minScore': () => config.daytrade.minScore,
  'daytrade.expiryMinutes': () => config.daytrade.expiryMinutes,
  'daytrade.maxOpen': () => config.daytrade.maxOpen,
};

function overridesPath() {
  return path.join(config.dataDir, 'overrides.json');
}

export function loadOverrides() {
  try {
    const data = JSON.parse(fs.readFileSync(overridesPath(), 'utf8'));
    applyOverrides(data);
  } catch {}
}

export function applyOverrides(data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (!(key in OVERRIDABLE) || !Number.isFinite(value)) continue;
    const [section, field] = key.split('.');
    config[section][field] = value;
  }
}

export function saveOverrides(data) {
  const clean = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (key in OVERRIDABLE && Number.isFinite(value)) clean[key] = value;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(clean, null, 2));
  applyOverrides(clean);
  return clean;
}

loadOverrides();
