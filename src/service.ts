// Operações do bot usadas pelos comandos do Telegram e pela API da Mini App.
import { riskLimits, type Env } from "./env";
import { connectWalt, currentPrice } from "./bot";
import { cachedContracts, loadState, saveState } from "./state";
import { marketAllowed } from "./risk";
import { notional, sizeError, step, stopLossPrice, validateConfig, type GridConfig } from "./strategy/grid";
import { findContract, type Walt } from "./walt";

export async function walt(env: Env): Promise<Walt> {
  const w = await connectWalt(env);
  if (!w) throw new Error("Walt não conectado — use /connect");
  return w;
}

export async function stopGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  s.running = false;
  await saveState(env, s);
  return "Grid parado. A posição aberta (se houver) continua com TP/SL no Walt. /closeall para fechar.";
}

export async function resumeGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  s.paused = undefined;
  s.day = undefined; // recomeça a contagem de perda diária
  await saveState(env, s);
  return "Pausa removida. O próximo tick roda normalmente.";
}

export async function configureGrid(env: Env, args: string[]): Promise<string> {
  const limits = riskLimits(env);
  const market = (args[0] ?? "BTC").toUpperCase();
  if (!marketAllowed(limits, market)) return `Mercado fora da whitelist: ${limits.allowedMarkets.join(", ")}`;
  const w = await walt(env);
  const contract = findContract(await cachedContracts(env, () => w.contracts()), market);
  if (!contract) return `Contrato ${market}-USDC não encontrado no Walt.`;
  if ((contract.volume24hUsd ?? 0) < limits.minVolume24hUsd)
    return `${market} tem volume 24h de $${Math.round(contract.volume24hUsd ?? 0).toLocaleString("en-US")}, abaixo do mínimo de $${limits.minVolume24hUsd.toLocaleString("en-US")} (pouca liquidez).`;
  if (args.length < 5) {
    // sugestão pronta para copiar: faixa de −6% a +2% do preço atual
    const price = await w.rate(contract);
    const d = contract.priceDecimals;
    const lo = (price * 0.94).toFixed(d);
    const hi = (price * 1.02).toFixed(d);
    return [
      `Preço atual de ${market}: $${price}`,
      "",
      "Uso: /grid <mercado> <low> <high> <degraus> <margemUSD por trade> [alavancagem]",
      "Sugestão (faixa −6% a +2%, 8 degraus, $5 de margem, 3x) — copie e envie:",
      `/grid ${market} ${lo} ${hi} 8 5 3`,
    ].join("\n");
  }
  const cfg: GridConfig = {
    market,
    contract,
    low: Number(args[1]),
    high: Number(args[2]),
    levels: Number(args[3]),
    marginUsd: Number(args[4]),
    leverage: Math.min(Math.trunc(Number(args[5] ?? 1)), limits.maxLeverage),
  };
  const err = validateConfig(cfg);
  if (err) return `Config inválida: ${err}`;
  const s = await loadState(env);
  if (s.grid?.position) return "Há uma posição aberta no grid atual. Use /closeall antes de reconfigurar.";
  const price = await w.rate(contract);
  const sizeErr = sizeError(cfg, Math.min(price, cfg.high));
  if (sizeErr) return `Config inválida: ${sizeErr}`;
  s.grid = { cfg };
  s.running = false;
  await saveState(env, s);
  return [
    `Grid ${market} (contrato #${contract.contractId}) configurado:`,
    `• ${cfg.levels} degraus de $${step(cfg).toFixed(contract.priceDecimals)} entre $${cfg.low} e $${cfg.high} (preço atual $${price})`,
    `• Cada entrada: margem $${cfg.marginUsd} ${cfg.leverage}x ≈ $${notional(cfg).toFixed(2)} nocional, TP no degrau de cima`,
    `• Stop-loss: $${stopLossPrice(cfg, limits.stopLossPct).toFixed(contract.priceDecimals)} (para o grid)`,
    `Use /run para iniciar (modo ${s.mode}).`,
  ].join("\n");
}

export async function runGrid(env: Env): Promise<string> {
  const s = await loadState(env);
  if (!s.grid) return "Configure antes com /grid.";
  const price = await currentPrice(s.grid.cfg, await connectWalt(env));
  const { low, high } = s.grid.cfg;
  const warn =
    price > high || price < low ? `\n⚠️ Preço fora da faixa $${low}–$${high}: só entra quando o preço chegar nela.` : "";
  s.running = true;
  s.paused = undefined;
  s.lastPrice = price;
  await saveState(env, s);
  return `▶️ Grid ${s.grid.cfg.market} iniciado em modo ${s.mode.toUpperCase()} (preço $${price}). Ticks a cada 5 min.${warn}`;
}

export async function setMode(env: Env, args: string[]): Promise<string> {
  const s = await loadState(env);
  const target = args[0]?.toLowerCase();
  if (target !== "paper" && target !== "live") return `Modo atual: ${s.mode}. Uso: /mode paper | /mode live CONFIRMO`;
  if (s.grid?.position) return "Feche a posição (/closeall) antes de trocar de modo.";
  if (target === "live") {
    if (args[1] !== "CONFIRMO") return "⚠️ Live usa dinheiro real em perpétuos alavancados. Envie: /mode live CONFIRMO";
    const w = await walt(env);
    const r = await w.readiness();
    if (!r.ok) return `Conta Perps não está pronta: ${r.issues.map((i) => i.code).join(", ")} — use /conta.`;
    const bal = await w.balanceUsd();
    if (!(bal > 0)) return "Saldo USDC zero na conta do agente — deposite no Walt antes.";
  }
  s.mode = target;
  s.running = false;
  s.day = undefined;
  await saveState(env, s);
  return `Modo ${target.toUpperCase()} ativado. Grid parado — use /run.`;
}
