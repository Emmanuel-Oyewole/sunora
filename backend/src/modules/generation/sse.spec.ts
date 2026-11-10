import { AsyncQueue, TIMED_OUT } from './async-queue.js';
import { formatSse } from './sse.js';

describe('formatSse', () => {
  it('writes id, event and JSON data, ending with a blank line', () => {
    expect(formatSse({ id: 7, event: 'text', data: { text: 'Hi' } })).toBe('id: 7\nevent: text\ndata: {"text":"Hi"}\n\n');
  });

  it('leaves out the id for events that are not resumable', () => {
    expect(formatSse({ event: 'status', data: { status: 'COMPLETED' } })).toBe('event: status\ndata: {"status":"COMPLETED"}\n\n');
  });

  it('keeps newlines in the text on one data line, so an event cannot be split or forged', () => {
    const out = formatSse({ id: 1, event: 'text', data: { text: 'a\n\nevent: status' } });

    expect(out.split('\n\n')).toHaveLength(2); // one event plus the trailing empty piece
    expect(out).toContain('\\n\\nevent: status');
  });
});

describe('AsyncQueue', () => {
  it('hands over items in order, whether they were pushed before or after waiting', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    const waiting = queue.next(1000);
    expect(await queue.next(1000)).toBe(2);
    expect(await waiting).toBe(1);

    const later = queue.next(1000);
    queue.push(3);
    expect(await later).toBe(3);
  });

  it('gives up waiting after the timeout', async () => {
    expect(await new AsyncQueue<number>().next(10)).toBe(TIMED_OUT);
  });
});
