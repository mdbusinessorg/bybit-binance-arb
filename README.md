# Robô de arbitragem multi-exchange

Robô autónomo que monitoriza exchanges em tempo real e executa **apenas** quando o lucro
líquido — depois de taxas, slippage e profundidade real do livro — é positivo. Exchanges
suportadas: **Bybit, Binance, OKX, KuCoin** (2 ou mais, via `EXCHANGES`). Três estratégias:

| Estratégia | Como funciona | Capital necessário |
|---|---|---|
| **Spot cross-exchange** | Compra no *ask* da exchange mais barata e vende no *bid* da mais cara, em simultâneo, entre **todos os pares** das exchanges ativas. Sem transferências on-chain. | USDT **e** a moeda nas exchanges (pré-financiado) |
| **Funding-rate (delta-neutro)** | Long no perpétuo com funding mais baixo, short no com funding mais alto — escolhe a melhor combinação de exchanges por símbolo. Ganha a diferença de funding a cada 8h, sem exposição direcional. | USDT na conta de derivados |
| **Triangular intra-exchange** | USDT → X → BTC → USDT (e inverso) numa só exchange. Três taxas taker, margens finas — desativada por defeito (`TRI_ARB_ENABLED`). | Só USDT na exchange |

Por defeito arranca em **PAPER TRADING** (dados reais, execução simulada com fills parciais,
slippage conservador e explainability). Ordens reais só com `npm run live`. `RESEARCH_MODE=true`
mede apenas a qualidade dos sinais. Documentação: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[STRATEGIES.md](STRATEGIES.md) · [RISK.md](RISK.md) · [BACKTESTING.md](BACKTESTING.md)

## Instalação

```bash
npm install
cp .env.example .env    # editar taxas, limites e (mais tarde) chaves API
```

Requer Node.js ≥ 20.

## Comandos

```bash
npm run scan             # tabela única de spreads spot + funding (dados reais, sem chaves)
npm run scan -- --watch  # idem, a atualizar continuamente
npm run scan -- --sim    # dados sintéticos (sem rede)

npm run sim              # robô completo com mercado sintético — para ver a lógica a funcionar
npm start                # PAPER TRADING com dados reais: valida, "executa" em simulação, regista P&L
npm run research         # RESEARCH MODE — só análise de qualidade de sinais, zero execução
npm run live             # LIVE — ordens reais (exige chaves; espera 5 s antes de começar)

npm run backtest                      # replay dos frames gravados (ou sintéticos)
npm run backtest -- --stress          # matriz de stress (slippage/latência/liquidez/taxas)
npm run backtest -- --walkforward     # janelas train/validation/out-of-sample

npm run status           # P&L, trades, posições abertas, circuit breaker
npm run status -- --resume   # retoma após paragem por circuit breaker / kill switch
npm test                 # testes unitários (matemática, edge engine, executor, backtest)
```

**Kill switch:** cria um ficheiro `STOP` na pasta do projeto e o robô deixa de abrir posições imediatamente.

## Como decide (o que a pesquisa mostrou que faz perder dinheiro)

A arbitragem cross-exchange é dominada por bots de baixa latência; a maior parte das "oportunidades" vistas
num ticker desaparecem quando se somam os custos. O robô só executa quando **todos** os filtros passam:

1. **Taxas de ida e volta** — spot Bybit 0,10 % + Binance 0,10 % = **0,20 %** por operação (defaults; ajusta
   no `.env` à tua conta — com BNB na Binance baixa para 0,075 %). Perps: 0,055 % / 0,05 % taker.
2. **Profundidade real do livro (VWAP)** — o preço é calculado consumindo os níveis do *order book* para o
   tamanho da ordem, não o topo do livro. Sem liquidez suficiente → rejeita.
3. **Margem de slippage** (`SPOT_SLIPPAGE_BUFFER_PCT`, 0,03 %) — cobre o movimento entre ler o livro e a
   ordem chegar à exchange.
4. **Lucro líquido mínimo** (`SPOT_MIN_NET_PCT` 0,15 % **e** `SPOT_MIN_NET_USD` $0,05) — com os defaults, o
   spread bruto tem de ser ≥ **0,38 %** para executar. Isto é raro em BTC/ETH e mais comum em altcoins
   de menor capitalização (por isso a lista de símbolos inclui SUI, TIA, SEI, WIF, PEPE…).
5. **Sanidade de dados** — spreads > 3 % são tratados como dados errados; dados com mais de 5 s são
   descartados.
6. **Saldo pré-financiado** — confirma que há USDT no lado da compra e a moeda no lado da venda antes de
   disparar. Nunca transfere entre exchanges (transferência on-chain demora minutos e mata a oportunidade).

Funding-rate:

- Normaliza intervalos diferentes (Bybit/Binance usam 1h, 4h ou 8h em alguns pares) para **8h** antes de comparar.
- Calcula **basis** (diferença de preço entre os dois perps): se o long está mais caro que o short, isso é um
  custo escondido que entra no cálculo.
- **Break-even em horas** = taxas de abrir+fechar ÷ spread de funding. Só abre se o APR líquido para o
  `FUNDING_EXPECTED_HOLD_HOURS` (24h) for ≥ 15 %.
- Fecha quando o spread desaparece durante 3 verificações seguidas ou ao fim de 72h.
- Em live, vigia a margem de cada perna (`FUNDING_MARGIN_ALERT_RATIO`) para evitar liquidação de um lado.

## Execução em live — o que acontece quando corre mal

As duas pernas são enviadas **em paralelo** como ordens **IOC limitadas** (nunca ficam pendentes a um preço
pior que o calculado). Depois:

- Se uma perna encheu e a outra não (ou encheu parcialmente), o robô **desfaz o excesso a mercado**
  imediatamente para voltar a neutro e regista o trade como perda.
- Se o desfazer também falhar, marca a operação como `unbalanced`, envia alerta Telegram e conta uma falha.
- 3 falhas seguidas, perda diária ≥ `MAX_DAILY_LOSS_USD` ou > `MAX_TRADES_PER_HOUR` → **para tudo**
  (circuit breaker). Retoma com `npm run status -- --resume` depois de perceberes o que aconteceu.

## Gestão de risco (defaults)

| Limite | Default |
|---|---|
| Tamanho por trade spot | $50 |
| Tamanho por perna funding | $100, alavancagem 2x |
| Perda diária máxima | $10 |
| Notional aberto máximo | $500 |
| Falhas seguidas até parar | 3 |
| Máx. posições funding abertas | 3 |

Começa **pequeno**. Em live, corre primeiro 1–2 dias com estes valores e compara `npm run status` com o extrato
real das exchanges antes de aumentar.

## Chaves API (para live)

- Permissões: **Spot trading + Derivatives/Futures trading + leitura**. **Nunca** ativar *Withdraw*.
- Ativar **restrição por IP** com o IP da máquina onde o robô corre.
- Bybit: usar Unified Trading Account (UTA). Binance: ativar Futures na conta e passar USDT para a carteira de Futures.
- OKX e KuCoin exigem também a **passphrase** da API (`OKX_API_PASSWORD` / `KUCOIN_API_PASSWORD`).
- Nunca colocar chaves no código — só em `.env` (ignorado pelo git) ou variáveis de ambiente.
- `DEMO_TRADING=true` liga às contas demo das duas exchanges para testar execução real sem dinheiro
  (precisa de chaves criadas nas contas demo).

## Correr na nuvem (24/7, sem depender do teu PC)

O robô é um processo único com um **painel web** embutido (`PORT`), por isso corre em qualquer host de
containers. Ficheiros incluídos:

| Ficheiro | Para |
|---|---|
| `Dockerfile` | qualquer plataforma Docker |
| `fly.toml` | [Fly.io](https://fly.io) — permite escolher a **região** (importante, ver abaixo); volume persistente para `data/` |
| `render.yaml` | [Render](https://render.com) — Blueprint com disco persistente (região `frankfurt`, testada OK) |
| `docker-compose.yml` | VPS próprio (Hetzner, Contabo, DigitalOcean…) |

### Fly.io (recomendado — controlo da região)

```bash
# instalar: https://fly.io/docs/flyctl/install/
fly auth login
fly launch --no-deploy --copy-config --name bybit-binance-arb --region nrt   # ou fra/cdg/gru/syd
fly volumes create arb_data --region nrt --size 1
fly secrets set WEB_TOKEN=um-segredo-longo
# (mais tarde, para live) fly secrets set BYBIT_API_KEY=... BYBIT_API_SECRET=... BINANCE_API_KEY=... BINANCE_API_SECRET=... LIVE=true
fly deploy
fly logs          # deve mostrar "mercados carregados" para Bybit e Binance
fly open          # painel: https://bybit-binance-arb.fly.dev/?token=um-segredo-longo
```

Sem chaves e sem `LIVE=true` a instância corre em **dry-run com dados reais** — é exatamente o que queres para
os primeiros dias: ver quantas oportunidades reais aparecem e qual seria o P&L, sem risco.

### Painel web

- `/` — P&L de hoje/total, **gráfico de P&L acumulado**, trades, posições funding, histórico de oportunidades avaliadas, circuit breaker; auto-refresh 15 s.
- `/?token=WEB_TOKEN` — o mesmo, com botões **Parar (kill switch)**, **Retomar** e edição de **configuração em runtime** (limiares e tamanhos; persiste em `data/overrides.json`).
- `/api/status` — JSON; `/health` — para health checks da plataforma.

O ficheiro kill switch e o estado vivem em `DATA_DIR` (`/app/data` no container) — monta um volume persistente
senão perdes o histórico a cada redeploy (os `fly.toml`/`render.yaml`/`docker-compose.yml` já o fazem).

### Restrições regionais (importante)

Ambas as exchanges bloqueiam pedidos API de certos países (Binance devolve `451`, Bybit `403` via CloudFront).
O robô deteta isso no arranque e termina com a mensagem `API bloqueada para a região deste servidor` — nesse caso
**muda a região do deploy**. Regiões conhecidas por serem bloqueadas por pelo menos uma das duas: EUA, Reino
Unido, Canadá, Países Baixos, Singapura, Hong Kong. Teste real feito em 2026-09 a partir de máquinas Fly.io
(GET público às duas APIs): **OK** `nrt` (Tóquio), `fra`, `cdg`, `gru`, `syd` · **bloqueado** `jnb` (Bybit 403),
`arn` (ambas). O deploy usa `nrt` por ser a mais próxima dos matching engines; confirma sempre com `fly logs`
após o primeiro deploy. Confirma também os Termos de Serviço das
exchanges para o teu país — o robô não tenta contornar bloqueios.

## Alertas Telegram (opcional)

Cria um bot com [@BotFather](https://t.me/BotFather), obtém o `chat_id` com @userinfobot e preenche
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. Recebes cada trade live, cada falha, paragens do circuit breaker e
um relatório periódico de P&L.

## Estrutura

```
src/
  index.js            arranque, loops das estratégias, sinais
  scanner.js          tabela de oportunidades (CLI)
  status.js           estado/P&L/posições (CLI)
  server.js           painel web + /health + /api/status + parar/retomar + config runtime
  config.js           todas as opções (.env) + overrides em runtime (data/overrides.json)
  exchanges.js        ccxt Bybit/Binance/OKX/KuCoin ou mocks; símbolos e pares comuns
  math.js             VWAP, lucro líquido spot, funding normalizado, APR, break-even, rotas triangulares
  executor.js         ordens IOC paralelas, reconciliação de pernas, unwind, rotas triangulares
  risk.js             circuit breakers, notional, kill switch
  state.js            persistência (data/state.json, data/trades.jsonl) + histórico de oportunidades
  notify.js           Telegram
  mock.js             exchange sintética para --sim
  strategies/
    spotArb.js
    fundingArb.js
    triangularArb.js
test/
  math.test.js
  triangle.test.js
  executor.test.js
```

## Aviso

Não há garantia de lucro. Arbitragem é uma corrida contra bots mais rápidos; os filtros deste robô são
conservadores precisamente para evitar executar quando o lucro não compensa o risco. Perdas podem acontecer
por: falha de uma perna, slippage acima do esperado, alteração de taxas, mudança abrupta do funding,
indisponibilidade de API ou liquidação de uma perna. Usa apenas capital que podes perder.
