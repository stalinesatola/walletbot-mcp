import { EndpointError } from 'sdk';
import { assertOwner, workerCall } from '../lib/worker.js';

// Velas de 15 min (Hyperliquid) ou preços gravados pelo bot, para o gráfico do Painel.
export default async function (input, ctx) {
  await assertOwner(ctx);
  const market = String(input.market ?? '').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(market)) throw new EndpointError('market inválido', { code: 'BAD_INPUT' });
  return workerCall(`chart?market=${encodeURIComponent(market)}`);
}
