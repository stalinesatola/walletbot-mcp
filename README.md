# walletbot-mcp

Bot de **auto trade Grid/DCA** para perpétuos no [Walt](https://walletbot.me) via **Walt MCP**
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

- **Estratégia** (`src/strategy/grid.ts`): grid long-only entre `low` e `high` com N níveis. Compra o nível
  cuja faixa contém o preço (no máximo um por tick), vende cada nível no degrau de cima.
  Abaixo de `low − STOP_LOSS_PCT%` fecha tudo e para.
- **Risco** (`src/risk.ts`, perfil conservador em `wrangler.toml`): alavancagem ≤ 3x, margem ≤ 5% do
  patrimônio por ordem, margem total ≤ 50%, perda diária ≥ 5% pausa o bot, whitelist BTC/ETH/SOL.
- **Walt MCP** (`src/mcp.ts`, `src/oauth.ts`, `src/walt.ts`): OAuth 2.1 com PKCE e registro dinâmico
  (escopos `perps.trade perps.readonly`). Os nomes das tools do Walt só aparecem após autenticar, então
  o bot **propõe** um mapeamento (preço, conta, abrir, fechar) que você revisa e confirma com `/map confirm`.
  O modo live não roda sem essa confirmação.

## Instalação

1. **Bot do Telegram**: no @BotFather pegue o token do `@walletbotmcpbot`.
2. **GitHub → Settings → Secrets → Actions**, crie:
   - `CLOUDFLARE_API_TOKEN` (template “Edit Cloudflare Workers”) e `CLOUDFLARE_ACCOUNT_ID`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (string aleatória, só `A-Z a-z 0-9 _ -`)
   - `OWNER_CHAT_ID` (seu chat id; se deixar vazio, o bot responde qualquer mensagem com o seu id)
3. Push na `main` → o workflow roda testes e faz `wrangler deploy`. O KV `walletbot-mcp-STATE` já está
   configurado em `wrangler.toml`.
4. Registre o webhook abrindo uma vez:
   `https://walletbot-mcp.<sua-conta>.workers.dev/setup?secret=<TELEGRAM_WEBHOOK_SECRET>`
5. No Telegram:
   ```
   /connect            → abre o OAuth do Walt, confirme no Telegram
   /tools              → lista as tools e o mapeamento proposto
   /map …  /map confirm
   /grid BTC 60000 70000 10 100 2
   /run                → paper
   /status
   /mode live CONFIRMO → só depois de validar em paper
   ```

### Comandos

| Comando | O que faz |
|---|---|
| `/status` | modo, grid, posições, PnL |
| `/connect`, `/disconnect` | OAuth do Walt |
| `/tools [refresh]` | tools do Walt + mapeamento proposto |
| `/map <role> <tool> [json]` | ajusta o mapeamento (`price`, `account`, `open`, `close`); placeholders `{market} {sizeUsd} {qty} {leverage} {price}` |
| `/map confirm` | confirma o mapeamento (exigido para live) |
| `/call <tool> [json]` | chama uma tool do Walt diretamente (debug) |
| `/grid <mercado> <low> <high> <níveis> <capitalUSD> [alav]` | configura o grid |
| `/run`, `/stop`, `/closeall` | inicia, para (mantém posições), fecha tudo |
| `/mode paper` · `/mode live CONFIRMO` | troca o modo |
| `/risk`, `/resume`, `/paper reset [saldo]` | travas, retomar após pausa, reiniciar simulação |

## Desenvolvimento local

```bash
git clone https://github.com/stalinesatola/walletbot-mcp C:\GESTEM\walletbot-mcp
cd C:\GESTEM\walletbot-mcp
npm install
npm test && npm run typecheck
cp .dev.vars.example .dev.vars   # preencha
npx wrangler dev                 # use um túnel (ex.: cloudflared) para testar o webhook
```
