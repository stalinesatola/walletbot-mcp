import { assertOwner, workerCall } from '../lib/worker.js';

// Histórico de trades e curva de patrimônio.
export default async function (input, ctx) {
  await assertOwner(ctx);
  return workerCall('trades');
}
