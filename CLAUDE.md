# walletbot-mcp — memória do projeto

Bot de auto trade em grid para o **Walt Perps** (`https://walletbot.me/bot-relay/public-api/mcp`),
controlado pelo Telegram `@walletbotmcpbot`, rodando em **Cloudflare Workers**
(`https://walletbot-mcp.satola-staline.workers.dev`, KV `walletbot-mcp-STATE`, cron `*/5 * * * *`).
Idioma do projeto: português (código, comentários, mensagens do bot, commits).

## Regras de trabalho
- **Sempre atualizar `README.md` e este `CLAUDE.md`** junto com qualquer mudança de comportamento,
  comando, configuração ou estado operacional.
- Antes de commitar: `npm run typecheck && npm test` (vitest). Build: `npx wrangler deploy --dry-run`.
- Deploy: workflow `.github/workflows/deploy.yml` (push na `main` ou `workflow_dispatch`). O job `deploy`
  usa o environment GitHub **`TELEGRAM_BOT_TOKEN`**, onde estão os 5 secrets
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_CHAT_ID`).
- Conta Cloudflare Free: limite de 5 cron triggers por conta (erro `code: 10072`).
- Cópia local do dono: `C:\GESTEM\walletbot-mcp`.

## Fatos do Walt (confirmados com o `perps_guide` e chamadas reais)
- Escrita sempre `perps_prepare_*` → `perps_execute_operation {confirmationToken}` (token ~90 s, uso único).
  **Nunca repetir um execute** — sem idempotência; o bot pausa em vez de tentar de novo.
- **Uma posição + uma ordem pendente por contrato**; não dá para aumentar posição. Por isso o grid é de
  posição única, com TP/SL nativos (`autoClose` em `perps_prepare_order_place`).
- `amount` = margem em quote (USDC); `leverage` inteiro ≤ `max_leverage`; `type` só `"market"`; `price` obrigatório
  (referência de slippage). `contract_id` 0 é válido (ETH); BTC=1, SOL=2.
- `perps_latest_rate` exige `marketId` no formato **`BTC-USD-PERP`** (não o id numérico nem `BTC-USDC`).
- `balance_get` → `{"accounts":[{"currency":"USDT","balance_available":"9.993797"}]}`.
- `perps_readiness` → `agent.account.not_found` até rodar `perps_prepare_account_create` → execute (assíncrono).
- OAuth: DCR só aceita `redirect_uri` em `localhost`/`127.0.0.1` (e `claude.ai`). O Worker usa
  `http://localhost:8787/oauth/callback`; o dono cola o endereço final no bot (`/code` ou só a URL).
- Margem mínima BTC a 3x ≈ $2,00 (`min_size_base` 0,00007 no topo da faixa + 1% slippage + 0,09% taxa).

## Arquitetura
- `src/index.ts` rotas (`/telegram`, `/oauth/callback`, `/setup`, `/tools.json`) + `scheduled`.
- `src/commands.ts` comandos do Telegram (só `OWNER_CHAT_ID`). `src/telegram.ts` envio + alertas (`ALERT_CHAT_ID`).
- `src/bot.ts` tick (paper e live), `closeAll`. `src/strategy/grid.ts` funções puras do grid.
- `src/walt.ts` adaptador Walt. `src/mcp.ts` cliente MCP Streamable HTTP. `src/oauth.ts` OAuth 2.1 + PKCE.
- `src/risk.ts` travas. `src/state.ts` estado no KV. Testes em `test/` (inclui tick paper ponta a ponta).

## Estado operacional (atualizar quando mudar)
- 2026-10-20: Walt conectado; conta Perps do agente criada; saldo $9,99 USDT; **modo LIVE**.
- Risco: `MAX_ORDER_PCT` 25% (para operar com ~$10), alavancagem máx 3x, perda diária 5%, SL 5% abaixo do low.
- Grid recomendado: `/grid BTC 77666.6 84276.5 8 2.2 3` (margem $2,20; antes era $5, bloqueado pelo risco).
- Alertas: canal `-1002200192005` (`ALERT_CHAT_ID`); o bot precisa ser admin do canal.
- PR aberto: stalinesatola/walletbot-mcp#2 (branch `claude/youthful-cori-im71pr`), ainda não mergeado na `main`;
  deploys estão saindo da branch via `workflow_dispatch`.
