import { randomUUID } from 'node:crypto';
import { ConversationsRepository } from '../../src/modules/conversations/conversations.repository.js';
import { ConversationsService } from '../../src/modules/conversations/conversations.service.js';
import type { PrismaService } from '../../src/shared/database/prisma.service.js';
import type { UnitOfWork } from '../../src/shared/database/unit-of-work.js';
import { connectTestDatabase, emptyConversationTables } from './test-database.js';

let prisma: PrismaService;
let unitOfWork: UnitOfWork;
let repository: ConversationsRepository;
let service: ConversationsService;

beforeAll(async () => {
  ({ prisma, unitOfWork } = connectTestDatabase());
  await prisma.$connect();
  repository = new ConversationsRepository(prisma);
  service = new ConversationsService(repository, unitOfWork);
});
afterAll(() => prisma.$disconnect());
beforeEach(() => emptyConversationTables(prisma));

const owner = () => randomUUID();

/** The Postgres error text of a rejected query, to check which constraint fired. */
const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'accepted',
    (error: Error) => error.message,
  );

async function root(ownerId = owner(), text = 'root') {
  return service.appendUserMessage(ownerId, { content: text });
}

/** Builds U0 -> A1 -> U2 -> A3 ... and returns every message, oldest first. */
async function chain(ownerId: string, exchanges: number) {
  const first = await service.appendUserMessage(ownerId, { content: 'm0' });
  const messages = [first.message];
  for (let i = 0; i < exchanges; i++) {
    const answer = await service.appendAssistantMessage(ownerId, {
      conversationId: first.conversationId,
      parentId: messages.at(-1)!.id,
      content: `a${i}`,
      generationId: randomUUID(),
    });
    messages.push(answer);
    if (i < exchanges - 1) {
      const user = await service.appendUserMessage(ownerId, {
        conversationId: first.conversationId,
        parentId: answer.id,
        content: `m${i + 1}`,
      });
      messages.push(user.message);
    }
  }
  return { conversationId: first.conversationId, messages };
}

describe('conversations schema constraints', () => {
  it('rejects a message whose depth does not match having a parent', async () => {
    const { conversationId, message } = await root();

    const rootWithDepth = prisma.message.create({
      data: { conversationId, parentId: null, role: 'USER', content: 'x', depth: 1 },
    });
    const childAtDepthZero = prisma.message.create({
      data: { conversationId, parentId: message.id, role: 'ASSISTANT', content: 'x', depth: 0 },
    });

    expect(await rejection(rootWithDepth)).toMatch(/messages_depth_chk/);
    expect(await rejection(childAtDepthZero)).toMatch(/messages_depth_chk/);
  });

  it('rejects a parent that belongs to another conversation', async () => {
    const one = await root();
    const two = await root();

    const graft = prisma.message.create({
      data: { conversationId: two.conversationId, parentId: one.message.id, role: 'ASSISTANT', content: 'x', depth: 1 },
    });

    expect(await rejection(graft)).toMatch(/messages_conversation_id_parent_id_fkey|Foreign key/);
  });

  it('rejects empty and oversized content, and reasoning on a user message', async () => {
    const { conversationId, message } = await root();
    const answer = (data: object) =>
      prisma.message.create({
        data: { conversationId, parentId: message.id, role: 'ASSISTANT', depth: 1, content: 'ok', ...data },
      });

    expect(await rejection(answer({ content: '' }))).toMatch(/messages_content_length_chk/);
    expect(await rejection(answer({ content: 'x'.repeat(200_001) }))).toMatch(/messages_content_length_chk/);
    expect(await rejection(answer({ reasoning: 'x'.repeat(400_001) }))).toMatch(/messages_reasoning_chk/);
    expect(
      await rejection(
        prisma.message.create({ data: { conversationId, parentId: null, role: 'USER', depth: 0, content: 'q', reasoning: 'no' } }),
      ),
    ).toMatch(/messages_reasoning_chk/);
    expect(await rejection(answer({ reasoning: 'fine' }))).toBe('accepted');
  });

  it('rejects an empty or oversized title', async () => {
    const { conversationId } = await root();

    expect(await rejection(prisma.conversation.update({ where: { id: conversationId }, data: { title: '' } }))).toMatch(
      /conversations_title_length_chk/,
    );
    expect(
      await rejection(prisma.conversation.update({ where: { id: conversationId }, data: { title: 'x'.repeat(201) } })),
    ).toMatch(/conversations_title_length_chk/);
  });

  it('deletes all messages with their conversation, even though they point at each other', async () => {
    const ownerId = owner();
    const { conversationId } = await chain(ownerId, 3);

    await prisma.conversation.delete({ where: { id: conversationId } });

    expect(await prisma.message.count()).toBe(0);
  });

  it('clears the active leaf if that message is ever removed', async () => {
    const { conversationId, message } = await root();

    await prisma.message.delete({ where: { id: message.id } });

    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).activeLeafId).toBeNull();
  });

  it('has the history index restricted to conversations that are not deleted', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'conversations_history_idx'`;

    expect(rows[0].indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);
  });
});

describe('writing messages (real transactions)', () => {
  it('creates the conversation, the first message and the active leaf together', async () => {
    const ownerId = owner();

    const { conversationId, message } = await root(ownerId, 'Hello');

    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(stored).toMatchObject({ ownerId, activeLeafId: message.id, title: null, titleSource: 'DEFAULT' });
  });

  it('leaves nothing behind when a transaction fails half way', async () => {
    const attempt = unitOfWork.run(async (tx) => {
      await repository.createConversation(owner(), new Date(), tx);
      throw new Error('boom');
    });

    await expect(attempt).rejects.toThrow('boom');
    expect(await prisma.conversation.count()).toBe(0);
  });

  it('moves the active leaf to the answer only while the user message is still the leaf', async () => {
    const ownerId = owner();
    const first = await root(ownerId, 'q');
    const edited = await service.appendUserMessage(ownerId, { conversationId: first.conversationId, content: 'edited' });

    await service.appendAssistantMessage(ownerId, {
      conversationId: first.conversationId,
      parentId: first.message.id,
      content: 'late',
      generationId: randomUUID(),
    });

    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
    expect(stored.activeLeafId).toBe(edited.message.id);
  });

  it('lets exactly one of two concurrent answers move the leaf', async () => {
    const ownerId = owner();
    const first = await root(ownerId, 'q');
    const answer = () =>
      service.appendAssistantMessage(ownerId, {
        conversationId: first.conversationId,
        parentId: first.message.id,
        content: 'a',
        generationId: randomUUID(),
      });

    const [a, b] = await Promise.all([answer(), answer()]);

    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
    expect([a.id, b.id]).toContain(stored.activeLeafId);
    expect(await prisma.message.count({ where: { role: 'ASSISTANT' } })).toBe(2);
  });
});

describe('title updates', () => {
  it('applies a generated title, then refuses to overwrite a typed one', async () => {
    const ownerId = owner();
    const { conversationId } = await root(ownerId);

    expect(await service.applyGeneratedTitle(conversationId, 'Generated')).toBe(true);
    await service.rename(ownerId, conversationId, 'Typed');
    expect(await service.applyGeneratedTitle(conversationId, 'Generated again')).toBe(false);

    const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(stored).toMatchObject({ title: 'Typed', titleSource: 'MANUAL' });
  });

  it('does not touch a deleted conversation', async () => {
    const ownerId = owner();
    const { conversationId } = await root(ownerId);
    await service.remove(ownerId, conversationId);

    expect(await service.applyGeneratedTitle(conversationId, 'Late')).toBe(false);
  });
});

describe('history list (keyset pagination)', () => {
  async function conversationAt(ownerId: string, iso: string, id?: string) {
    const row = await prisma.conversation.create({ data: { ...(id && { id }), ownerId, lastMessageAt: new Date(iso) } });
    return row.id;
  }

  it('walks every conversation exactly once, newest first, across pages', async () => {
    const ownerId = owner();
    const ids: string[] = [];
    for (let minute = 0; minute < 7; minute++) ids.push(await conversationAt(ownerId, `2026-11-09T10:0${minute}:00.000Z`));
    await conversationAt(owner(), '2026-11-09T12:00:00.000Z'); // someone else's, newer

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(ownerId, { limit: 3, cursor });
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual([...ids].reverse());
  });

  it('is stable when many conversations share the same timestamp', async () => {
    const ownerId = owner();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await conversationAt(ownerId, '2026-11-09T10:00:00.000Z'));

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(ownerId, { limit: 2, cursor });
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toEqual([...seen].sort().reverse()); // ties break by id, descending
  });

  it('skips deleted conversations', async () => {
    const ownerId = owner();
    const keep = await conversationAt(ownerId, '2026-11-09T10:00:00.000Z');
    const gone = await conversationAt(ownerId, '2026-11-09T10:01:00.000Z');
    await service.remove(ownerId, gone);

    expect((await service.list(ownerId, {})).items.map((c) => c.id)).toEqual([keep]);
  });
});

describe('reading the active branch (recursive query)', () => {
  it('returns the live branch oldest first, without the dead branch', async () => {
    const ownerId = owner();
    const first = await service.appendUserMessage(ownerId, { content: 'one' });
    const answer = await service.appendAssistantMessage(ownerId, {
      conversationId: first.conversationId,
      parentId: first.message.id,
      content: 'a1',
      generationId: randomUUID(),
    });
    for (const text of ['dead branch', 'live branch']) {
      await service.appendUserMessage(ownerId, { conversationId: first.conversationId, parentId: answer.id, content: text });
    }

    const detail = await service.getBranch(ownerId, first.conversationId, {});

    expect(detail.messages.map((m) => m.content)).toEqual(['one', 'a1', 'live branch']);
    expect(detail.messages.map((m) => m.depth)).toEqual([0, 1, 2]);
  });

  it('returns typed values: dates, numbers, role and reasoning', async () => {
    const ownerId = owner();
    const first = await service.appendUserMessage(ownerId, { content: 'q' });
    await service.appendAssistantMessage(ownerId, {
      conversationId: first.conversationId,
      parentId: first.message.id,
      content: 'a',
      reasoning: 'because',
      generationId: randomUUID(),
    });

    const [user, assistant] = (await service.getBranch(ownerId, first.conversationId, {})).messages;

    expect(user).toMatchObject({ role: 'USER', depth: 0, parentId: null, reasoning: null, generationId: null });
    expect(assistant).toMatchObject({ role: 'ASSISTANT', depth: 1, parentId: user.id, reasoning: 'because' });
    expect(assistant.createdAt).toBeInstanceOf(Date);
    expect(typeof assistant.depth).toBe('number');
  });

  it('pages back through a long branch without gaps', async () => {
    const ownerId = owner();
    const { conversationId, messages } = await chain(ownerId, 6); // 11 messages, depths 0 to 10

    const seen: number[] = [];
    let before: number | undefined;
    do {
      const page = await service.getBranch(ownerId, conversationId, { limit: 4, before });
      seen.unshift(...page.messages.map((m) => m.depth));
      before = page.nextBefore ?? undefined;
    } while (before);

    expect(seen).toEqual(messages.map((m) => m.depth));
  });

  it('returns only the last N messages of the path for building context', async () => {
    const ownerId = owner();
    const { conversationId, messages } = await chain(ownerId, 6);

    const path = await service.getPathTo(ownerId, conversationId, messages.at(-1)!.id, 4);

    expect(path.map((m) => m.id)).toEqual(messages.slice(-4).map((m) => m.id));
  });

  it("never reads another conversation's messages, even with the right message id", async () => {
    const ownerId = owner();
    const one = await root(ownerId);
    const two = await root(ownerId);

    const rows = await repository.branchWindow(two.conversationId, one.message.id, 0, 10);

    expect(rows).toEqual([]);
  });
});
