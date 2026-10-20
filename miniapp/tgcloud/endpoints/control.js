import { EndpointError } from 'sdk';
import { assertOwner, workerCall } from '../lib/worker.js';

const ACTIONS = ['run', 'stop', 'resume', 'closeall', 'mode'];

// Controles: { action: run|stop|resume|closeall|mode, mode?: paper|live, confirm?: true }.
export default async function (input, ctx) {
  await assertOwner(ctx);
  if (!ACTIONS.includes(input.action)) throw new EndpointError('ação inválida', { code: 'BAD_INPUT' });
  return workerCall('control', {
    method: 'POST',
    body: { action: input.action, mode: input.mode, confirm: input.confirm === true },
  });
}
