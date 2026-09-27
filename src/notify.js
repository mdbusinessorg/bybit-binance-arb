import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('telegram');
const queue = [];
let flushing = false;

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const text = queue.shift();
      const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegram.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) log.warn(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (e) {
    log.warn(`telegram falhou: ${e.message}`);
  } finally {
    flushing = false;
  }
}

/** Envia alerta Telegram (não bloqueia; ignora silenciosamente se não configurado). */
export function notify(text) {
  if (!config.telegram.token || !config.telegram.chatId) return;
  queue.push(text.slice(0, 4000));
  flush();
}
