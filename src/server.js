import http from 'node:http';
import fs from 'node:fs';
import { config, modeLabel, OVERRIDABLE, saveOverrides } from './config.js';
import { createLogger } from './logger.js';
import { state, save, recentTrades } from './state.js';
import { tradingBlockedReason, openNotionalUsd } from './risk.js';

import { edge, paper, health, governor } from './lab.js';
import { counters, recentEvents } from './events.js';
import { PAGE } from './web/page.js';

const log = createLogger('web');

function pnlSeries() {
  let acc = 0;
  return recentTrades(200)
    .filter((t) => typeof t.pnlUsd === 'number')
    .map((t) => ({ ts: t.ts, v: (acc += t.pnlUsd) }));
}

function snapshot() {
  return {
    mode: modeLabel(),
    exchanges: config.exchanges,
    now: new Date().toISOString(),
    startedAt: state.startedAt,
    uptimeSec: Math.round(process.uptime()),
    blocked: tradingBlockedReason(),
    dailyPnlUsd: state.dailyPnlUsd,
    totalPnlUsd: state.totalPnlUsd,
    spotTrades: state.spotTrades,
    fundingTrades: state.fundingTrades,
    opportunitiesSeen: state.opportunitiesSeen,
    consecutiveFailures: state.consecutiveFailures,
    openNotionalUsd: openNotionalUsd(),
    fundingPositions: Object.values(state.fundingPositions),
    recentTrades: recentTrades(500).reverse(),
    opportunities: [...state.opportunities].reverse().slice(0, 100),
    pnlSeries: pnlSeries(),
    lab: {
      preset: config.lab.preset,
      researchMode: config.lab.researchMode,
      safeMode: governor.safeMode,
      safeReason: governor.safeReason,
      dailySimulatedLossUsd: governor.simulatedDailyLoss,
      activeSimulations: governor.activeSimulations,
      edge: edge.metrics,
      paper: paper.stats(),
      exchangeHealth: health.snapshot(),
      tech: {
        messagesPerSec: Math.round(counters.messagesPerSec * 10) / 10,
        orderbookUpdatesPerSec: Math.round(counters.orderbookUpdatesPerSec * 10) / 10,
        errorsPerMin: Math.round(counters.errorsPerMin * 10) / 10,
        ramMb: Math.round(process.memoryUsage().rss / 1048576),
        uptimeSec: Math.round(process.uptime()),
      },
      recentEvents: recentEvents(40).reverse(),
    },
    risk: config.risk,
    config: {
      spot: { tradeUsd: config.spot.tradeUsd, minNetPct: config.spot.minNetPct * 100, minNetUsd: config.spot.minNetUsd, pollMs: config.spot.pollMs },
      funding: { positionUsd: config.funding.positionUsd, minSpread8hPct: config.funding.minSpread8hPct * 100, minNetAprPct: config.funding.minNetAprPct * 100 },
      triangular: { enabled: config.triangular.enabled, tradeUsd: config.triangular.tradeUsd, minNetPct: config.triangular.minNetPct * 100 },
      lab: {
        baseEdgeBps: config.lab.baseEdgeBps,
        maxSlippageBps: config.lab.maxSlippageBps,
        maxLatencyMs: config.lab.maxLatencyMs,
        minFillProbability: config.lab.minFillProbability,
        minDataQuality: config.lab.minDataQuality,
        opportunityTtlMs: config.lab.opportunityTtlMs,
        safetyBufferPct: config.lab.safetyBufferPct * 100,
        maxVolatilityBps: config.lab.maxVolatilityBps,
        minNetUsd: config.lab.minNetUsd,
      },
    },
  };
}

function authorized(req, url) {
  if (!config.web.token) return false;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === config.web.token || url.searchParams.get('token') === config.web.token;
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

export function startWebServer() {
  if (!config.web.port) return null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, blocked: tradingBlockedReason(), mode: modeLabel() }));
      }
      if (url.pathname === '/metrics') {
        const tech = snapshot().lab.tech;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(
          [
            `arb_uptime_seconds ${tech.uptimeSec}`,
            `arb_ram_mb ${tech.ramMb}`,
            `arb_messages_per_sec ${tech.messagesPerSec}`,
            `arb_orderbook_updates_per_sec ${tech.orderbookUpdatesPerSec}`,
            `arb_errors_per_min ${tech.errorsPerMin}`,
            `arb_opportunities_detected ${edge.metrics.detected}`,
            `arb_opportunities_validated ${edge.metrics.validated}`,
            `arb_opportunities_rejected ${edge.metrics.rejected}`,
            `arb_opportunities_expired ${edge.metrics.expired}`,
            `arb_paper_trades ${paper.stats().simulatedTrades}`,
            `arb_paper_net_pnl_usd ${paper.stats().netPnlUsd}`,
            `arb_safe_mode ${governor.safeMode ? 1 : 0}`,
            ...Object.entries(health.snapshot()).map(([id, h]) => `arb_exchange_healthy{exchange="${id}"} ${h.status === 'HEALTHY' ? 1 : 0}`),
          ].join('\n') + '\n',
        );
      }
      if (url.pathname === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(snapshot()));
      }
      if (req.method === 'POST' && (url.pathname === '/api/stop' || url.pathname === '/api/resume' || url.pathname === '/api/config')) {
        const body = new URLSearchParams(await readBody(req));
        if (body.get('token')) url.searchParams.set('token', body.get('token'));
        if (!authorized(req, url)) {
          res.writeHead(401);
          return res.end('não autorizado');
        }
        if (url.pathname === '/api/stop') {
          fs.writeFileSync(config.risk.killSwitchFile, `web ${new Date().toISOString()}\n`);
          log.warn('kill switch ativado via web');
        } else if (url.pathname === '/api/resume') {
          if (fs.existsSync(config.risk.killSwitchFile)) fs.unlinkSync(config.risk.killSwitchFile);
          state.halted = false;
          state.haltReason = null;
          state.consecutiveFailures = 0;
          save();
          log.warn('robô retomado via web');
        } else {
          // percentagens chegam em % e são guardadas em fração
          const raw = Object.fromEntries(body.entries());
          delete raw.token;
          const pctKeys = new Set(['spot.minNetPct', 'funding.minSpread8hPct', 'funding.minNetAprPct', 'triangular.minNetPct', 'lab.safetyBufferPct']);
          const data = {};
          for (const [k, v] of Object.entries(raw)) {
            const n = Number(v);
            if (!Number.isFinite(n) || !(k in OVERRIDABLE)) continue;
            data[k] = pctKeys.has(k) ? n / 100 : n;
          }
          const applied = saveOverrides(data);
          log.warn(`config atualizada via web: ${JSON.stringify(applied)}`);
        }
        res.writeHead(303, { location: `/?token=${encodeURIComponent(config.web.token)}` });
        return res.end();
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      log.error('web', e);
      res.writeHead(500);
      res.end('erro');
    }
  });
  server.listen(config.web.port, '0.0.0.0', () => log.info(`painel web em http://0.0.0.0:${config.web.port}`));
  return server;
}
