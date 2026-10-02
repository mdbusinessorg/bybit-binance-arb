import http from 'node:http';
import fs from 'node:fs';
import { config, modeLabel, OVERRIDABLE, saveOverrides } from './config.js';
import { createLogger } from './logger.js';
import { state, save, recentTrades } from './state.js';
import { tradingBlockedReason, openNotionalUsd } from './risk.js';
import { usd, pct } from './math.js';
import { edge, paper, health, governor } from './lab.js';
import { counters, recentEvents } from './events.js';

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
    recentTrades: recentTrades(30).reverse(),
    opportunities: [...state.opportunities].reverse().slice(0, 30),
    pnlSeries: pnlSeries(),
    lab: {
      preset: config.lab.preset,
      researchMode: config.lab.researchMode,
      safeMode: governor.safeMode,
      safeReason: governor.safeReason,
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function sparklineSvg(series) {
  if (series.length < 2) return '<p class="muted">sem trades suficientes para gráfico</p>';
  const w = 900, h = 160, pad = 8;
  const vals = series.map((p) => p.v);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const range = max - min || 1;
  const pts = series.map((p, i) => {
    const x = pad + (i / (series.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((p.v - min) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const zeroY = h - pad - ((0 - min) / range) * (h - 2 * pad);
  const last = vals[vals.length - 1];
  const color = last >= 0 ? '#3ddc84' : '#ff5c5c';
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:#181b22;border:1px solid #262a33;border-radius:8px">
<line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="#3a4150" stroke-dasharray="4"/>
<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.join(' ')}"/>
<text x="${w - pad}" y="${zeroY - 4}" fill="#6b7382" font-size="11" text-anchor="end">0</text>
<text x="${w - pad}" y="${pad + 12}" fill="${color}" font-size="12" text-anchor="end">${usd(max, 3)}</text>
<text x="${w - pad}" y="${h - 4}" fill="#ff8080" font-size="12" text-anchor="end">${usd(min, 3)}</text>
</svg>`;
}

function configForm(s) {
  const row = (key, label, value, step = 'any') =>
    `<tr><td>${esc(label)}</td><td><code>${esc(key)}</code></td><td><input name="${esc(key)}" value="${esc(value)}" step="${step}" type="number" style="width:110px"></td></tr>`;
  return `<form method="post" action="/api/config"><input type="hidden" name="token" value="__TOKEN__">
<table><tr><th>Opção</th><th>Chave</th><th>Valor</th></tr>
${row('spot.minNetPct', 'Spot: lucro mínimo %', (s.config.spot.minNetPct).toFixed(3), '0.01')}
${row('spot.minNetUsd', 'Spot: lucro mínimo $', s.config.spot.minNetUsd, '0.01')}
${row('spot.tradeUsd', 'Spot: tamanho $', s.config.spot.tradeUsd, '1')}
${row('funding.minNetAprPct', 'Funding: APR líq mínimo %', (s.config.funding.minNetAprPct).toFixed(1), '0.5')}
${row('funding.positionUsd', 'Funding: tamanho por lado $', s.config.funding.positionUsd, '1')}
${row('triangular.minNetPct', 'Triangular: lucro mínimo %', (s.config.triangular.minNetPct).toFixed(3), '0.01')}
${row('triangular.tradeUsd', 'Triangular: tamanho $', s.config.triangular.tradeUsd, '1')}
${row('lab.baseEdgeBps', 'Lab: edge base exigido (bps)', s.config.lab.baseEdgeBps, '1')}
${row('lab.maxSlippageBps', 'Lab: slippage máx (bps)', s.config.lab.maxSlippageBps, '1')}
${row('lab.maxLatencyMs', 'Lab: latência máx (ms)', s.config.lab.maxLatencyMs, '10')}
${row('lab.minFillProbability', 'Lab: fill prob mínimo (0-1)', s.config.lab.minFillProbability, '0.05')}
${row('lab.minDataQuality', 'Lab: data quality mínima (0-100)', s.config.lab.minDataQuality, '1')}
${row('lab.opportunityTtlMs', 'Lab: TTL oportunidade (ms)', s.config.lab.opportunityTtlMs, '100')}
${row('lab.safetyBufferPct', 'Lab: safety buffer %', s.config.lab.safetyBufferPct, '0.005')}
${row('lab.maxVolatilityBps', 'Lab: volatilidade máx (bps)', s.config.lab.maxVolatilityBps, '5')}
</table>
<p><button type="submit">Guardar e aplicar</button> <span class="muted">aplica imediatamente e persiste em data/overrides.json</span></p>
</form>`;
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
            `<td>${esc(t.symbol)}</td><td>${esc(t.strategy === 'spot' ? `${t.buy}→${t.sell}${t.ok === false ? ' (falhou)' : ''}` : t.strategy === 'tri' ? `${t.ex} ${t.dir}${t.ok === false ? ' (falhou)' : ''}` : `long ${t.long}/short ${t.short} · ${t.reason} · ${Number(t.heldHours).toFixed(1)}h`)}</td>` +
            `<td class="${pnlClass(t.pnlUsd)}">${typeof t.pnlUsd === 'number' ? usd(t.pnlUsd, 3) : '—'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">ainda sem trades</td></tr>';
  const oppBadge = (o) => {
    if (o.executed) return '<span class="badge ok">executada</span>';
    if (o.status === 'VALIDATED' || o.status === 'FILLED') return '<span class="badge ok">' + esc(o.status) + '</span>';
    if (o.status === 'REJECTED') return `<span class="badge bad">rejeitada${o.reasonCode ? ` ${esc(o.reasonCode)}` : ''}</span>`;
    if (o.status === 'EXPIRED') return '<span class="muted">expirada</span>';
    return `<span class="muted">${esc(o.status || 'não executada')}${o.note ? ` (${esc(o.note)})` : ''}</span>`;
  };
  const oppWhy = (o) => {
    const e = o.explanation;
    if (!e || !e.finalDecision) return '';
    const parts = [e.finalDecision, e.spreadReason, e.feeReason, e.slippageReason, e.latencyReason, e.liquidityReason, e.riskReason]
      .filter(Boolean)
      .map(esc)
      .join('<br>');
    return `<tr><td colspan="9" class="muted" style="font-size:12px;padding-left:24px">${parts}</td></tr>`;
  };
  const opps = s.opportunities.length
    ? s.opportunities
        .map(
          (o) =>
            `<tr><td>${esc(o.ts?.slice(0, 19).replace('T', ' '))}</td><td>${esc(o.strategy)}</td><td>${esc(o.symbol)}</td>` +
            `<td>${esc(o.dir)}</td><td class="${pnlClass(o.netBps)}">${o.netBps !== undefined ? Number(o.netBps).toFixed(1) + 'bps' : pct(o.netPct, 3)}</td>` +
            `<td>${o.confidence ?? '—'}</td><td>${esc(o.regime ?? '—')}</td><td>${o.latencyMs !== undefined ? o.latencyMs + 'ms' : '—'}</td><td>${oppBadge(o)}</td></tr>` +
            oppWhy(o),
        )
        .join('')
    : '<tr><td colspan="9" class="muted">ainda sem oportunidades avaliadas</td></tr>';
  const controls = config.web.token
    ? `<form method="post" action="/api/stop" onsubmit="return confirm('Parar o robô (kill switch)?')"><input type="hidden" name="token" value="__TOKEN__"><button class="danger">⛔ Parar (kill switch)</button></form>
       <form method="post" action="/api/resume" onsubmit="return confirm('Retomar e limpar circuit breaker?')"><input type="hidden" name="token" value="__TOKEN__"><button>▶ Retomar</button></form>`
    : '<p class="muted">Define WEB_TOKEN para ativar os botões de parar/retomar e a edição de config.</p>';
  const title = `Robô de arbitragem ${s.exchanges.map((e) => e[0].toUpperCase() + e.slice(1)).join(' ↔ ')}`;
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Arb ${esc(s.exchanges.join('↔'))}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;color:#9fb3c8}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.card{background:#181b22;border:1px solid #262a33;border-radius:8px;padding:10px}
.card .k{font-size:11px;color:#8a94a6;text-transform:uppercase}.card .v{font-size:20px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;background:#181b22;border-radius:8px;overflow:hidden}
th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #262a33;font-size:13px}th{color:#8a94a6;font-weight:500}
input{background:#0f1115;color:#e6e6e6;border:1px solid #2a303c;border-radius:4px;padding:4px 6px}
.pos{color:#3ddc84}.neg{color:#ff5c5c}.muted{color:#6b7382}.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px}
.ok{background:#153d2a;color:#3ddc84}.bad{background:#4a1c1c;color:#ff8080}
form{display:inline-block;margin-right:8px}button{background:#2b6cb0;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer}
button.danger{background:#b02b2b}
</style></head><body>
<h1>🤖 ${esc(title)}</h1>
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
<h2>P&L acumulado (últimos ${s.pnlSeries.length} trades)</h2>
${sparklineSvg(s.pnlSeries)}
<h2>Posições funding abertas</h2>
<table><tr><th>Par</th><th>Pernas</th><th>Notional</th><th>Aberta há</th><th>Spread entrada</th><th>Funding acumulado</th></tr>${positions}</table>
<h2>Saúde das exchanges</h2>
<table><tr><th>Exchange</th><th>Estado</th><th>Latência p95</th><th>Erros/min</th><th>Stale/min</th><th>429 (5m)</th><th>OB upd/s</th></tr>${Object.entries(s.lab.exchangeHealth).map(([id, h]) => `<tr><td>${esc(id)}</td><td>${h.status === 'HEALTHY' ? `<span class="badge ok">${h.status}</span>` : `<span class="badge bad">${h.status}</span>`}</td><td>${h.apiLatencyP95Ms !== null ? h.apiLatencyP95Ms + 'ms' : '—'}</td><td>${h.errorsPerMin}</td><td>${h.stalePerMin}</td><td>${h.rateLimitEvents5m}</td><td>${h.obUpdatesPerSec}</td></tr>`).join('')}</table>
<h2>Qualidade de sinal (edge engine)</h2>
<div class="cards">
<div class="card"><div class="k">Detetadas</div><div class="v">${s.lab.edge.detected}</div></div>
<div class="card"><div class="k">Validadas</div><div class="v">${s.lab.edge.validated}</div></div>
<div class="card"><div class="k">Rejeitadas</div><div class="v">${s.lab.edge.rejected}</div></div>
<div class="card"><div class="k">Expiradas</div><div class="v">${s.lab.edge.expired}</div></div>
<div class="card"><div class="k">False opp. rate</div><div class="v">${s.lab.edge.detected ? pct(s.lab.edge.rejected / s.lab.edge.detected, 1) : 'n/a'}</div></div>
<div class="card"><div class="k">SAFE_MODE</div><div class="v">${s.lab.safeMode ? `<span class="neg">ON</span>` : 'off'}</div></div>
</div>
${Object.keys(s.lab.edge.byReason).length ? `<p class="muted">rejeições: ${Object.entries(s.lab.edge.byReason).map(([k, v]) => `${esc(k)}×${v}`).join(' · ')}</p>` : ''}
${s.lab.safeMode ? `<p class="neg">SAFE_MODE: ${esc(s.lab.safeReason)}</p>` : ''}
<h2>Paper trading (execução simulada)</h2>
<div class="cards">
<div class="card"><div class="k">Trades sim.</div><div class="v">${s.lab.paper.simulatedTrades}</div></div>
<div class="card"><div class="k">Win rate</div><div class="v">${s.lab.paper.winRate === null ? 'n/a' : pct(s.lab.paper.winRate, 1)}</div></div>
<div class="card"><div class="k">Net P&L sim.</div><div class="v ${pnlClass(s.lab.paper.netPnlUsd)}">${usd(s.lab.paper.netPnlUsd, 3)}</div></div>
<div class="card"><div class="k">Profit factor</div><div class="v">${s.lab.paper.profitFactor ?? 'n/a'}</div></div>
<div class="card"><div class="k">Max drawdown</div><div class="v neg">${usd(s.lab.paper.maxDrawdownUsd, 3)}</div></div>
<div class="card"><div class="k">Avg slippage</div><div class="v">${s.lab.paper.avgSlippageBps ?? 'n/a'}bps</div></div>
<div class="card"><div class="k">Avg latência</div><div class="v">${s.lab.paper.avgLatencyMs ?? 'n/a'}ms</div></div>
<div class="card"><div class="k">Fill rate</div><div class="v">${s.lab.paper.avgFillRate === null ? 'n/a' : pct(s.lab.paper.avgFillRate, 0)}</div></div>
</div>
<h2>Oportunidades avaliadas</h2>
<table><tr><th>Quando (UTC)</th><th>Tipo</th><th>Par</th><th>Direção</th><th>Net edge</th><th>Conf.</th><th>Regime</th><th>Latência</th><th>Estado</th></tr>${opps}</table>
<h2>Últimos trades</h2>
<table><tr><th>Quando (UTC)</th><th>Modo</th><th>Tipo</th><th>Par</th><th>Detalhe</th><th>P&L</th></tr>${trades}</table>
<h2>Controlo</h2>${controls}
${config.web.token ? `<h2>Configuração (runtime)</h2>${configForm(s)}` : ''}
<h2>Eventos recentes</h2>
<table><tr><th>Quando (UTC)</th><th>Tipo</th><th>Fonte</th><th>Payload</th></tr>${s.lab.recentEvents.map((e) => `<tr><td>${esc(new Date(e.timestamp).toISOString().slice(0, 19).replace('T', ' '))}</td><td>${esc(e.type)}</td><td>${esc(e.source)}</td><td class="muted" style="font-size:12px">${esc(JSON.stringify(e.payload).slice(0, 140))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">sem eventos</td></tr>'}</table>
<p class="muted">JSON: <a href="/api/status" style="color:#9fb3c8">/api/status</a> · health: <a href="/health" style="color:#9fb3c8">/health</a> · métricas: <a href="/metrics" style="color:#9fb3c8">/metrics</a></p>
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
