// Com o Telegram Serverless ligado, o webhook do bot é do tgcloud. Este handler encaminha cada
// mensagem para o Worker (POST /api/telegram), que continua processando os comandos de sempre.
import { api } from 'sdk';
import { getConfig, setConfig, workerCall } from '../lib/worker.js';

export default async function (message, ctx) {
  const text = (message.text ?? '').trim();

  if (/^\/link(@\w+)?\s+\S+/.test(text)) return link(message, text.split(/\s+/)[1]);

  if (!(await getConfig('api_key'))) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'Bot em configuração: o dono precisa enviar /link <API_SECRET> uma vez.',
    });
    return;
  }

  await workerCall('telegram', { method: 'POST', body: ctx.update });
}

async function link(message, key) {
  const owner = await getConfig('owner_id');
  // apaga a mensagem com a chave para ela não ficar no histórico do chat
  await api.deleteMessage({ chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
  if (owner && owner !== String(message.from?.id)) {
    await api.sendMessage({ chat_id: message.chat.id, text: 'Este bot já está vinculado a outro dono.' });
    return;
  }
  try {
    await workerCall('state', { apiKey: key }); // valida a chave no Worker
  } catch (e) {
    await api.sendMessage({ chat_id: message.chat.id, text: `❌ Chave recusada pelo Worker: ${e.message}` });
    return;
  }
  await setConfig('api_key', key);
  await setConfig('owner_id', String(message.from.id));
  await api.sendMessage({
    chat_id: message.chat.id,
    text: '✅ Vinculado ao Worker. Os comandos voltam a funcionar e o Painel (Mini App) está liberado para você.',
  });
}
