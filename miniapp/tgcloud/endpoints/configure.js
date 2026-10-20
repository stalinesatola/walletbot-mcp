import { assertOwner, workerCall } from '../lib/worker.js';

// Configura o grid: { market, low, high, levels, marginUsd, leverage }.
export default async function (input, ctx) {
  await assertOwner(ctx);
  const { market, low, high, levels, marginUsd, leverage } = input;
  return workerCall('grid', { method: 'POST', body: { market, low, high, levels, marginUsd, leverage } });
}
