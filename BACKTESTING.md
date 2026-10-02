# Backtesting, replay e stress testing

## Fontes de dados

- **Frames gravados**: `RECORD_MARKET_DATA=true` grava `{t, books}` por tick em
  `data/frames-YYYYMMDD.jsonl`. O replay reproduz esses dados como se fossem
  tempo real.
- **Sintéticos**: `--synthetic` gera um stream reproduzível (seed fixa) sem rede.

## Comandos

```bash
npm run backtest                        # replay dos frames gravados (ou sintéticos)
npm run backtest -- --synthetic --frames 800 --symbol BTC/USDT
npm run backtest -- --file data/frames-2026-10-02.jsonl
npm run backtest -- --stress            # matriz de stress
npm run backtest -- --walkforward       # janelas train/validation/out-of-sample
```

## Sem look-ahead

Cada decisão usa apenas o snapshot do próprio frame (`detectedAt = t` do frame).
As oportunidades têm TTL e expiram (`EXPIRED`) quando o relógio do replay passa
`expiresAt`. O teste `sem look-ahead` em `test/lab.test.js` verifica
determinismo e que nenhum trade usa dados de frames futuros. Separação
TRAINING/VALIDATION/OUT-OF-SAMPLE é feita pelo walk-forward (janelas sobre o
stream cronológico, nunca baralhado).

## Stress testing (`--stress`)

Cenários executados sobre o mesmo stream:

`BASE`, `+10% slippage`, `+25% slippage`, `+50% slippage`, `2x latency`,
`3x latency`, `lower liquidity` (fill prob ×0.5), `2x fees`.

Objetivo: descobrir se a estratégia depende de condições perfeitas. Se o P&L só
existe no cenário BASE, o sinal é ilusório.

## Métricas do replay

- sinais simulados / rejeitados por reason code / expirados (TTL)
- **falseOpportunityRate** = (rejected + expired) / total de oportunidades
- paper stats: net P&L, win rate, profit factor, max drawdown, avg slippage,
  avg latência, fill rate, distribuição de retornos, sharpe-like
- signal quality vs execution quality: uma estratégia pode detetar bons
  spreads e ter execução péssima — o painel separa as duas métricas

## Walk-forward (`--walkforward`)

Divide o stream em janelas sequenciais (default: 4 janelas, step de metade) e
corre o replay em cada uma — primeira janela = TRAINING, seguintes =
VALIDATION. Resultados lado a lado por janela para detetar sobre-ajustamento.
