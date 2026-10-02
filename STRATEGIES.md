# Estratégias

As estratégias vivem em `src/strategies/` e emitem candidatos que o edge engine
(`src/edge/engine.js`) valida antes de qualquer execução. Um spread bruto
positivo **não** significa oportunidade.

## CrossExchangeStrategy (`spotArb.js`)

- Varre `SPOT_SYMBOLS` em todas as exchanges de `EXCHANGES` (todos os pares
  ordenados buy→sell).
- Candidatos com gross spread acima de `taxas + minNet + buffer` vão a
  `fetchOrderBook` e ao edge engine.
- O engine calcula VWAP executável real (não best bid/ask), fees, slippage
  conservador, latency buffer, safety buffer e compara o **net edge** com o
  **required edge dinâmico** (regime + volatilidade + latência).
- VALIDATED → paper trade (default) ou IOC paralelo (live). Em live, uma perna
  falhada é revertida a mercado (`unwind`).

## TriangularStrategy (`triangularArb.js`)

- Rotas `USDT → X → BTC → USDT` e inversa dentro de uma exchange, para cada base
  com mercados `X/USDT`, `X/BTC`, `BTC/USDT`.
- `evaluateTriangleRoute` consome os livros em sequência (saída de uma perna
  alimenta a próxima) com 3 taxas taker.
- Em live, executa pernas IOC sequenciais e reverte para USDT em falha.
- Margens naturalmente finas — desativada por defeito (`TRI_ARB_ENABLED`).

## FundingArbStrategy (`fundingArb.js`)

- Delta-neutro: long no perp com funding mais baixo, short no mais alto,
  escolhendo a melhor combinação entre todas as exchanges ativas.
- Critérios: spread 8h mínimo, APR líquido mínimo, basis máximo, volume 24h,
  saída quando o spread colapsa ou após `FUNDING_MAX_HOLD_HOURS`.
- Em live tenta entrada maker (post-only) opcional.

## Interface de estratégia

Cada estratégia implementa `tick()` periódico. O pipeline comum fornece
scan → validate → simulate → score → explain através de:

- `edge.evaluateCrossExchange` — validação + veredicto + explicação
- `paper.execute` — execução simulada com fills parciais
- `governor.gate` — filtro de risco global

Novas estratégias devem reutilizar este pipeline em vez de calcular lucro por
conta própria.

## Veredictos e reason codes

VALIDATED | REJECTED com um de: `NET_EDGE_TOO_LOW`, `STALE_DATA`,
`INSUFFICIENT_LIQUIDITY`, `HIGH_SLIPPAGE`, `HIGH_LATENCY`, `EXCHANGE_DEGRADED`,
`PARTIAL_FILL_RISK`, `VOLATILITY_TOO_HIGH`, `RISK_LIMIT`, `INVALID_ORDERBOOK`,
`DATA_QUALITY_LOW`, `SPREAD_ANOMALY`. Cada veredicto inclui `explanation` com
spreadReason/feeReason/slippageReason/latencyReason/liquidityReason/riskReason/
finalDecision — visível no painel em "WHY VALID/REJECTED".

## Confidence score

0-100, combinação ponderada de: qualidade de dados, profundidade dos livros,
probabilidade de fill, slippage estimado, volatilidade, latência e margem sobre
o edge exigido. Os fatores positivos e negativos são sempre mostrados. Um score
alto **não** é probabilidade garantida de lucro.
