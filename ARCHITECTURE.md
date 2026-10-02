# Arquitetura

## Visão geral

O sistema é um laboratório de arbitragem quantitativa. O modo por defeito é
**PAPER TRADING** — dados reais, execução simulada. Ordens reais só com `--live`
(e `LIVE=true` + chaves API). Nada no sistema promete lucro garantido: cada
sinal é validado, pontuado e explicado.

## Pipeline

```
RAW MARKET DATA
→ DATA NORMALIZATION        src/market-data/normalize.js
→ ORDER BOOK VALIDATION     src/edge/depth.js
→ LIQUIDITY ANALYSIS        src/edge/depth.js (VWAP por tamanhos, fill prob.)
→ EXECUTION SIMULATION      src/paper/engine.js
→ FEE MODEL                 config por exchange (*_MAKER/TAKER_FEE)
→ SLIPPAGE MODEL            src/edge/slippage.js
→ LATENCY MODEL             timestamps exchange vs receção (normalize.js)
→ NET EDGE                  src/edge/engine.js
→ RISK FILTER               src/risk/governor.js + src/risk.js
→ CONFIDENCE SCORE          src/edge/engine.js (0-100 + fatores)
→ PAPER EXECUTION           src/paper/engine.js
→ POST-TRADE ANALYTICS      src/paper/engine.js stats + /api/status
```

## Módulos

| Caminho | Papel |
|---|---|
| `src/config.js` | Configuração central + presets + overrides runtime |
| `src/exchanges.js` | Clients ccxt (bybit/binance/okx/kucoin) ou mocks, instância única por exchange |
| `src/market-data/normalize.js` | NormalizedMarketData, freshness, dataQualityScore, anomalias de clock |
| `src/market-data/health.js` | Saúde por exchange: HEALTHY/DEGRADED/UNSTABLE/OFFLINE |
| `src/edge/depth.js` | VWAP executável, depth THIN/NORMAL/DEEP, fill probability |
| `src/edge/slippage.js` | Modelo de slippage + histórico P50/P90/P99 |
| `src/edge/engine.js` | Net edge, required edge dinâmico, confidence, TTL, explicação, reason codes |
| `src/risk/regime.js` | Market regime detector |
| `src/risk/governor.js` | RiskGovernor — SAFE_MODE e limites globais |
| `src/risk.js` | Circuit breakers originais (kill switch, perda diária, falhas) |
| `src/paper/engine.js` | Paper trading: fills parciais, P&L, estatísticas |
| `src/backtest/` | Replay, stress matrix, walk-forward, recorder, CLI |
| `src/events.js` | Event log JSONL + contadores para /metrics |
| `src/lab.js` | Instâncias partilhadas do laboratório (singletons) |
| `src/strategies/` | spotArb (edge engine), fundingArb (funding delta-neutro), triangularArb |
| `src/server.js` | Dashboard + /api/status + /health + /metrics + config runtime |
| `src/mock.js` | Exchange sintética para `--sim` |

## Modos

| Modo | Como | O que faz |
|---|---|---|
| PAPER TRADING (default) | `npm start` | Valida sinais e executa em simulação com fills parciais |
| RESEARCH | `RESEARCH_MODE=true` ou `CONFIG_PRESET=research` | Só mede qualidade de sinal; nunca executa |
| SIMULAÇÃO | `npm run sim` | Dados sintéticos (mocks), sem rede |
| DRY-RUN legado | dry-run = paper sem live | — |
| LIVE | `npm run live` (+ chaves) | Ordens reais IOC; unwind em falha de perna |
| DEMO | `DEMO_TRADING=true` | Contas demo das exchanges |

## Fluxo de uma oportunidade spot

1. `spotArb.tick()` busca `fetchBidsAsks` em todas as exchanges → `normalizeTicker`
   (freshness, anomalias) → `slippage.observeMid` (volatilidade) → `health`.
2. Candidatos com gross spread acima do limiar bruto passam a `evaluateAndExecute`.
3. `fetchOrderBook` → `normalizeBook` → `edge.evaluateCrossExchange`:
   freshness → data quality → livros → VWAP executável → fees → slippage
   conservador → latency buffer → safety buffer → required edge por regime →
   confidence → governor gate → veredicto VALID/REJECTED + explicação.
4. VALIDATED → paper trade (fills parciais) em paper mode, ou IOC paralelo em live.
5. TTL: oportunidades no pipeline expiram (`EXPIRED`) e contam para métricas.

## Persistência (DATA_DIR)

- `state.json` / `state.sim.json` — estado do robô
- `trades.jsonl` — trades (paper/live)
- `paper-trades.jsonl` — execuções simuladas detalhadas
- `events.jsonl` — eventos estruturados (correlationId)
- `frames-*.jsonl` — order books gravados para replay (`RECORD_MARKET_DATA=true`)
- `overrides.json` — config aplicada em runtime pelo painel
