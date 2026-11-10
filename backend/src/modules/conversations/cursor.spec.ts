import { decodeCursor, encodeCursor } from './cursor.js';

const cursor = { lastMessageAt: new Date('2026-11-09T10:00:00.123Z'), id: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000' };

describe('history cursor', () => {
  it('round-trips, keeping the millisecond', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is url-safe', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['garbage', 'not-a-cursor!!'],
    ['valid base64 but not JSON', Buffer.from('hello').toString('base64url')],
    ['missing fields', Buffer.from('{}').toString('base64url')],
    ['a bad date', Buffer.from(JSON.stringify({ t: 'yesterday', id: cursor.id })).toString('base64url')],
    ['an id that is not a uuid', Buffer.from(JSON.stringify({ t: '2026-11-09T10:00:00.000Z', id: "1' OR '1'='1" })).toString('base64url')],
  ])('rejects %s with INVALID_CURSOR', (_name, raw) => {
    expect(() => decodeCursor(raw)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
});
