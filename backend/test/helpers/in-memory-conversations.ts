import type { Conversation, Message } from '../../src/generated/prisma/client.js';
import type { HistoryCursor } from '../../src/modules/conversations/cursor.js';
import type { NewMessage } from '../../src/modules/conversations/conversations.repository.js';

/**
 * In-memory stand-in for the conversations repository and the unit of work.
 * It copies the rules the service relies on (owner and soft-delete filters,
 * same-conversation parents, conditional updates), so service and HTTP tests run
 * without Postgres. The real SQL (pagination, the branch walk, constraints) is
 * covered by the database tests in test/integration.
 */

let counter = 0;
const id = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;
const foreignKeyViolation = () => Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });

export class InMemoryConversations {
  conversations: Conversation[] = [];
  messages: Message[] = [];

  readonly repository = {
    createConversation: (ownerId: string, at: Date): Promise<Conversation> => {
      const row: Conversation = {
        id: id(),
        ownerId,
        title: null,
        titleSource: 'DEFAULT',
        activeLeafId: null,
        lastMessageAt: at,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      this.conversations.push(row);
      return Promise.resolve({ ...row });
    },

    findOwned: (conversationId: string, ownerId: string): Promise<Conversation | null> =>
      Promise.resolve(this.owned(conversationId, ownerId) ?? null),

    listOwned: (ownerId: string, limit: number, cursor?: HistoryCursor): Promise<Conversation[]> => {
      const rows = this.conversations
        .filter((c) => c.ownerId === ownerId && c.deletedAt === null)
        .filter((c) => {
          if (!cursor) return true;
          const at = c.lastMessageAt.getTime();
          const cursorAt = cursor.lastMessageAt.getTime();
          return at < cursorAt || (at === cursorAt && c.id < cursor.id);
        })
        .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime() || (a.id < b.id ? 1 : -1));
      return Promise.resolve(rows.slice(0, limit + 1));
    },

    setGeneratedTitle: (conversationId: string, title: string): Promise<boolean> => {
      const row = this.conversations.find((c) => c.id === conversationId && c.deletedAt === null);
      if (!row || row.titleSource === 'MANUAL') return Promise.resolve(false);
      row.title = title;
      row.titleSource = 'GENERATED';
      return Promise.resolve(true);
    },

    rename: (conversationId: string, ownerId: string, title: string): Promise<boolean> => {
      const row = this.owned(conversationId, ownerId);
      if (!row) return Promise.resolve(false);
      row.title = title;
      row.titleSource = 'MANUAL';
      return Promise.resolve(true);
    },

    softDelete: (conversationId: string, ownerId: string, at: Date): Promise<boolean> => {
      const row = this.owned(conversationId, ownerId);
      if (!row) return Promise.resolve(false);
      row.deletedAt = at;
      return Promise.resolve(true);
    },

    insertMessage: (message: NewMessage): Promise<Message> => {
      const parent = message.parentId ? this.messages.find((m) => m.id === message.parentId) : undefined;
      if (message.parentId && parent?.conversationId !== message.conversationId) throw foreignKeyViolation();
      const row: Message = {
        id: id(),
        conversationId: message.conversationId,
        parentId: message.parentId,
        role: message.role,
        content: message.content,
        reasoning: message.reasoning ?? null,
        depth: message.depth,
        generationId: message.generationId ?? null,
        createdAt: new Date(),
      };
      this.messages.push(row);
      return Promise.resolve({ ...row });
    },

    findMessage: (messageId: string, conversationId: string): Promise<Message | null> =>
      Promise.resolve(this.messages.find((m) => m.id === messageId && m.conversationId === conversationId) ?? null),

    setActiveLeaf: (conversationId: string, leafId: string, at: Date): Promise<void> => {
      const row = this.conversations.find((c) => c.id === conversationId)!;
      row.activeLeafId = leafId;
      row.lastMessageAt = at;
      return Promise.resolve();
    },

    touch: (conversationId: string, at: Date): Promise<void> => {
      this.conversations.find((c) => c.id === conversationId)!.lastMessageAt = at;
      return Promise.resolve();
    },

    moveActiveLeafIfCurrent: (conversationId: string, expectedLeafId: string, newLeafId: string): Promise<boolean> => {
      const row = this.conversations.find((c) => c.id === conversationId);
      if (!row || row.activeLeafId !== expectedLeafId) return Promise.resolve(false);
      row.activeLeafId = newLeafId;
      return Promise.resolve(true);
    },

    branchWindow: (conversationId: string, leafId: string, lowestDepth: number, beforeDepth: number): Promise<Message[]> => {
      const walked: Message[] = [];
      let current = this.messages.find((m) => m.id === leafId && m.conversationId === conversationId);
      while (current) {
        walked.push(current);
        if (current.depth <= lowestDepth) break;
        const parentId: string | null = current.parentId;
        current = parentId ? this.messages.find((m) => m.id === parentId) : undefined;
      }
      return Promise.resolve(
        walked.filter((m) => m.depth >= lowestDepth && m.depth < beforeDepth).sort((a, b) => a.depth - b.depth),
      );
    },
  };

  /** No rollback: enough for service logic; real atomicity needs a database. */
  readonly unitOfWork = { run: <T>(work: (tx: never) => Promise<T>) => work(undefined as never) };

  private owned(conversationId: string, ownerId: string): Conversation | undefined {
    return this.conversations.find((c) => c.id === conversationId && c.ownerId === ownerId && c.deletedAt === null);
  }
}
