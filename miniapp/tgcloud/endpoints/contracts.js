import { assertOwner, workerCall } from '../lib/worker.js';

// Contratos do Walt Perps com volume, funding, alavancagem e se estão liberados para o grid.
export default async function (input, ctx) {
  await assertOwner(ctx);
  return workerCall('contracts');
}
