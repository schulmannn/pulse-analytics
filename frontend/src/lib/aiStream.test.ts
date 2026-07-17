import { describe, expect, it } from 'vitest';
import { createSseFrameParser, type AiStreamEvent } from './aiStream';

const collect = () => {
  const events: AiStreamEvent[] = [];
  const feed = createSseFrameParser((e) => events.push(e));
  return { events, feed };
};

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
