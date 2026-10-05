import http from 'node:http';
import fs from 'node:fs';
import { config, modeLabel, OVERRIDABLE, saveOverrides, setLive, keysConfigured } from './config.js';
import { createLogger } from './logger.js';
import { state, save, recentTrades } from './state.js';
import { tradingBlockedReason, openNotionalUsd } from './risk.js';

import { edge, paper, health, governor, daytrade, spot, approvals } from './lab.js';
import { counters, recentEvents } from './events.js';
import { PAGE, LOGIN_PAGE } from './web/page.js';
import crypto from 'node:crypto';

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
    live: config.live,
    keys: keysConfigured(),
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
    approvals: approvals.snapshot(),
    manualApproval: config.lab.manualApproval,
    strategies: {
      spot: Boolean(config.spot.enabled),
      funding: Boolean(config.funding.enabled),
      triangular: Boolean(config.triangular.enabled),
      daytrade: Boolean(config.daytrade.enabled),
    },
    balances: spot.instance?.balances ? { ...spot.instance.balances, at: spot.instance.balancesAt } : null,
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
    daytrade: daytrade.instance?.snapshot() || { enabled: false },
    risk: config.risk,
    config: {
      spot: { tradeUsd: config.spot.tradeUsd, minNetPct: config.spot.minNetPct * 100, minNetUsd: config.spot.minNetUsd, pollMs: config.spot.pollMs },
      funding: { positionUsd: config.funding.positionUsd, minSpread8hPct: config.funding.minSpread8hPct * 100, minNetAprPct: config.funding.minNetAprPct * 100 },
      triangular: { enabled: config.triangular.enabled, tradeUsd: config.triangular.tradeUsd, minNetPct: config.triangular.minNetPct * 100 },
      daytrade: {
        enabled: config.daytrade.enabled,
        stakeUsd: config.daytrade.stakeUsd,
        expiryMinutes: config.daytrade.expiryMinutes,
        minScore: config.daytrade.minScore,
        maxOpen: config.daytrade.maxOpen,
      },
      auth: authEnabled(),
      lab: {
        baseEdgeBps: config.lab.baseEdgeBps,
        maxSlippageBps: config.lab.maxSlippageBps,
        maxLatencyMs: config.lab.maxLatencyMs,
        minFillProbability: config.lab.minFillProbability,
        minDataQuality: config.lab.minDataQuality,
        opportunityTtlMs: config.lab.opportunityTtlMs,
        manualApproval: config.lab.manualApproval ? 1 : 0,
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

// ---------- login por sessão (ativo quando ADMIN_PASSWORD está definida) ----------
const SESSION_HOURS = 12;

function authEnabled() {
  return Boolean(config.web.adminPassword);
}

function makeSession(user) {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${user}:${exp}`;
  const sig = crypto.createHmac('sha256', config.web.adminPassword).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function checkSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('arb_session='));
  if (!raw) return false;
  try {
    const decoded = Buffer.from(raw.slice(12), 'base64url').toString();
    const parts = decoded.split(':');
    const sig = parts.pop();
    const payload = parts.join(':');
    const exp = Number(parts.at(-1));
    const expected = crypto.createHmac('sha256', config.web.adminPassword).update(payload).digest('hex');
    return sig === expected && Date.now() < exp;
  } catch {
    return false;
  }
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
      if (url.pathname === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_PAGE);
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const body = new URLSearchParams(await readBody(req));
        if (body.get('user') === config.web.adminUser && authEnabled() && body.get('pass') === config.web.adminPassword) {
          res.writeHead(303, {
            location: '/',
            'set-cookie': `arb_session=${makeSession(body.get('user'))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
          });
        } else {
          res.writeHead(303, { location: '/login?err=1' });
        }
        return res.end();
      }
      if (url.pathname === '/logout') {
        res.writeHead(303, { location: '/login', 'set-cookie': 'arb_session=; HttpOnly; Path=/; Max-Age=0' });
        return res.end();
      }
      if (authEnabled() && !checkSession(req) && (url.pathname === '/' || url.pathname.startsWith('/api/'))) {
        if (url.pathname === '/') {
          res.writeHead(303, { location: '/login' });
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'login necessário' }));
        }
        return res.end();
      }
      if (url.pathname === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(snapshot()));
      }
      if (req.method === 'POST' && (url.pathname === '/api/stop' || url.pathname === '/api/resume' || url.pathname === '/api/config' || url.pathname === '/api/live' || url.pathname === '/api/approve' || url.pathname === '/api/reject')) {
        const body = new URLSearchParams(await readBody(req));
        if (body.get('token')) url.searchParams.set('token', body.get('token'));
        if (!authorized(req, url) && !checkSession(req)) {
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
        } else if (url.pathname === '/api/live') {
          const enable = body.get('enable') === '1';
          if (enable && config.simulate) {
            res.writeHead(303, { location: '/?live_err=LIVE%20indisponível%20em%20SIMULAÇÃO' });
            return res.end();
          }
          if (enable && body.get('confirm') !== 'LIVE') {
            res.writeHead(303, { location: '/?live_err=confirma%20escrevendo%20LIVE' });
            return res.end();
          }
          try {
            setLive(enable);
            log.warn(`modo ${enable ? 'LIVE' : 'PAPER'} ${enable ? 'ATIVADO' : 'restaurado'} via web`);
          } catch (e) {
            res.writeHead(303, { location: `/?live_err=${encodeURIComponent(e.message)}` });
            return res.end();
          }
        } else if (url.pathname === '/api/reject') {
          const id = body.get('id');
          const a = approvals.get(id);
          if (a) {
            a.opp.status = 'REJECTED';
            a.opp.explanation.finalDecision = 'REJECTED — ignorado manualmente pelo utilizador';
            approvals.remove(id);
            log.warn(`oportunidade ${id} ignorada pelo utilizador`);
          }
        } else if (url.pathname === '/api/approve') {
          const id = body.get('id');
          const a = approvals.get(id);
          if (!a) {
            res.writeHead(303, { location: '/?live_err=' + encodeURIComponent('oportunidade expirada ou já tratada') });
            return res.end();
          }
          approvals.remove(id);
          a.opp.status = 'EXECUTING';
          try {
            await a.execute();
            log.warn(`oportunidade ${id} executada manualmente (${config.live ? 'LIVE' : 'paper'})`);
          } catch (e) {
            a.opp.status = 'FAILED';
            log.error(`execução manual ${id} falhou: ${e.message}`);
          }
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
