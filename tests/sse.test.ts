import { describe, expect, it } from 'vitest';
import { readSse, SseParser, type SseEvent } from '@/lib/llm/sse';

function parseAll(chunks: string[]): SseEvent[] {
  const p = new SseParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.flush()];
}

describe('SseParser', () => {
  it('парсит простые события', () => {
    expect(parseAll(['data: {"a":1}\n\ndata: [DONE]\n\n'])).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: '[DONE]' },
    ]);
  });

  it('собирает события, разрезанные в произвольных местах', () => {
    const text = 'data: hello\n\ndata: world\n\n';
    for (let i = 1; i < text.length; i++) {
      expect(parseAll([text.slice(0, i), text.slice(i)])).toEqual([
        { event: 'message', data: 'hello' },
        { event: 'message', data: 'world' },
      ]);
    }
  });

  it('поддерживает \\r\\n, в том числе разрезанный между \\r и \\n', () => {
    expect(parseAll(['data: a\r', '\n\r\n'])).toEqual([{ event: 'message', data: 'a' }]);
    expect(parseAll(['data: a\r\n\r\ndata: b\r\r'])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('склеивает многострочный data и учитывает event', () => {
    expect(parseAll(['event: error\ndata: line1\ndata: line2\n\n'])).toEqual([
      { event: 'error', data: 'line1\nline2' },
    ]);
  });

  it('игнорирует комментарии и пустые блоки', () => {
    expect(parseAll([': keep-alive\n\n\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('отдаёт хвост без завершающей пустой строки при flush', () => {
    expect(parseAll(['data: tail'])).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('data без пробела после двоеточия', () => {
    expect(parseAll(['data:x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });
});

describe('readSse', () => {
  it('читает поток байт, включая разрезанные UTF-8 символы', async () => {
    const bytes = new TextEncoder().encode('data: привет\n\ndata: [DONE]\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // режем посреди двухбайтовой «п»
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    const events: string[] = [];
    for await (const ev of readSse(stream)) events.push(ev.data);
    expect(events).toEqual(['привет', '[DONE]']);
  });
});
