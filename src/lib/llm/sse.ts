/** Одно событие Server-Sent Events. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Инкрементальный парсер SSE: принимает куски текста в произвольных местах разреза
 * (в том числе посреди строки или между \r и \n) и отдаёт завершённые события.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // Одиночный \r в конце буфера может оказаться началом \r\n — ждём следующий кусок.
      if (m[0] === '\r' && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Досбрасывает хвост, если поток закончился без пустой строки. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer !== '') {
      const ev = this.processLine(this.buffer);
      this.buffer = '';
      if (ev) events.push(ev);
    }
    const last = this.processLine('');
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SseEvent | null {
    if (line === '') {
      if (this.dataLines.length === 0) {
        this.eventName = '';
        return null;
      }
      const ev: SseEvent = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
      this.dataLines = [];
      this.eventName = '';
      return ev;
    }
    if (line.startsWith(':')) return null; // комментарий / keep-alive

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    return null;
  }
}

/** Читает поток байт из fetch-ответа и отдаёт SSE-события по мере поступления. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.flush();
  } finally {
    reader.releaseLock();
  }
}
