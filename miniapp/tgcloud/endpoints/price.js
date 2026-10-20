import { EndpointError } from 'sdk';
import { assertOwner, workerCall } from '../lib/worker.js';

// Preço atual, margem mínima e faixa sugerida para um par.
export default async function (input, ctx) {
  await assertOwner(ctx);
  const market = String(input.market ?? '').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(market)) throw new EndpointError('market inválido', { code: 'BAD_INPUT' });
  const leverage = Number(input.leverage ?? 3) || 3;
  return workerCall(`price?market=${encodeURIComponent(market)}&leverage=${leverage}`);
}
