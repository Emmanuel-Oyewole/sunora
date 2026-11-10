import { invalidCursor } from './conversations.errors.js';

export interface HistoryCursor {
  lastMessageAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque to clients. It is the sort key of the last item on the page. */
export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.lastMessageAt.toISOString(), id: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string' || !UUID.test(parsed.id)) throw new Error('shape');
    const lastMessageAt = new Date(parsed.t);
    if (Number.isNaN(lastMessageAt.getTime())) throw new Error('date');
    return { lastMessageAt, id: parsed.id };
  } catch {
    throw invalidCursor();
  }
}
