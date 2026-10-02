import { config, modeLabel, validateForLive } from './config.js';
import { createLogger } from './logger.js';
import { createExchanges } from './exchanges.js';
import { SpotArbStrategy } from './strategies/spotArb.js';
import { FundingArbStrategy } from './strategies/fundingArb.js';
import { TriangularArbStrategy } from './strategies/triangularArb.js';
import { state, save } from './state.js';
import { tradingBlockedReason, openNotionalUsd } from './risk.js';
import { notify } from './notify.js';
import { usd } from './math.js';
import { startWebServer } from './server.js';
import { DayTradeStrategy } from './daytrade/strategy.js';
import { daytrade } from './lab.js';

const log = createLogger('main');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner() {
  log.info('='.repeat(72));
  log.info(`Robô de arbitragem ${config.exchanges.join(' <-> ')} | modo: ${modeLabel()}`);
  log.info(`estratégias: spot=${config.spot.enabled ? 'on' : 'off'} funding=${config.funding.enabled ? 'on' : 'off'} triangular=${config.triangular.enabled ? 'on' : 'off'} | lab preset=${config.lab.preset}${config.lab.researchMode ? ' [RESEARCH]' : ''}`);
  log.info(
    `risco: perda diária máx ${usd(config.risk.maxDailyLossUsd)}, notional aberto máx ${usd(config.risk.maxOpenNotionalUsd)}, ` +
      `${config.risk.maxConsecutiveFailures} falhas seguidas param o robô, kill switch: ${config.risk.killSwitchFile}`,
  );
  log.info('='.repeat(72));
}

async function loop(name, fn, intervalMs) {
  let backoff = intervalMs;
  for (;;) {
    const t0 = Date.now();
    try {
      await fn();
      backoff = intervalMs;
    } catch (e) {
      const rate = /rate ?limit|429|too many/i.test(e.message);
      backoff = Math.min(backoff * 2, 5 * 60_000);
      log.error(`${name}: ${e.constructor?.name || 'Erro'} ${e.message}${rate ? ' (rate limit — a abrandar)' : ''} — próximo ciclo em ${Math.round(backoff / 1000)}s`);
    }
    const elapsed = Date.now() - t0;
    await sleep(Math.max(200, backoff - elapsed));
  }
}

async function reporter() {
  const every = config.telegram.reportEveryMin * 60_000;
  for (;;) {
    await sleep(every);
    const blocked = tradingBlockedReason();
    const pos = Object.values(state.fundingPositions)
      .map((p) => `  • ${p.symbol} long ${p.longId}/short ${p.shortId} ${usd(p.notionalUsd)} funding acumulado ${usd(p.fundingAccruedUsd, 3)}`)
      .join('\n');
    notify(
      `📊 Relatório (${modeLabel()})\n` +
        `P&L hoje: ${usd(state.dailyPnlUsd, 3)} | total: ${usd(state.totalPnlUsd, 3)}\n` +
        `trades spot: ${state.spotTrades} | funding: ${state.fundingTrades} | oportunidades vistas: ${state.opportunitiesSeen}\n` +
        `notional aberto: ${usd(openNotionalUsd())}\n` +
        (pos ? `posições:\n${pos}\n` : '') +
        (blocked ? `⚠️ bloqueado: ${blocked}` : '✅ a operar'),
    );
  }
}

async function main() {
  banner();
  startWebServer();
  if (config.live) {
    validateForLive();
    log.warn('MODO LIVE: o robô vai colocar ordens reais. Ctrl+C para cancelar nos próximos 5s...');
    await sleep(5000);
  }
  // O painel web já está a ouvir: se as exchanges falharem (ex.: API bloqueada
  // pela região do servidor), tenta de novo em vez de matar o processo — assim
  // o healthcheck passa e o erro real fica visível nos logs/painel.
  let exs;
  for (;;) {
    try {
      exs = await createExchanges();
      break;
    } catch (e) {
      log.error(`init exchanges: ${e.message} — nova tentativa em 30s`);
      await sleep(30_000);
    }
  }
  if (config.live) {
    for (const ex of Object.values(exs)) {
      const bal = await ex.fetchBalance();
      log.info(`${ex.label}: saldo USDT livre = ${Number(bal.free?.USDT || 0).toFixed(2)}`);
    }
  }
  notify(`🤖 Robô iniciado — ${modeLabel()}`);

  const tasks = [];
  if (config.spot.enabled) {
    const spot = new SpotArbStrategy(exs);
    if (spot.symbols.length) tasks.push(loop('spot', () => spot.tick(), config.spot.pollMs));
    else log.warn('spot: nenhum símbolo comum às duas exchanges; estratégia desativada');
  }
  if (config.funding.enabled) {
    const funding = new FundingArbStrategy(exs);
    if (funding.symbols.length) tasks.push(loop('funding', () => funding.tick(), config.funding.pollMs));
    else log.warn('funding: nenhum perp comum às exchanges ativas; estratégia desativada');
  }
  if (config.triangular.enabled) {
    const tri = new TriangularArbStrategy(exs);
    if (tri.routes.length) tasks.push(loop('tri', () => tri.tick(), config.triangular.pollMs));
    else log.warn('triangular: nenhuma rota disponível; estratégia desativada');
  }
  if (config.daytrade.enabled) {
    const dt = new DayTradeStrategy(exs);
    daytrade.instance = dt;
    tasks.push(loop('daytrade', () => dt.tick(), config.daytrade.pollMs));
    log.info(`day-trade: ${dt.exchangeId} | ${dt.symbols.length} símbolos | stake $${config.daytrade.stakeUsd} payout ${(config.daytrade.payoutPct * 100).toFixed(0)}% | expiração ${config.daytrade.expiryMinutes}m`);
  }
  if (config.telegram.token) tasks.push(reporter());
  if (!tasks.length) {
    log.error('nada para fazer — ativa pelo menos uma estratégia');
    process.exit(1);
  }
  await Promise.all(tasks);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    save();
    log.info(`${sig} recebido — estado guardado. P&L total ${usd(state.totalPnlUsd, 3)}. Posições funding abertas: ${Object.keys(state.fundingPositions).length}`);
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

main().catch((e) => {
  log.error('erro fatal', e);
  notify(`💥 Robô terminou com erro: ${e.message}`);
  process.exit(1);
});
