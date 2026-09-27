/**
 * Scanner de oportunidades (não precisa de chaves API).
 *   npm run scan            -> uma passagem, imprime tabelas
 *   npm run scan -- --watch -> repete a cada 10s
 *   npm run scan -- --sim   -> dados sintéticos
 */
import { config } from './config.js';
import { createExchanges, commonSpotSymbols, EXCHANGE_IDS, other } from './exchanges.js';
import { FundingArbStrategy } from './strategies/fundingArb.js';
import { evaluateSpotArb, pct, usd } from './math.js';

const watch = process.argv.includes('--watch');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.f(r)).length)));
  const line = (cells) => cells.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c.h)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => c.f(r))));
}

async function scanSpot(exs) {
  const symbols = commonSpotSymbols(exs, config.spot.symbols);
  const [tb, tn] = await Promise.all([exs.bybit.fetchBidsAsks(symbols), exs.binance.fetchBidsAsks(symbols)]);
  const q = { bybit: tb, binance: tn };
  const rows = [];
  for (const s of symbols) {
    for (const buyId of EXCHANGE_IDS) {
      const sellId = other(buyId);
      const a = q[buyId][s]?.ask;
      const b = q[sellId][s]?.bid;
      if (!a || !b) continue;
      rows.push({ s, buyId, sellId, ask: a, bid: b, grossPct: (b - a) / a });
    }
  }
  rows.sort((x, y) => y.grossPct - x.grossPct);
  const fees = exs.bybit.fees_.spotTaker + exs.binance.fees_.spotTaker;
  console.log(`\n=== SPOT (topo do livro) — taxas ida+volta ${pct(fees)} | limiar execução ${pct(fees + config.spot.minNetPct + config.spot.slippageBufferPct)} ===`);
  table(rows.slice(0, 15), [
    { h: 'Par', f: (r) => r.s },
    { h: 'Comprar em', f: (r) => exs[r.buyId].label },
    { h: 'Ask', f: (r) => r.ask.toPrecision(7) },
    { h: 'Vender em', f: (r) => exs[r.sellId].label },
    { h: 'Bid', f: (r) => r.bid.toPrecision(7) },
    { h: 'Spread bruto', f: (r) => pct(r.grossPct, 4) },
    { h: 'Líquido (após taxas)', f: (r) => pct(r.grossPct - fees, 4) },
  ]);

  // profundidade real para os 3 melhores
  const best = rows.slice(0, 3).filter((r) => r.grossPct > 0);
  for (const r of best) {
    const [obBuy, obSell] = await Promise.all([exs[r.buyId].fetchOrderBook(r.s, 20), exs[r.sellId].fetchOrderBook(r.s, 20)]);
    const ev = evaluateSpotArb({
      buyAsks: obBuy.asks,
      sellBids: obSell.bids,
      tradeUsd: config.spot.tradeUsd,
      buyFee: exs[r.buyId].fees_.spotTaker,
      sellFee: exs[r.sellId].fees_.spotTaker,
      slippageBuffer: config.spot.slippageBufferPct,
    });
    if (ev?.ok) {
      console.log(
        `  ${r.s} com ${usd(config.spot.tradeUsd)}: VWAP compra ${ev.buyPrice.toPrecision(7)} / venda ${ev.sellPrice.toPrecision(7)} -> líquido ${pct(ev.netPct, 4)} = ${usd(ev.net, 4)}`,
      );
    }
  }
}

async function scanFunding(exs) {
  const strat = new FundingArbStrategy(exs);
  const rates = await strat.fetchRates();
  const volumes = await strat.fetchVolumes();
  const ranked = strat.rank(rates, volumes);
  console.log(`\n=== FUNDING (perp vs perp) — ${ranked.length} pares comuns | hold esperado ${config.funding.expectedHoldHours}h ===`);
  table(ranked.slice(0, 15), [
    { h: 'Par', f: (r) => r.symbol.split(':')[0] },
    { h: 'Bybit 8h', f: (r) => pct(r.rates.bybit.rate8h, 4) },
    { h: 'Binance 8h', f: (r) => pct(r.rates.binance.rate8h, 4) },
    { h: 'Spread 8h', f: (r) => pct(r.spread8h, 4) },
    { h: 'Short em', f: (r) => exs[r.shortId].label },
    { h: 'Basis', f: (r) => pct(r.basisPct, 3) },
    { h: 'APR bruto', f: (r) => pct(r.grossAprPct, 1) },
    { h: 'APR líquido', f: (r) => pct(r.netAprPct, 1) },
    { h: 'Break-even', f: (r) => (Number.isFinite(r.breakEvenHours) ? `${r.breakEvenHours.toFixed(1)}h` : '∞') },
    { h: 'Vol 24h', f: (r) => (r.volume ? `$${(r.volume / 1e6).toFixed(1)}M` : 'n/a') },
  ]);
}

async function main() {
  const exs = await createExchanges();
  do {
    console.log(`\n${new Date().toISOString()} — modo ${config.simulate ? 'SIM' : 'REAL (leitura)'}`);
    if (config.spot.enabled) await scanSpot(exs);
    if (config.funding.enabled) await scanFunding(exs);
    if (watch) await sleep(10_000);
  } while (watch);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
