// SPA do painel: toda a renderização é feita no cliente a partir de /api/status.
// O backend (edge engine, paper, risk) continua a ser a fonte de verdade.

export const PAGE = `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arbitrage Bot</title>
<style>
:root{
  --bg:#0d0f13; --panel:#14171d; --panel2:#191d25; --border:#232833;
  --text:#e8eaee; --muted:#7d8697; --faint:#4d5565;
  --pos:#35d47e; --neg:#ff6b6b; --warn:#ffb347; --accent:#4d9fff;
  --radius:10px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}
h1{font-size:18px;font-weight:650;margin:0}
h2{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px}
.topbar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.topbar .grow{flex:1}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 13px;border-radius:999px;font-size:12.5px;font-weight:600;border:1px solid var(--border);background:var(--panel)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot.on{background:var(--pos);box-shadow:0 0 0 3px rgba(53,212,126,.15)}
.dot.off{background:var(--faint)}
.dot.warn{background:var(--warn)}
.dot.bad{background:var(--neg);box-shadow:0 0 0 3px rgba(255,107,107,.15)}
.mode-tag{font-size:11px;font-weight:700;letter-spacing:.08em;padding:3px 9px;border-radius:6px;background:#1a2330;color:var(--accent);border:1px solid #23415e}
.mode-tag.sim{background:#231d12;color:var(--warn);border-color:#4a3a1a}
.mode-tag.live{background:#241418;color:var(--neg);border-color:#4a2020}
nav{display:flex;gap:4px;overflow-x:auto;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--bg);scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav a{flex:0 0 auto;padding:7px 13px;border-radius:8px;font-size:13px;color:var(--muted);white-space:nowrap}
nav a.active{background:var(--panel2);color:var(--text);font-weight:600}
main{max-width:1120px;margin:0 auto;padding:18px 20px 60px}
.grid{display:grid;gap:12px}
.cards{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.cards.big{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.card .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;gap:6px}
.card .v{font-size:24px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums}
.card .sub{font-size:12px;color:var(--muted);margin-top:3px;font-variant-numeric:tabular-nums}
.card.hero{background:var(--panel2)}
.pos{color:var(--pos)}.neg{color:var(--neg)}.warn{color:var(--warn)}.muted{color:var(--muted)}.faint{color:var(--faint)}
.section{margin-top:22px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 10px;text-align:left;font-size:13px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
th{color:var(--muted);font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
tbody tr{transition:background .15s}
tbody tr:hover{background:var(--panel2)}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}
.b-ok{background:rgba(53,212,126,.13);color:var(--pos)}
.b-bad{background:rgba(255,107,107,.13);color:var(--neg)}
.b-warn{background:rgba(255,179,71,.13);color:var(--warn)}
.b-mut{background:rgba(125,134,151,.13);color:var(--muted)}
.empty{padding:28px 16px;text-align:center;color:var(--muted)}
.empty .t{font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px}
.list{display:flex;flex-direction:column}
.item{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)}
.item:last-child{border-bottom:0}
.item .time{color:var(--faint);font-size:12px;width:44px;flex:0 0 auto}
.item .sym{font-weight:600;width:90px;flex:0 0 auto}
.item .route{flex:1;color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .amt{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.item.new{animation:fadein .8s}
@keyframes fadein{from{background:rgba(77,159,255,.18)}to{background:transparent}}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:5px 12px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:12.5px;cursor:pointer}
.chip.active{background:var(--panel2);color:var(--text);border-color:var(--faint);font-weight:600}
.btn{display:inline-block;padding:8px 15px;border-radius:8px;border:1px solid var(--border);background:var(--panel2);color:var(--text);font-size:13px;font-weight:600;cursor:pointer}
.btn:hover{border-color:var(--faint)}
.btn.danger{background:#3a1518;border-color:#5c2226;color:#ff8a8a}
.btn.danger:hover{background:#4a1a1d}
.btn.primary{background:#1d3a5f;border-color:#2b528a}
summary{cursor:pointer;color:var(--muted);font-size:12px}
details .why{padding:8px 10px 10px;color:var(--muted);font-size:12px;line-height:1.6;border-top:1px dashed var(--border)}
input,select{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:7px 9px;font-size:13px}
label{display:block;font-size:11.5px;color:var(--muted);margin:0 0 4px}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.banner{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);padding:12px 16px;display:flex;gap:12px;align-items:center}
.banner.ok{border-left-color:var(--pos)}
.banner.warn{border-left-color:var(--warn)}
.banner.bad{border-left-color:var(--neg)}
.statusbar{display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.sstat{display:flex;align-items:center;gap:7px;font-size:13px}
.sstat .lbl{color:var(--muted);font-size:12px}
.chart{width:100%;height:auto;display:block}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-top:6px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:760px){
  main{padding:14px 12px 50px}
  .split{grid-template-columns:1fr}
  .card .v{font-size:21px}
  table.resp thead{display:none}
  table.resp tr{display:block;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;padding:6px 10px}
  table.resp td{display:flex;justify-content:space-between;border-bottom:0;padding:5px 0;font-size:13px}
  table.resp td::before{content:attr(data-h);color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
}
</style>
</head>
<body>
<header class="topbar">
  <h1>Arbitrage Bot</h1>
  <span id="hdrStatus"></span>
  <span id="hdrMode"></span>
  <div class="grow"></div>
  <span id="hdrMeta" class="muted" style="font-size:12px"></span>
</header>
<nav id="nav"></nav>
<main id="view"><div class="empty"><div class="t">A carregar…</div></div></main>

<script>
const VIEWS=[["dashboard","Dashboard"],["daytrade","Day Trade"],["transactions","Transações"],["investments","Investimento"],["performance","Performance"],["opportunities","Oportunidades"],["strategies","Estratégias"],["risk","Risco"],["settings","Controlo"],["advanced","Advanced / Research"]];
let S=null, route=(location.hash||"#dashboard").slice(1);
if(!VIEWS.some(v=>v[0]===route))route="dashboard";
const token=new URLSearchParams(location.search).get("token")||"";
let txFilter="all", perfRange="ALL";

const $=(h)=>h;
const esc=(s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const usd=(v,d=2)=>v==null||isNaN(v)?"$0.00":(v<0?"-$":"+$")+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const usdAbs=(v,d=2)=>v==null||isNaN(v)?"—":"$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const pcls=(v)=>v>0?"pos":v<0?"neg":"muted";
const hhmm=(ts)=>ts?ts.slice(11,19):"—";
const dt=(ts)=>ts?ts.slice(0,19).replace("T"," "):"—";
const ago=(ts)=>{if(!ts)return"—";const s=Math.max(0,(Date.now()-new Date(ts).getTime())/1000);if(s<60)return Math.floor(s)+"s";if(s<3600)return Math.floor(s/60)+"m";return Math.floor(s/3600)+"h"+Math.floor((s%3600)/60)+"m"};
const pct=(v,d=2)=>v==null||isNaN(v)?"—":(v*100).toFixed(d)+"%";
const dot=(c)=>'<span class="dot '+c+'"></span>';
const badge=(t,c)=>'<span class="badge b-'+c+'">'+esc(t)+"</span>";
const empty=(t,sub)=>'<div class="empty"><div class="t">'+esc(t)+'</div><div class="muted">'+esc(sub||"")+"</div></div>";
const card=(k,v,cls,sub)=>'<div class="card"><div class="k">'+k+'</div><div class="v '+(cls||"")+'">'+v+'</div>'+(sub?'<div class="sub">'+sub+"</div>":"")+"</div>";
const srcTag=()=>{const live=/LIVE/.test(S.mode||"")&&!/PAPER/.test(S.mode);return live?'<span class="mode-tag live">LIVE</span>':(/SIMULA|sim/i.test(S.mode)?'<span class="mode-tag sim">SIMULATED</span>':'<span class="mode-tag">PAPER</span>')};

function pnlBy(trades,from){let t=0;for(const x of trades){if(typeof x.pnlUsd==="number"&&new Date(x.ts)>=from)t+=x.pnlUsd}return t}
function trades(){return S.recentTrades||[]}
function winLoss(){let w=0,l=0;for(const t of trades()){if(t.pnlUsd>0)w++;else if(t.pnlUsd<0)l++}return[w,l]}

function summary(){
  const e=S.lab.edge,t=S.lab.paper,h=S.lab.exchangeHealth;
  const degraded=Object.entries(h).filter(([,x])=>x.status==="OFFLINE"||x.status==="UNSTABLE");
  if(S.lab.safeMode)return["bad","SAFE MODE ativo — execução pausada pelo RiskGovernor: "+(S.lab.safeReason||"")];
  if(S.blocked)return["bad","Robô pausado: "+S.blocked];
  if(degraded.length)return["warn","A monitorizar mercados — "+degraded.map(([i,x])=>i+" ("+x.status.toLowerCase()+", a retentar)").join(", ")];
  if(e.detected===0)return["ok","Robô ativo, a monitorizar "+S.exchanges.length+" venues. Ainda sem dados de oportunidades nesta sessão."];
  return["ok","Robô ativo — "+e.detected+" oportunidades avaliadas, "+e.validated+" passaram os filtros de execução, "+(t.simulatedTrades||0)+" execuções simuladas."];
}

function vDashboard(){
  const e=S.lab.edge,t=S.lab.paper,h=S.lab.exchangeHealth;
  const blocked=S.blocked||S.lab.safeMode;
  const[btxt,bcls]=blocked?["PAUSADO","bad"]:["RUNNING","ok"];
  const sc=summary();
  const now=new Date(),d0=new Date(now);d0.setHours(0,0,0,0);
  const w0=new Date(now-7*864e5),m0=new Date(now-30*864e5);
  const[w,l]=winLoss();
  const healthyN=Object.values(h).filter(x=>x.status==="HEALTHY"||x.status==="DEGRADED").length;
  const stratNames=[S.config.triangular.enabled?"Triangular":null,"Cross-Exchange","Funding",(S.daytrade&&S.daytrade.enabled)?"Day Trade":null].filter(Boolean);
  const acts=[
    ...trades().map(t=>({ts:t.ts,sym:t.symbol,txt:(t.buy&&t.sell?t.buy+" → "+t.sell:t.strategy==="tri"?t.ex+" "+(t.dir||""):(t.strategy||"")+" · "+(t.reason||"")),mode:t.mode==="paper"||t.mode==="sim"?"Simulated":t.mode,pnl:t.pnlUsd,ok:t.ok})),
    ...(S.opportunities||[]).filter(o=>o.status==="REJECTED"||o.status==="EXPIRED").slice(0,12).map(o=>({ts:o.ts,sym:o.symbol,txt:(o.dir||o.strategy||""),mode:o.status==="REJECTED"?"Rejected":"Expired",pnl:null,reason:o.reasonCode}))
  ].sort((a,b)=>(b.ts||"").localeCompare(a.ts||"")).slice(0,12);
  const recent=acts.length?'<div class="list" style="background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden">'+acts.map((a,i)=>'<div class="item'+(i===0?" new":"")+'"><span class="time">'+hhmm(a.ts)+'</span><span class="sym">'+esc(a.sym||"—")+'</span><span class="route">'+esc(a.txt)+(a.reason?' <span class="faint">'+esc(a.reason.replace(/_/g," ").toLowerCase())+"</span>":"")+'</span><span class="muted" style="font-size:11.5px">'+esc(a.mode||"")+'</span><span class="amt '+(typeof a.pnl==="number"?pcls(a.pnl):"faint")+'">'+(typeof a.pnl==="number"?usd(a.pnl):"—")+"</span></div>").join("")+"</div>":empty("No activity yet","O robô está a varrer mercados; atividade aparecerá aqui.");
  return '<div class="banner '+sc[0]+'" style="margin-bottom:14px">'+(blocked?dot("bad"):dot("on"))+'<div><b>'+btxt+'</b> · '+esc(sc[1])+'<div class="muted" style="font-size:12px;margin-top:2px">Last update '+hhmm(S.now)+' UTC · uptime '+ago(S.startedAt)+' · dados '+(healthyN===Object.keys(h).length?"healthy":"parcialmente degradados")+"</div></div></div>"
  +'<div class="grid cards big">'
  +'<div class="card hero"><div class="k">TOTAL PNL '+srcTag()+'</div><div class="v '+pcls(S.lab.paper.netPnlUsd)+'">'+usd(S.lab.paper.netPnlUsd)+'</div><div class="sub">Today <span class="'+pcls(pnlBy(trades(),d0))+'">'+usd(pnlBy(trades(),d0))+'</span> · Week <span class="'+pcls(pnlBy(trades(),w0))+'">'+usd(pnlBy(trades(),w0))+'</span> · Month <span class="'+pcls(pnlBy(trades(),m0))+'">'+usd(pnlBy(trades(),m0))+"</span></div></div>"
  +card("ALLOCATED (open notional)",usdAbs(S.openNotionalUsd),"", 'cap '+usdAbs(S.risk.maxOpenNotionalUsd))
  +card("TRADES",trades().length,"",'<span class="pos">'+w+' won</span> · <span class="neg">'+l+" lost</span>")
  +card("OPPORTUNITIES",e.detected,"",e.validated+" validadas · "+e.rejected+" rejeitadas · "+e.expired+" expiradas")
  +'</div><div class="section split">'
  +'<div class="card"><h2>Automation</h2><div class="statusbar"><span class="sstat">'+dot(blocked?"off":"on")+'<b>'+(blocked?"OFF":"ON")+'</b></span><span class="sstat"><span class="lbl">Estratégias</span>'+esc(stratNames.join(" · "))+'</span><span class="sstat"><span class="lbl">Venues</span><b>'+S.exchanges.length+'</b></span></div><div class="muted" style="font-size:12.5px;margin-top:8px">'+(blocked?"Execução pausada.":("Scanning markets… "+e.detected+" oportunidades avaliadas · última atividade "+ago(acts[0]&&acts[0].ts)))+'</div></div>'
  +'<div class="card"><h2>Risk status <a href="#risk" style="font-weight:400;font-size:11px">→</a></h2><div class="statusbar"><span class="sstat">'+(S.lab.safeMode?dot("bad")+"<b>SAFE MODE</b>":(Object.values(h).some(x=>x.status!=="HEALTHY")?dot("warn")+"<b>ELEVATED</b>":dot("on")+"<b>NORMAL</b>"))+'</span><span class="sstat"><span class="lbl">Perda sim. hoje</span>'+usdAbs(S.lab.dailySimulatedLossUsd??0)+'</span><span class="sstat"><span class="lbl">Preset</span>'+esc(S.lab.preset)+"</span></div>"+(S.lab.safeMode?'<div class="neg" style="font-size:12.5px;margin-top:8px">'+esc(S.lab.safeReason||"")+"</div>":"")+"</div></div>"
  +'<div class="section"><h2>Recent activity</h2>'+recent+"</div>";
}

function vTransactions(){
  const all=trades();
  const match=(t)=>txFilter==="all"||(txFilter==="profit"&&t.pnlUsd>0)||(txFilter==="loss"&&t.pnlUsd<0)||(txFilter==="failed"&&t.ok===false)||(txFilter==="running"&&typeof t.pnlUsd!=="number"&&t.ok!==false);
  const rows=all.filter(match);
  const chips=[["all","All"],["profit","Profitable"],["loss","Loss"],["failed","Failed"],["running","Pending"]].map(([k,l])=>'<button class="chip'+(txFilter===k?" active":"")+'" onclick="txFilter=\\''+k+'\\';render()">'+l+"</button>").join("");
  const body=rows.length?rows.map((t)=>'<tr><td data-h="Time">'+dt(t.ts)+'</td><td data-h="Asset">'+esc(t.symbol||"—")+'</td><td data-h="Strategy">'+esc(t.strategy||"—")+'</td><td data-h="Route">'+esc(t.buy&&t.sell?t.buy+" → "+t.sell:t.strategy==="tri"?(t.ex||"")+" "+(t.dir||""):(t.long?"long "+t.long+" / short "+t.short:t.reason||"—"))+'</td><td data-h="Mode">'+esc(t.mode||"—")+'</td><td data-h="Result" class="'+pcls(t.pnlUsd)+'">'+(typeof t.pnlUsd==="number"?usd(t.pnlUsd,3):"—")+'</td><td data-h="Status">'+(t.ok===false?badge("failed","bad"):(typeof t.pnlUsd==="number"?(t.pnlUsd>=0?badge("completed","ok"):badge("completed","mut")):badge("open","warn")))+"</td></tr>").join(""):"";
  return '<h2>Transações</h2><div class="chips" style="margin-bottom:12px">'+chips+"</div>"+(body?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Time</th><th>Asset</th><th>Strategy</th><th>Route</th><th>Mode</th><th>P&L</th><th>Status</th></tr></thead><tbody>'+body+"</tbody></table></div>":empty("No trades yet","Nenhuma transação corresponde ao filtro."));
}

function vInvestments(){
  const h=S.lab.exchangeHealth;
  const rows=Object.entries(h).map(([id,x])=>{
    const alloc=(S.fundingPositions||[]).filter(p=>p.longId===id||p.shortId===id).reduce((a,p)=>a+(p.notionalUsd||0)/2,0);
    return '<tr><td data-h="Exchange">'+esc(id)+'</td><td data-h="Allocated">'+usdAbs(alloc)+'</td><td data-h="Exposure">'+(alloc>0?usdAbs(alloc):"$0.00")+'</td><td data-h="Latência">'+(x.apiLatencyP95Ms!=null?x.apiLatencyP95Ms+"ms":"—")+'</td><td data-h="Status">'+(x.status==="HEALTHY"?badge("healthy","ok"):x.status==="DEGRADED"?badge("degraded","warn"):badge(x.status.toLowerCase(),"bad"))+"</td></tr>"});
  return '<h2>Investimento — alocação por exchange</h2>'+(rows.length?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Exchange</th><th>Allocated</th><th>Exposure</th><th>Latência p95</th><th>Status</th></tr></thead><tbody>'+rows.join("")+"</tbody></table></div>":empty("No venues","Sem exchanges configuradas."))
  +'<div class="section"><h2>Posições funding abertas</h2>'+((S.fundingPositions||[]).length?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Par</th><th>Pernas</th><th>Notional</th><th>Aberta há</th><th>Funding acumulado</th></tr></thead><tbody>'+S.fundingPositions.map(p=>'<tr><td data-h="Par">'+esc(p.symbol)+'</td><td data-h="Pernas">long '+esc(p.longId)+" / short "+esc(p.shortId)+'</td><td data-h="Notional">'+usdAbs(p.notionalUsd)+'</td><td data-h="Aberta há">'+ago(p.openedAt?new Date(p.openedAt).toISOString():null)+'</td><td data-h="Funding" class="'+pcls(p.fundingAccruedUsd)+'">'+usd(p.fundingAccruedUsd,3)+"</td></tr>").join("")+"</tbody></table></div>":empty("No open positions","Sem posições delta-neutral abertas."))+"</div>";
}

function cumSeries(list){let a=0;return list.filter(t=>typeof t.pnlUsd==="number").map(t=>({ts:t.ts,v:(a+=t.pnlUsd)}))}
function chartSVG(series,w=900,h=200){
  if(!series||series.length<2)return empty("No PNL data available","O gráfico aparece quando houver trades com resultado.");
  const pad=10,vals=series.map(p=>p.v),min=Math.min(0,...vals),max=Math.max(0,...vals),rg=max-min||1;
  const pts=series.map((p,i)=>[(pad+i/(series.length-1)*(w-2*pad)).toFixed(1),(h-pad-(p.v-min)/rg*(h-2*pad)).toFixed(1)]);
  const zy=(h-pad-(0-min)/rg*(h-2*pad)).toFixed(1),last=vals[vals.length-1],col=last>=0?"#35d47e":"#ff6b6b";
  return '<svg class="chart" viewBox="0 0 '+w+" "+h+'"><line x1="0" y1="'+zy+'" x2="'+w+'" y2="'+zy+'" stroke="#2a303c" stroke-dasharray="4"/><polyline fill="none" stroke="'+col+'" stroke-width="2" points="'+pts.map(p=>p.join(",")).join(" ")+'"/><text x="'+(w-pad)+'" y="'+(pad+10)+'" fill="'+col+'" font-size="12" text-anchor="end">'+usd(max)+'</text><text x="'+(w-pad)+'" y="'+(h-3)+'" fill="#ff8080" font-size="12" text-anchor="end">'+usd(min)+"</text></svg>";
}
function vPerformance(){
  const ranges=[["1D",1],["7D",7],["30D",30],["90D",90],["ALL",null]];
  const days=ranges.find(r=>r[0]===perfRange)[1];
  const from=days?new Date(Date.now()-days*864e5):new Date(0);
  const list=trades().filter(t=>new Date(t.ts)>=from);
  const series=cumSeries(list);
  const byDay={};let count=0;
  for(const t of list){const d=(t.ts||"").slice(0,10);if(!byDay[d])byDay[d]={pnl:0,n:0};if(typeof t.pnlUsd==="number"){byDay[d].pnl+=t.pnlUsd;count++}byDay[d].n++}
  const dayRows=Object.entries(byDay).sort().reverse().map(([d,x])=>'<tr><td data-h="Dia">'+d+'</td><td data-h="Trades">'+x.n+'</td><td data-h="PNL" class="'+pcls(x.pnl)+'">'+usd(x.pnl)+"</td></tr>").join("");
  const chips=ranges.map(([k])=>'<button class="chip'+(perfRange===k?" active":"")+'" onclick="perfRange=\\''+k+'\\';render()">'+k+"</button>").join("");
  return '<h2>Performance '+srcTag()+'</h2><div class="grid cards">'
  +card("Total PNL",usd(S.lab.paper.netPnlUsd),pcls(S.lab.paper.netPnlUsd))
  +card("Período ("+perfRange+")",usd(pnlBy(list,new Date(0))),pcls(pnlBy(list,new Date(0))),list.length+" trades")
  +card("Win rate",S.lab.paper.winRate==null?"n/a":pct(S.lab.paper.winRate,1))
  +card("Max drawdown",usdAbs(S.lab.paper.maxDrawdownUsd),"neg")
  +card("Profit factor",S.lab.paper.profitFactor??"n/a")
  +'</div><div class="section card"><div class="row"><h2 style="margin:0">Cumulative PNL</h2><div class="chips">'+chips+'</div></div><div style="margin-top:10px">'+chartSVG(series)+"</div></div>"
  +'<div class="section"><h2>Por dia</h2>'+(dayRows?'<div class="card" style="padding:0"><table class="resp"><thead><tr><th>Dia</th><th>Trades</th><th>PNL</th></tr></thead><tbody>'+dayRows+"</tbody></table></div>":empty("No PNL data available","Sem trades no período selecionado."))+"</div>";
}

function vOpportunities(){
  const opps=S.opportunities||[];
  const liq=(o)=>{const d=(o.liquidity&&o.liquidity.depthClass)||o.depthClass;return d?d.replace("ORDERBOOK_",""):"—"};
  const body=opps.map(o=>{
    const st=o.status==="VALIDATED"||o.executed?badge("valid","ok"):o.status==="REJECTED"?badge("rejected","bad"):o.status==="EXPIRED"?badge("expired","mut"):o.status==="FILLED"?badge("filled","ok"):badge((o.status||"detected").toLowerCase(),"warn");
    const gross=o.grossPct!=null?pct(o.grossPct):"—";
    const net=o.netBps!=null?o.netBps.toFixed(1)+"bps":o.netPct!=null?pct(o.netPct):"—";
    const why=(o.explanation&&o.explanation.finalDecision)?'<tr><td colspan="9" class="muted" style="font-size:12px;padding-left:20px">'+esc(o.explanation.finalDecision)+(o.explanation.liquidityReason?" · "+esc(o.explanation.liquidityReason):"")+(o.explanation.slippageReason?" · "+esc(o.explanation.slippageReason):"")+(o.explanation.riskReason?" · "+esc(o.explanation.riskReason):"")+"</td></tr>":"";
    return '<tr><td data-h="Par">'+esc(o.symbol)+'</td><td data-h="Buy/Sell">'+esc(o.dir||"—")+'</td><td data-h="Gross">'+gross+'</td><td data-h="Net" class="'+pcls(o.netBps)+'">'+net+'</td><td data-h="Liquidez">'+liq(o)+'</td><td data-h="Slippage">'+(o.slippageBps!=null?o.slippageBps.toFixed(0)+"bps":"—")+'</td><td data-h="Latência">'+(o.latencyMs!=null?o.latencyMs+"ms":"—")+'</td><td data-h="Conf.">'+(o.confidence??"—")+'</td><td data-h="Estado">'+st+"</td></tr>"+why;
  }).join("");
  return '<h2>Oportunidades avaliadas</h2>'+(body?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Pair</th><th>Route</th><th>Gross edge</th><th>Net edge</th><th>Liquidity</th><th>Slippage</th><th>Latency</th><th>Conf</th><th>Status</th></tr></thead><tbody>'+body+"</tbody></table></div>":empty("No valid opportunities yet","O motor avalia cada spread: os aprovados e rejeitados aparecem aqui com o motivo."));
}

function vStrategies(){
  const c=S.config,e=S.lab.edge;
  const st=(name,on,body)=>'<div class="card"><div class="row"><h2 style="margin:0">'+name+'</h2>'+(on?badge("enabled","ok"):badge("off","mut"))+"</div><div style='margin-top:10px' class='muted'>"+body+"</div></div>";
  return '<h2>Estratégias</h2><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">'
  +st("Cross-Exchange (spot)",true,"Tamanho $"+c.spot.tradeUsd+" · net mín "+c.spot.minNetPct.toFixed(2)+"% · poll "+c.spot.pollMs+"ms")
  +st("Funding delta-neutral",true,"$"+c.funding.positionUsd+"/lado · APR líq mín "+c.funding.minNetAprPct+"%")
  +st("Triangular intra-exchange",c.triangular.enabled,"$"+c.triangular.tradeUsd+" · net mín "+c.triangular.minNetPct.toFixed(2)+"%")
  +st("Arbitrage Engine",true,"Pipeline: livro → liquidez → slippage → latência → net edge → risk → confidence → paper fill. "+e.detected+" avaliadas · "+e.validated+" validadas.")
  +"</div>";
}

function vRisk(){
  const e=S.lab.edge,g=S.lab;
  const byR=Object.entries(e.byReason||{});
  return '<h2>Risco</h2><div class="grid cards">'
  +card("Estado",g.safeMode?'<span class="neg">SAFE MODE</span>':"NORMAL",g.safeMode?"neg":"",g.safeMode?esc(g.safeReason||""):"")
  +card("Preset de risco",esc(g.preset))
  +card("Notional aberto",usdAbs(S.openNotionalUsd),"","cap "+usdAbs(S.risk.maxOpenNotionalUsd))
  +card("Perda diária máx",usdAbs(S.risk.maxDailyLossUsd))
  +card("Falhas seguidas",S.consecutiveFailures,"","cap "+S.risk.maxConsecutiveFailures)
  +card("False opportunity rate",e.detected?pct(e.rejected/e.detected,1):"n/a")
  +"</div>"+(byR.length?'<div class="section"><h2>Rejeições por motivo</h2><div class="card" style="padding:0"><table><tbody>'+byR.map(([k,v])=>'<tr><td><code>'+esc(k)+'</code></td><td class="muted">'+esc((({"NET_EDGE_TOO_LOW":"net edge abaixo do exigido","STALE_DATA":"dados stale","INSUFFICIENT_LIQUIDITY":"liquidez insuficiente","HIGH_SLIPPAGE":"slippage acima do limite","HIGH_LATENCY":"latência alta","EXCHANGE_DEGRADED":"exchange degradada","PARTIAL_FILL_RISK":"risco de fill parcial","VOLATILITY_TOO_HIGH":"volatilidade alta","RISK_LIMIT":"limite de risco","INVALID_ORDERBOOK":"livro inválido","DATA_QUALITY_LOW":"qualidade de dados baixa","SPREAD_ANOMALY":"spread anómalo vs cross-venue"})[k])||"")+'</td><td style="text-align:right">'+v+"</td></tr>").join("")+"</tbody></table></div></div>":"");
}

function vSettings(){
  const c=S.config;
  const authed=!!token||!!S.config.auth;
  const field=(k,l,v)=>'<div><label>'+esc(l)+' <code class="faint">'+esc(k)+'</code></label><input name="'+esc(k)+'" type="number" step="any" value="'+esc(v)+'" style="width:100%"></div>';
  const form=authed?'<form id="cfg" onsubmit="return saveCfg(event)"><div class="fgrid">'
  +field("spot.tradeUsd","Spot: tamanho $",c.spot.tradeUsd)+field("spot.minNetPct","Spot: net mín %",c.spot.minNetPct)+field("spot.minNetUsd","Spot: net mín $",c.spot.minNetUsd)
  +field("funding.positionUsd","Funding $/lado",c.funding.positionUsd)+field("funding.minNetAprPct","Funding APR mín %",c.funding.minNetAprPct)
  +field("triangular.tradeUsd","Triangular $",c.triangular.tradeUsd)+field("triangular.minNetPct","Triangular net mín %",c.triangular.minNetPct)
  +field("lab.baseEdgeBps","Edge base (bps)",c.lab.baseEdgeBps)+field("lab.maxSlippageBps","Slippage máx (bps)",c.lab.maxSlippageBps)
  +field("lab.maxLatencyMs","Latência máx (ms)",c.lab.maxLatencyMs)+field("lab.minFillProbability","Fill prob mín",c.lab.minFillProbability)
  +field("lab.minDataQuality","Data quality mín",c.lab.minDataQuality)+field("lab.opportunityTtlMs","TTL oportunidade (ms)",c.lab.opportunityTtlMs)
  +field("lab.safetyBufferPct","Safety buffer %",c.lab.safetyBufferPct)+field("lab.maxVolatilityBps","Volatilidade máx (bps)",c.lab.maxVolatilityBps)
  +field("daytrade.stakeUsd","Day-trade: stake $",c.daytrade.stakeUsd)+field("daytrade.minScore","Day-trade: score mín",c.daytrade.minScore)
  +field("daytrade.expiryMinutes","Day-trade: expiração (min)",c.daytrade.expiryMinutes)+field("daytrade.maxOpen","Day-trade: máx abertas",c.daytrade.maxOpen)
  +'</div><p><button class="btn primary" type="submit">Guardar e aplicar</button> <span class="muted" style="font-size:12px">persiste em data/overrides.json</span> <span id="cfgmsg"></span></p></form>'
  :'<p class="muted">Abre o painel com <code>?token=WEB_TOKEN</code> para editar config e controlar o robô.</p>';
  const liveErr=new URLSearchParams(location.search).get('live_err');
  const keys=S.keys||{};
  const keyRows=Object.entries(keys).map(([id,k])=>'<tr><td data-h="Exchange">'+esc(id)+'</td><td data-h="API key">'+(k.apiKey?badge("configurada","ok"):badge("em falta","bad"))+'</td><td data-h="Secret">'+(k.secret?badge("configurada","ok"):badge("em falta","bad"))+'</td><td data-h="Password">'+(k.password?badge("ok","ok"):badge("em falta","bad"))+'</td><td data-h="Pronta">'+(k.ready?badge("READY","ok"):badge("—","mut"))+"</td></tr>").join("");
  const liveCard='<div class="section"><h2>Trading real (LIVE)</h2><div class="card">'
  +(liveErr?'<p class="neg" style="margin-top:0">'+esc(liveErr)+"</p>":"")
  +'<p class="muted" style="margin-top:0">Em <b>LIVE</b> o robô coloca ordens reais nas tuas contas — pode lucrar OU perder dinheiro real. Sem lucros garantidos. Requer API keys com trading (SEM saque).</p>'
  +'<table class="resp"><thead><tr><th>Exchange</th><th>API key</th><th>Secret</th><th>Password</th><th>Estado</th></tr></thead><tbody>'+keyRows+"</tbody></table>"
  +(authed?(S.live
    ?'<form method="post" action="/api/live" style="margin-top:12px"><input type="hidden" name="token" value="'+esc(token)+'"><input type="hidden" name="enable" value="0"><button class="btn" type="submit">Voltar a PAPER</button></form>'
    :'<form method="post" action="/api/live" style="margin-top:12px" onsubmit="return confirm(\\'Ativar LIVE: o robô vai operar dinheiro real na tua conta. Continuar?\\')"><input type="hidden" name="token" value="'+esc(token)+'"><input type="hidden" name="enable" value="1"><label>Escreve <b>LIVE</b> para confirmar </label><input name="confirm" required style="width:110px"> <button class="btn danger" type="submit">ATIVAR LIVE</button></form>')
  :'<p class="muted">Login/token necessário para ativar LIVE.</p>')
  +"</div></div>";
  return '<h2>Bot control</h2><div class="card"><div class="statusbar">'
  +(S.blocked||S.lab.safeMode?dot("bad")+"<b>PAUSED</b>":dot("on")+"<b>RUNNING</b>")
  +'<span class="sstat"><span class="lbl">Modo</span>'+esc(S.mode)+'</span><span class="sstat"><span class="lbl">Risk profile</span>'+esc(S.lab.preset)+'</span><span class="sstat"><span class="lbl">Research</span>'+(S.lab.researchMode?"on":"off")+"</span></div>"
  +(authed?'<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn" onclick="ctl(\\'resume\\')">▶ Retomar</button><button class="btn danger" onclick="if(confirm(\\'PARAR o robô (kill switch)?\\'))ctl(\\'stop\\')">■ STOP BOT</button></div>':"")+"</div>"
  +liveCard
  +'<div class="section"><h2>Configuração</h2><div class="card">'+form+"</div></div>";
}

function vAdvanced(){
  const h=S.lab.exchangeHealth,e=S.lab.edge,t=S.lab.paper,ev=S.lab.recentEvents||[];
  return '<h2>Advanced / Research</h2><p class="muted" style="margin-top:-6px">Detalhe técnico do motor — dados normalizados, qualidade de sinal, execução simulada e saúde das feeds.</p>'
  +'<div class="section"><h2>Exchange health</h2><div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Exchange</th><th>Estado</th><th>Latência p95</th><th>Erros/min</th><th>Stale/min</th><th>429 (5m)</th><th>OB upd/s</th></tr></thead><tbody>'+Object.entries(h).map(([id,x])=>'<tr><td data-h="Exchange">'+esc(id)+'</td><td data-h="Estado">'+(x.status==="HEALTHY"?badge("HEALTHY","ok"):x.status==="DEGRADED"?badge("DEGRADED","warn"):badge(x.status,"bad"))+'</td><td data-h="p95">'+(x.apiLatencyP95Ms!=null?x.apiLatencyP95Ms+"ms":"—")+'</td><td data-h="Err">'+x.errorsPerMin+'</td><td data-h="Stale">'+x.stalePerMin+'</td><td data-h="429">'+x.rateLimitEvents5m+'</td><td data-h="OB/s">'+x.obUpdatesPerSec+"</td></tr>").join("")+"</tbody></table></div></div>"
  +'<div class="section"><h2>Edge engine & paper</h2><div class="grid cards">'
  +card("Detetadas",e.detected)+card("Validadas",e.validated)+card("Rejeitadas",e.rejected)+card("Expiradas (TTL)",e.expired)
  +card("Avg slippage",(t.avgSlippageBps??"n/a")+"bps")+card("Avg latência",(t.avgLatencyMs??"n/a")+"ms")+card("Avg fill rate",t.avgFillRate==null?"n/a":pct(t.avgFillRate,0))+card("Sharpe-like",t.sharpeLike??"n/a")
  +"</div></div>"
  +'<div class="section"><h2>Sistema</h2><div class="grid cards">'
  +card("Msgs/s",S.lab.tech.messagesPerSec)+card("OB updates/s",S.lab.tech.orderbookUpdatesPerSec)+card("Erros/min",S.lab.tech.errorsPerMin)+card("RAM",S.lab.tech.ramMb+"MB")+card("Uptime",ago(S.startedAt))
  +"</div></div>"
  +'<div class="section"><h2>Event log</h2>'+(ev.length?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Time</th><th>Type</th><th>Source</th><th>Payload</th></tr></thead><tbody>'+ev.map(x=>'<tr><td data-h="Time">'+dt(new Date(x.timestamp).toISOString())+'</td><td data-h="Type">'+esc(x.type)+'</td><td data-h="Src">'+esc(x.source)+'</td><td data-h="Payload" class="muted" style="font-size:12px">'+esc(JSON.stringify(x.payload).slice(0,160))+"</td></tr>").join("")+"</tbody></table></div>":empty("Sem eventos",""))+"</div>"
  +'<div class="section muted" style="font-size:12px"><a href="/api/status">/api/status</a> · <a href="/health">/health</a> · <a href="/metrics">/metrics</a></div>';
}

function vDaytrade(){
  const d=S.daytrade||{enabled:false};
  if(!d.enabled)return '<h2>Day Trade</h2>'+empty("Day trade desativado","Ativa com DAYTRADE_ENABLED=true nas variáveis de ambiente.");
  const st=d.stats||{},sigs=d.signals||{};
  const scoreBadge=(x)=>x==null?"—":(x.direction==="CALL"?badge("CALL "+(x.score>=0?"+":"")+x.score,"ok"):x.direction==="PUT"?badge("PUT "+x.score,"bad"):badge("—","mut"));
  const sigRows=Object.entries(sigs).map(([sym,x])=>'<tr><td data-h="Par">'+esc(sym)+'</td><td data-h="Preço">'+(x.price??"—")+'</td><td data-h="Sinal">'+scoreBadge(x)+'</td><td data-h="Concordância">'+pct(x.agreement,0)+'</td><td data-h="Megabrain" class="muted" style="font-size:12px">'+(x.parts||[]).map(p=>esc(p.book.split(" (")[0])+" "+(p.score>=0?"+":"")+p.score).join(" · ")+"</td></tr>").join("");
  const openRows=(d.open||[]).map(o=>'<tr><td data-h="Aberta">'+hhmm(o.ts)+'</td><td data-h="Par">'+esc(o.symbol)+'</td><td data-h="Dir">'+(o.direction==="CALL"?badge("CALL","ok"):badge("PUT","bad"))+'</td><td data-h="Stake">'+usdAbs(o.stakeUsd)+'</td><td data-h="Entry">'+o.entry+'</td><td data-h="Expira">'+ago(new Date(Date.parse(o.expiresAt)+0).toISOString())+' ('+o.expiryMinutes+'m)</td><td data-h="Score">'+o.score+"</td></tr>").join("");
  const closedRows=(d.closed||[]).map(o=>'<tr><td data-h="Fechada">'+dt(o.closedAt||o.expiresAt)+'</td><td data-h="Par">'+esc(o.symbol)+'</td><td data-h="Dir">'+(o.direction==="CALL"?badge("CALL","ok"):badge("PUT","bad"))+'</td><td data-h="Stake">'+usdAbs(o.stakeUsd)+'</td><td data-h="Entry→Exit">'+o.entry+" → "+o.exit+'</td><td data-h="Resultado">'+(o.result==="WIN"?badge("WIN","ok"):badge("LOSS","bad"))+'</td><td data-h="P&L" class="'+pcls(o.pnlUsd)+'">'+usd(o.pnlUsd)+"</td></tr>").join("");
  return '<h2>Day Trade '+(d.mode==="LIVE"?'<span class="mode-tag live">LIVE</span>':'<span class="mode-tag">PAPER</span>')+'</h2>'
  +'<p class="muted" style="margin-top:-6px">Operações direcionais de '+d.expiryMinutes+' min em '+esc(d.exchange)+' — megabrain de confluência decide CALL/PUT; vitória paga '+Math.round(d.payoutPct*100)+'% do stake, derrota perde o stake.</p>'
  +'<div class="grid cards">'
  +card("PNL day-trade",usd(st.pnlUsd),pcls(st.pnlUsd),(st.wins||0)+"W / "+(st.losses||0)+"L")
  +card("Win rate",st.winRate==null?"n/a":pct(st.winRate,1))
  +card("Operações abertas",st.open||0)
  +card("Fechadas",st.closed||0)
  +card("Staked total",usdAbs(st.stakedUsd))
  +card("Perda hoje",usdAbs(st.dailyLossUsd),"neg")
  +'</div>'
  +'<div class="section"><h2>Sinais do megabrain</h2>'+(sigRows?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Par</th><th>Preço</th><th>Sinal</th><th>Concordância</th><th>Contribuições</th></tr></thead><tbody>'+sigRows+"</tbody></table></div>":empty("Sem sinais ainda","O megabrain avalia cada símbolo a cada ciclo."))+"</div>"
  +'<div class="section"><h2>Operações abertas</h2>'+(openRows?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Aberta</th><th>Par</th><th>Direção</th><th>Stake</th><th>Entry</th><th>Expira em</th><th>Score</th></tr></thead><tbody>'+openRows+"</tbody></table></div>":empty("No open operations","Novas operações abrem quando o score e a concordância passam os filtros."))+"</div>"
  +'<div class="section"><h2>Operações fechadas</h2>'+(closedRows?'<div class="card" style="padding:0;overflow:auto"><table class="resp"><thead><tr><th>Fechada</th><th>Par</th><th>Direção</th><th>Stake</th><th>Entry→Exit</th><th>Resultado</th><th>P&L</th></tr></thead><tbody>'+closedRows+"</tbody></table></div>":empty("No closed operations","As operações resolvem na expiração (5–30 min)."))+"</div>";
}

const RENDER={dashboard:vDashboard,daytrade:vDaytrade,transactions:vTransactions,investments:vInvestments,performance:vPerformance,opportunities:vOpportunities,strategies:vStrategies,risk:vRisk,settings:vSettings,advanced:vAdvanced};

async function ctl(kind){try{await fetch("/api/"+kind,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"token="+encodeURIComponent(token)});setTimeout(load,400)}catch(e){}}
async function saveCfg(ev){ev.preventDefault();const fd=new FormData(ev.target);fd.set("token",token);const r=await fetch("/api/config",{method:"POST",body:new URLSearchParams(fd)});document.getElementById("cfgmsg").textContent=r.ok?"✓ aplicado":"erro "+r.status;return false}

function render(){
  document.getElementById("nav").innerHTML=VIEWS.map(([id,l])=>'<a href="#'+id+'" class="'+(route===id?"active":"")+'">'+l+"</a>").join("");
  if(!S)return;
  const blocked=S.blocked||S.lab.safeMode;
  document.getElementById("hdrStatus").innerHTML='<span class="pill">'+(blocked?dot("bad")+"PAUSED":dot("on")+"RUNNING")+"</span>";
  document.getElementById("hdrMode").innerHTML='<span class="mode-tag'+(/SIMULA/i.test(S.mode)?" sim":(/LIVE/.test(S.mode)&&!/PAPER/.test(S.mode)?" live":""))+'">'+esc(S.mode)+"</span>";
  document.getElementById("hdrMeta").textContent="uptime "+ago(S.startedAt)+" · atualiza 5s";
  if(S.config.auth)document.getElementById("hdrMeta").innerHTML+=' · <a href="/logout" style="color:var(--muted)">sair</a>';
  document.getElementById("view").innerHTML=RENDER[route]();
}
async function load(){try{const r=await fetch("/api/status");if(!r.ok)throw 0;S=await r.json();render()}catch(e){document.getElementById("view").innerHTML='<div class="empty"><div class="t">Data feed interrupted</div><div class="muted">A retentar ligação ao bot…</div></div>'}}
addEventListener("hashchange",()=>{route=(location.hash||"#dashboard").slice(1);if(!RENDER[route])route="dashboard";render()});
load();setInterval(load,5000);
</script>
</body></html>`;

export const LOGIN_PAGE = `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — Arbitrage Bot</title>
<style>
body{margin:0;background:#0d0f13;color:#e8eaee;font:14px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#14171d;border:1px solid #232833;border-radius:12px;padding:30px;width:320px}
h1{font-size:17px;margin:0 0 4px}p{color:#7d8697;font-size:12.5px;margin:0 0 18px}
label{display:block;font-size:11.5px;color:#7d8697;margin:0 0 4px}
input{width:100%;background:#0d0f13;color:#e8eaee;border:1px solid #232833;border-radius:7px;padding:9px 10px;font-size:14px;box-sizing:border-box;margin-bottom:12px}
button{width:100%;padding:10px;border-radius:8px;border:1px solid #2b528a;background:#1d3a5f;color:#e8eaee;font-size:14px;font-weight:600;cursor:pointer}
.err{background:rgba(255,107,107,.13);color:#ff6b6b;border-radius:7px;padding:8px 10px;font-size:12.5px;margin-bottom:12px;display:none}
</style>
</head>
<body>
<form class="box" method="post" action="/login">
<h1>Arbitrage Bot</h1>
<p>Login para aceder ao painel</p>
<div class="err" id="e">Utilizador ou password incorretos.</div>
<label>Utilizador</label><input name="user" autocomplete="username" required>
<label>Password</label><input name="pass" type="password" autocomplete="current-password" required>
<button type="submit">Entrar</button>
</form>
<script>if(new URLSearchParams(location.search).get('err'))document.getElementById('e').style.display='block'</script>
</body></html>`;
