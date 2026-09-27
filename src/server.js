import http from 'node:http';
import fs from 'node:fs';
import { config, modeLabel } from './config.js';
import { createLogger } from './logger.js';
import { state, save, recentTrades } from './state.js';
import { tradingBlockedReason, openNotionalUsd } from './risk.js';
import { usd, pct } from './math.js';

const log = createLogger('web');

function snapshot() {
  return {
    mode: modeLabel(),
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
    recentTrades: recentTrades(30).reverse(),
    risk: config.risk,
  };
}

function authorized(req, url) {
  if (!config.web.token) return false;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === config.web.token || url.searchParams.get('token') === config.web.token;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function html(s) {
  const pnlClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const positions = s.fundingPositions.length
    ? s.fundingPositions
        .map(
          (p) =>
            `<tr><td>${esc(p.symbol)}</td><td>long ${esc(p.longId)} / short ${esc(p.shortId)}</td><td>${usd(p.notionalUsd)}</td>` +
            `<td>${((Date.now() - p.openedAt) / 3600_000).toFixed(1)}h</td><td>${pct(p.entrySpread8h, 4)}/8h</td>` +
            `<td class="${pnlClass(p.fundingAccruedUsd)}">${usd(p.fundingAccruedUsd, 3)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">nenhuma</td></tr>';
  const trades = s.recentTrades.length
    ? s.recentTrades
        .map(
          (t) =>
            `<tr><td>${esc(t.ts?.slice(0, 19).replace('T', ' '))}</td><td>${esc(t.mode)}</td><td>${esc(t.strategy)}</td>` +
            `<td>${esc(t.symbol)}</td><td>${esc(t.strategy === 'spot' ? `${t.buy}→${t.sell}${t.ok === false ? ' (falhou)' : ''}` : `long ${t.long}/short ${t.short} · ${t.reason} · ${Number(t.heldHours).toFixed(1)}h`)}</td>` +
            `<td class="${pnlClass(t.pnlUsd)}">${typeof t.pnlUsd === 'number' ? usd(t.pnlUsd, 3) : '—'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">ainda sem trades</td></tr>';
  const controls = config.web.token
    ? `<form method="post" action="/api/stop" onsubmit="return confirm('Parar o robô (kill switch)?')"><input type="hidden" name="token" value="__TOKEN__"><button class="danger">⛔ Parar (kill switch)</button></form>
       <form method="post" action="/api/resume" onsubmit="return confirm('Retomar e limpar circuit breaker?')"><input type="hidden" name="token" value="__TOKEN__"><button>▶ Retomar</button></form>`
    : '<p class="muted">Define WEB_TOKEN para ativar os botões de parar/retomar.</p>';
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Arb Bybit↔Binance</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;color:#9fb3c8}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.card{background:#181b22;border:1px solid #262a33;border-radius:8px;padding:10px}
.card .k{font-size:11px;color:#8a94a6;text-transform:uppercase}.card .v{font-size:20px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;background:#181b22;border-radius:8px;overflow:hidden}
th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #262a33;font-size:13px}th{color:#8a94a6;font-weight:500}
.pos{color:#3ddc84}.neg{color:#ff5c5c}.muted{color:#6b7382}.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px}
.ok{background:#153d2a;color:#3ddc84}.bad{background:#4a1c1c;color:#ff8080}
form{display:inline-block;margin-right:8px}button{background:#2b6cb0;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer}
button.danger{background:#b02b2b}
</style></head><body>
<h1>🤖 Robô de arbitragem Bybit ↔ Binance</h1>
<div><span class="muted">${esc(s.mode)}</span> · ${s.blocked ? `<span class="badge bad">⛔ ${esc(s.blocked)}</span>` : '<span class="badge ok">✅ a operar</span>'} · <span class="muted">uptime ${Math.floor(s.uptimeSec / 3600)}h${Math.floor((s.uptimeSec % 3600) / 60)}m · atualiza a cada 15s</span></div>
<div class="cards">
<div class="card"><div class="k">P&L hoje</div><div class="v ${pnlClass(s.dailyPnlUsd)}">${usd(s.dailyPnlUsd, 3)}</div></div>
<div class="card"><div class="k">P&L total</div><div class="v ${pnlClass(s.totalPnlUsd)}">${usd(s.totalPnlUsd, 3)}</div></div>
<div class="card"><div class="k">Trades spot</div><div class="v">${s.spotTrades}</div></div>
<div class="card"><div class="k">Trades funding</div><div class="v">${s.fundingTrades}</div></div>
<div class="card"><div class="k">Oportunidades</div><div class="v">${s.opportunitiesSeen}</div></div>
<div class="card"><div class="k">Notional aberto</div><div class="v">${usd(s.openNotionalUsd)} <span class="muted" style="font-size:12px">/ ${usd(s.risk.maxOpenNotionalUsd)}</span></div></div>
<div class="card"><div class="k">Perda diária máx</div><div class="v">${usd(s.risk.maxDailyLossUsd)}</div></div>
<div class="card"><div class="k">Falhas seguidas</div><div class="v">${s.consecutiveFailures} <span class="muted" style="font-size:12px">/ ${s.risk.maxConsecutiveFailures}</span></div></div>
</div>
<h2>Posições funding abertas</h2>
<table><tr><th>Par</th><th>Pernas</th><th>Notional</th><th>Aberta há</th><th>Spread entrada</th><th>Funding acumulado</th></tr>${positions}</table>
<h2>Últimos trades</h2>
<table><tr><th>Quando (UTC)</th><th>Modo</th><th>Tipo</th><th>Par</th><th>Detalhe</th><th>P&L</th></tr>${trades}</table>
<h2>Controlo</h2>${controls}
<p class="muted">JSON: <a href="/api/status" style="color:#9fb3c8">/api/status</a> · health: <a href="/health" style="color:#9fb3c8">/health</a></p>
</body></html>`;
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
      if (url.pathname === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(snapshot()));
      }
      if (req.method === 'POST' && (url.pathname === '/api/stop' || url.pathname === '/api/resume')) {
        const body = new URLSearchParams(await readBody(req));
        if (body.get('token')) url.searchParams.set('token', body.get('token'));
        if (!authorized(req, url)) {
          res.writeHead(401);
          return res.end('não autorizado');
        }
        if (url.pathname === '/api/stop') {
          fs.writeFileSync(config.risk.killSwitchFile, `web ${new Date().toISOString()}\n`);
          log.warn('kill switch ativado via web');
        } else {
          if (fs.existsSync(config.risk.killSwitchFile)) fs.unlinkSync(config.risk.killSwitchFile);
          state.halted = false;
          state.haltReason = null;
          state.consecutiveFailures = 0;
          save();
          log.warn('robô retomado via web');
        }
        res.writeHead(303, { location: `/?token=${encodeURIComponent(config.web.token)}` });
        return res.end();
      }
      if (url.pathname === '/') {
        const token = url.searchParams.get('token') || '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html(snapshot()).replaceAll('__TOKEN__', esc(token)));
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
