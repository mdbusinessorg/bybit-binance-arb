# Modelo de risco

Duas camadas: circuit breakers operacionais (`src/risk.js`) e o RiskGovernor
(`src/risk/governor.js`), que controla o sistema inteiro.

## Circuit breakers (risk.js)

- Kill switch por ficheiro (`KILL_SWITCH_FILE`, default `./STOP`) ou botão web.
- Perda diária máxima → halt automático (`daily-loss`), reset à meia-noite UTC.
- Falhas de execução consecutivas → halt.
- Limite de trades/hora e notional aberto máximo (posições funding).

## RiskGovernor

Limites configuráveis (`MAX_*` do bloco lab):

- `MAX_SIMULTANEOUS_SIMULATIONS` — simulações em paralelo
- `MAX_DAILY_SIMULATED_LOSS_USD` — perda simulada diária → SAFE_MODE
- `MAX_DATA_AGE_MS` / `MAX_LATENCY_MS` / `MAX_SLIPPAGE_BPS` — gates por sinal
- exchange degradada (`health.ok`) → sinais dessa venue rejeitados

SAFE_MODE interrompe novas simulações até recuperação (exchanges de volta a
HEALTHY e perda simulada diária dentro do limite). `src/risk.js` continua a
controlar execuções reais em live.

## Market regime

`src/risk/regime.js` classifica cada oportunidade:

| Regime | Condição | Efeito |
|---|---|---|
| NORMAL | — | edge e tamanho base |
| LOW_LIQUIDITY | depth < 25% da referência | edge ×1.5, tamanho ×0.5 |
| HIGH_VOLATILITY | vol ≥ 40bps | edge ×1.75, tamanho ×0.5 |
| EXTREME_VOLATILITY | vol ≥ 100bps | edge ×3, tamanho ×0.25 |
| DISLOCATED | mid cross-venue difere ≥ 1.5% | edge ×2 — provável erro de dados |
| DATA_DEGRADED | snapshots stale/degraded | sinais desativados |
| EXCHANGE_DEGRADED | venue UNSTABLE/OFFLINE | sinais desativados |

Limiares em `REGIME_*` no `.env`.

## Required edge dinâmico

```
requiredEdgeBps = (BASE_EDGE_BPS + feesBps
                 + volatilityBuffer + latencyBuffer + EXECUTION_BUFFER_BPS)
                 × regimeEdgeFactor
```

Uma oportunidade só é VALIDATED se `netEdgeBps ≥ requiredEdgeBps` **e**
`netUsd ≥ LAB_MIN_NET_USD` — spreads positivos com edge líquido negativo são
sempre rejeitados.

## Saúde das exchanges

`src/market-data/health.js` monitora por venue: latência de API (p95),
erros/min, dados stale/min, eventos 429 (5min), updates de order book/s e erros
consecutivos. Transições HEALTHY → DEGRADED → UNSTABLE → OFFLINE são
registadas como `risk_event`. Erros 429 respeitam backoff (o loop principal
aumenta o intervalo automaticamente); não há contorno de rate limits.

## TTL e staleness

Cada oportunidade tem `expiresAt` (`OPPORTUNITY_TTL_MS`). Snapshots com
`dataAgeMs` acima de `DATA_FRESHNESS_MS` ficam STALE e não geram sinais;
acima de `DATA_DEGRADED_MS`/`DATA_OFFLINE_MS` degradam ainda mais. Timestamps
futuros/negativos são `TIMESTAMP_ANOMALY`/`FUTURE_TIMESTAMP` e a métrica de
latência é rejeitada.

## Execução live

Ordens IOC paralelas com tolerância de preço (`SPOT_IOC_TOL_PCT`). Divergência
entre pernas acima de `SPOT_LEG_MISMATCH_TOL_PCT` → unwind a mercado da perna
preenchida + `unbalanced` registado. Triangular: unwind converte resíduos para
USDT via mercado `X/USDT`.
