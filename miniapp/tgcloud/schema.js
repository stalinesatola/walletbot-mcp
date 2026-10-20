import { table, text } from 'sdk/db';

// Configuração do vínculo com o Worker. O Serverless não tem secrets e o repositório é público,
// então a chave da API (API_SECRET do Worker) é gravada aqui pelo comando /link, nunca no código.
export const config = table('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
