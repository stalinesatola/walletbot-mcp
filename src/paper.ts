// Executor simulado: usa preço real, mas as "ordens" só alteram o estado no KV.
import { PAPER_FEE, gridExposure, type BotState } from "./state";

export interface Executor {
  equity(price: number): Promise<number>;
  buy(sizeUsd: number, leverage: number, price: number): Promise<{ qty: number; price: number }>;
  sell(qty: number, price: number): Promise<{ price: number }>;
}

export class PaperExecutor implements Executor {
  constructor(private state: BotState) {}

  async equity(price: number): Promise<number> {
    const levels = this.state.grid?.levels ?? [];
    const lev = this.state.grid?.cfg.leverage ?? 1;
    return this.state.paper.cash + gridExposure(levels, price, lev).unrealized;
  }

  async buy(sizeUsd: number, _leverage: number, price: number) {
    this.state.paper.cash -= sizeUsd * PAPER_FEE;
    return { qty: sizeUsd / price, price };
  }

  async sell(_qty: number, price: number) {
    // o PnL realizado é contabilizado pelo tick (que conhece o preço de entrada)
    return { price };
  }

  /** Chamado pelo tick ao realizar lucro/prejuízo de um nível. */
  settle(qty: number, entry: number, exit: number): number {
    const pnl = qty * (exit - entry) - qty * exit * PAPER_FEE;
    this.state.paper.cash += pnl;
    return pnl;
  }
}
