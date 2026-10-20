import { assertOwner, workerCall } from '../lib/worker.js';

// Estado do bot: modo, grid, posição (paper e Walt ao vivo), PnL e travas.
export default async function (input, ctx) {
  await assertOwner(ctx);
  return workerCall('state');
}
