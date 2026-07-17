import { getSessionToken } from '@/lib/session';

/**
 * Стриминговый ответ AI-ассистента: POST /api/ai/chats/:id/messages отвечает text/event-stream.
 * EventSource не умеет POST и кастомные заголовки (X-Session-Token), поэтому читаем поток через
 * fetch + ReadableStream. Кадры разделяются пустой строкой; полезные строки начинаются с
 * `data: {json}`, heartbeat-комментарии (`: hb`) игнорируются.
 *
 * Модуль импортируется ТОЛЬКО lazy-страницей чата — в entry-чанк не попадает.
 */

export type AiStreamEvent =
  | { type: 'meta'; chat_id: number; title?: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; status: 'start' | 'end' | 'error' }
  | {
      type: 'done';
      message_id?: number | null;
      stop_reason?: string | null;
      usage?: { input: number; output: number };
    }
  | { type: 'error'; message: string };

/** Ошибка ДО открытия стрима (обычный JSON-отказ: 400/404/429/503) либо обрыв транспорта. */
export class AiStreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AiStreamError';
    this.status = status;
  }
}

/**
 * Инкрементальный парсер SSE-кадров: скармливайте чанки как пришли, onEvent дёргается на каждом
 * распарсенном `data:`-событии. Чистая функция состояния — юнит-тестится без сети (aiStream.test).
 */
export function createSseFrameParser(onEvent: (e: AiStreamEvent) => void): (chunk: string) => void {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue; // heartbeat-комментарии и пустые строки
        try {
          onEvent(JSON.parse(line.slice(6)) as AiStreamEvent);
        } catch {
          // повреждённый кадр не валит весь стрим
        }
      }
      idx = buf.indexOf('\n\n');
    }
  };
}

export async function streamAiMessage(
  chatId: number,
  text: string,
  { onEvent, signal }: { onEvent: (e: AiStreamEvent) => void; signal?: AbortSignal },
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const token = getSessionToken();
  if (token) headers['X-Session-Token'] = token;

  const res = await fetch(`/api/ai/chats/${chatId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* не-JSON тело — оставляем статусную строку */
    }
    throw new AiStreamError(res.status, message);
  }
  if (!res.body) throw new AiStreamError(0, 'Стриминг недоступен в этом браузере');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const feed = createSseFrameParser(onEvent);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
}
