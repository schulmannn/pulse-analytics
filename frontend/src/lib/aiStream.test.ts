import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSseFrameParser,
  streamAiMessage,
  type AiStreamEvent,
} from './aiStream';

const collect = () => {
  const events: AiStreamEvent[] = [];
  const feed = createSseFrameParser((e) => events.push(e));
  return { events, feed };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSseFrameParser', () => {
  it('парсит целый кадр data: {json}', () => {
    const { events, feed } = collect();
    feed('data: {"type":"text","delta":"Привет"}\n\n');
    expect(events).toEqual([{ type: 'text', delta: 'Привет' }]);
  });

  it('склеивает кадр, порванный на границе чанков (включая разрыв внутри JSON)', () => {
    const { events, feed } = collect();
    feed('data: {"type":"te');
    feed('xt","delta":"аб"}\n');
    expect(events).toEqual([]);
    feed('\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: 'text', delta: 'аб' }, { type: 'done' }]);
  });

  it('heartbeat-комментарии и мусорные кадры пропускаются, поток не падает', () => {
    const { events, feed } = collect();
    feed(': hb\n\ndata: not-json\n\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('несколько событий в одном чанке приходят по порядку', () => {
    const { events, feed } = collect();
    feed('data: {"type":"meta","chat_id":1}\n\ndata: {"type":"text","delta":"a"}\n\ndata: {"type":"text","delta":"b"}\n\n');
    expect(events.map((e) => e.type)).toEqual(['meta', 'text', 'text']);
  });
});

describe('streamAiMessage auth boundary', () => {
  it('forwards a direct-stream 401 to the shared browser redirect policy', async () => {
    const request = vi.fn(async () =>
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    const onUnauthorized = vi.fn(() => true);
    vi.stubGlobal('fetch', request);

    await expect(
      streamAiMessage(7, 'hello', {
        onEvent: () => undefined,
        onUnauthorized,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith({ status: 401 });
  });
});
