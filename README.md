# walletbot-mcp

Bot de **auto trade em grid** para perpétuos no [Walt](https://walletbot.me) via **Walt MCP**
(`https://walletbot.me/bot-relay/public-api/mcp`), controlado pelo Telegram (`@walletbotmcpbot`)
e hospedado 100% serverless em **Cloudflare Workers** (webhook do Telegram + Cron a cada 5 min + KV).

> ⚠️ Perpétuos alavancados podem liquidar a conta. O bot começa em **modo paper** (simulado) e só
> opera dinheiro real depois de `/mode live CONFIRMO`. Rode em paper por pelo menos 24 h antes.

## Como funciona

```
Telegram ──webhook──▶ Worker /telegram ──▶ comandos (/grid, /run, /status…)
Cron */5 min ───────▶ Worker scheduled ──▶ preço → grid → travas de risco → ordem (paper | Walt MCP)
Walt OAuth ─────────▶ Worker /oauth/callback ──▶ tokens no KV (refresh automático)
```

- **Estratégia** (`src/strategy/grid.ts`): grid de **posição única**, porque o Walt aceita só uma posição
  por contrato e não deixa aumentar uma posição aberta. A faixa `low`–`high` é dividida em N degraus.
  Quando o preço entra num degrau, o bot abre um long com **take-profit no degrau de cima** e
  **stop-loss em `low − STOP_LOSS_PCT%`**, ambos nativos do Walt (`autoClose`), então a saída acontece
  mesmo com o bot parado. Quando a posição fecha por TP, o bot espera o próximo degrau; por SL, para o grid.
- **Risco** (`src/risk.ts`, valores em `wrangler.toml`): alavancagem ≤ 3x (inteira e ≤ máx do contrato),
  margem ≤ `MAX_ORDER_PCT` do saldo por trade (hoje **25%**, para operar com ~$10), perda diária ≥ 5% pausa
  o bot, stop-loss 5% abaixo do `low`, whitelist BTC/ETH/SOL, tamanho mínimo do contrato validado no `/grid`.
- **Alertas**: entradas, TP/SL, pausas, bloqueios de risco e erros vão para o canal `ALERT_CHAT_ID`
  (`wrangler.toml`; o bot precisa ser admin do canal). Se o envio falhar, o alerta cai no chat do dono.
- **Walt MCP** (`src/walt.ts`): segue o `perps_guide`. Toda escrita é `perps_prepare_*` → `perps_execute_operation`
  com o `confirmationToken`; o `amount` é **margem em USDC**; o preço vem de `perps_latest_rate` com
  `marketId` no formato `BTC-USD-PERP`; o saldo vem de `balance_get` (`accounts[].balance_available`, USDT); um execute que falha **nunca é repetido**
  (o bot pausa e pede conferência, para evitar ordens duplicadas). OAuth 2.1 com PKCE e registro dinâmico;
  o Walt só aceita redirect para `localhost`, então o endereço final é colado no bot.

## Instalação

1. **Bot do Telegram**: no @BotFather pegue o token do `@walletbotmcpbot`.
2. **GitHub → Settings → Secrets → Actions**, crie:
   - `CLOUDFLARE_API_TOKEN` (template “Edit Cloudflare Workers”) e `CLOUDFLARE_ACCOUNT_ID`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (string aleatória, só `A-Z a-z 0-9 _ -`)
   - `OWNER_CHAT_ID` (seu chat id; se deixar vazio, o bot responde qualquer mensagem com o seu id)
   Os secrets podem estar no environment `TELEGRAM_BOT_TOKEN` (é o que o job `deploy` usa).
3. Push na `main` (ou *Run workflow* manual) → o workflow roda testes e faz `wrangler deploy`.
   A conta Cloudflare Free permite só 5 cron triggers; se o deploy falhar com `code: 10072`, libere um. O KV `walletbot-mcp-STATE` já está
   configurado em `wrangler.toml`.
4. Registre o webhook abrindo uma vez:
   `https://walletbot-mcp.<sua-conta>.workers.dev/setup?secret=<TELEGRAM_WEBHOOK_SECRET>`
5. No Telegram:
   ```
   /connect                       → autorize no Walt e confirme no Telegram
   <cole o endereço localhost>    → conclui a conexão
   /conta  e  /conta CONFIRMO     → cria a conta Perps do agente (uma vez)
   /grid BTC 100000 110000 10 5 3 → BTC, faixa, 10 degraus, $5 de margem por trade, 3x
   /run                           → modo paper (simulado, preço real do Walt)
   /status
   depositar USDT/USDC na conta do agente no Walt → /mode live CONFIRMO → /run
   ```

### Valor mínimo por trade

O Walt exige `amount ≥ min_size_quote` ($1) **e** tamanho ≥ `min_size_base` do contrato. O tamanho é
`nocional ÷ (preço × (1 + slippage))`, com `nocional = margem ÷ (1/alavancagem + taxa taker)`. Para BTC
(`min_size_base` 0,00007, slippage 1%, taxa 0,09%) a ~$84 mil e 3x, a margem mínima é **≈ $2,00**; o `/grid`
recusa valores abaixo disso. Com saldo de $9,99 e `MAX_ORDER_PCT` 25%, o teto por trade é $2,49 — por isso o
grid atual usa `/grid BTC 77666.6 84276.5 8 2.2 3`.

### Comandos

| Comando | O que faz |
|---|---|
| `/status` | modo, grid, posição, PnL |
| `/connect`, `/code <url>`, `/disconnect` | OAuth do Walt |
| `/conta [CONFIRMO]` | `perps_readiness`; cria a conta Perps do agente se faltar |
| `/saldo` | `balance_get` |
| `/tools` | lista as tools (schemas em `/tools.json?secret=…`) |
| `/call <tool> [json]` | chama uma tool de leitura/preview diretamente (execute é bloqueado) |
| `/grid <mercado> <low> <high> <degraus> <margemUSD> [alav]` | configura o grid (`/grid` sozinho sugere um comando a partir do preço atual) |
| `/run`, `/stop`, `/closeall` | inicia, para (posição fica com TP/SL), fecha a posição e para |
| `/mode paper` · `/mode live CONFIRMO` | troca o modo (live exige conta pronta e saldo) |
| `/risk`, `/resume`, `/paper reset [saldo]` | travas, retomar após pausa, reiniciar simulação |
| `/testalert` | testa o envio de alertas para o canal |

## Desenvolvimento local

```bash
git clone https://github.com/stalinesatola/walletbot-mcp C:\GESTEM\walletbot-mcp
cd C:\GESTEM\walletbot-mcp
npm install
npm test && npm run typecheck
cp .dev.vars.example .dev.vars   # preencha
npx wrangler dev                 # use um túnel (ex.: cloudflared) para testar o webhook
```
