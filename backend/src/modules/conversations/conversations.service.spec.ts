import { InMemoryConversations } from '../../../test/helpers/in-memory-conversations.js';
import type { UnitOfWork } from '../../shared/database/unit-of-work.js';
import { MAX_MESSAGE_LENGTH } from './conversations.constants.js';
import type { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';

const ADA = '0190aaaa-0000-7000-8000-00000000000a';
const BOB = '0190aaaa-0000-7000-8000-00000000000b';
const GENERATION = '0190aaaa-0000-7000-8000-0000000000aa';

function setup() {
  const world = new InMemoryConversations();
  const service = new ConversationsService(
    world.repository as unknown as ConversationsRepository,
    world.unitOfWork as unknown as UnitOfWork,
  );
  return { world, service };
}
type Setup = ReturnType<typeof setup>;

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: { code?: string }) => error.code ?? 'unknown error',
  );

/** One exchange: a user message and its answer. Returns the ids. */
async function exchange(s: Setup, owner: string, conversationId: string | undefined, parentId?: string, text = 'q') {
  const user = await s.service.appendUserMessage(owner, { conversationId, parentId, content: text });
  const answer = await s.service.appendAssistantMessage(owner, {
    conversationId: user.conversationId,
    parentId: user.message.id,
    content: `a to ${text}`,
    generationId: GENERATION,
  });
  return { conversationId: user.conversationId, user: user.message, answer };
}

describe('ConversationsService', () => {
  afterEach(() => vi.useRealTimers());

  describe('appendUserMessage', () => {
    it('starts a conversation with the first message and makes it the active leaf', async () => {
      const s = setup();

      const { conversationId, message } = await s.service.appendUserMessage(ADA, { content: 'Hello' });

      expect(message).toMatchObject({ parentId: null, role: 'USER', depth: 0, content: 'Hello', reasoning: null });
      expect(s.world.conversations).toHaveLength(1);
      expect(s.world.conversations[0]).toMatchObject({ id: conversationId, ownerId: ADA, activeLeafId: message.id });
    });

    it('continues after an assistant message at the next depth', async () => {
      const s = setup();
      const first = await exchange(s, ADA, undefined);

      const next = await s.service.appendUserMessage(ADA, {
        conversationId: first.conversationId,
        parentId: first.answer.id,
        content: 'And then?',
      });

      expect(next.message).toMatchObject({ parentId: first.answer.id, depth: 2 });
      expect(s.world.conversations[0].activeLeafId).toBe(next.message.id);
    });

    it('allows a second root, which is what editing the first prompt creates', async () => {
      const s = setup();
      const first = await exchange(s, ADA, undefined);

      const edited = await s.service.appendUserMessage(ADA, { conversationId: first.conversationId, content: 'Edited' });

      expect(edited.message).toMatchObject({ parentId: null, depth: 0 });
      expect(s.world.messages.filter((m) => m.parentId === null)).toHaveLength(2);
    });

    it('rejects a user message that follows another user message', async () => {
      const s = setup();
      const first = await exchange(s, ADA, undefined);

      const result = s.service.appendUserMessage(ADA, {
        conversationId: first.conversationId,
        parentId: first.user.id,
        content: 'x',
      });

      expect(await codeOf(result)).toBe('INVALID_MESSAGE_PARENT');
    });

    it('rejects a parent without a conversation', async () => {
      const s = setup();
      const first = await exchange(s, ADA, undefined);

      expect(await codeOf(s.service.appendUserMessage(ADA, { parentId: first.answer.id, content: 'x' }))).toBe(
        'INVALID_MESSAGE_PARENT',
      );
    });

    it('does not find a parent that lives in another conversation', async () => {
      const s = setup();
      const one = await exchange(s, ADA, undefined);
      const two = await exchange(s, ADA, undefined);

      const result = s.service.appendUserMessage(ADA, {
        conversationId: one.conversationId,
        parentId: two.answer.id,
        content: 'graft',
      });

      expect(await codeOf(result)).toBe('MESSAGE_NOT_FOUND');
    });

    it("treats someone else's conversation exactly like a missing one", async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      const intruder = await codeOf(s.service.appendUserMessage(BOB, { conversationId: ada.conversationId, content: 'hi' }));
      const missing = await codeOf(
        s.service.appendUserMessage(BOB, { conversationId: '0190aaaa-0000-7000-8000-00000000ffff', content: 'hi' }),
      );

      expect(intruder).toBe('CONVERSATION_NOT_FOUND');
      expect(missing).toBe(intruder);
    });

    it('refuses to add to a deleted conversation', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);
      await s.service.remove(ADA, ada.conversationId);

      expect(await codeOf(s.service.appendUserMessage(ADA, { conversationId: ada.conversationId, content: 'hi' }))).toBe(
        'CONVERSATION_NOT_FOUND',
      );
    });

    it.each([
      ['empty', ''],
      ['only whitespace', '   \n '],
      ['too long', 'x'.repeat(MAX_MESSAGE_LENGTH + 1)],
    ])('rejects a message that is %s, without creating a conversation', async (_name, content) => {
      const s = setup();

      expect(await codeOf(s.service.appendUserMessage(ADA, { content }))).toBe('INVALID_MESSAGE');
      expect(s.world.conversations).toHaveLength(0);
    });
  });

  describe('appendAssistantMessage', () => {
    it('stores the answer with its reasoning and generation, and moves the active leaf to it', async () => {
      const s = setup();
      const user = await s.service.appendUserMessage(ADA, { content: 'Why?' });

      const answer = await s.service.appendAssistantMessage(ADA, {
        conversationId: user.conversationId,
        parentId: user.message.id,
        content: 'Because.',
        reasoning: 'Let me think.',
        generationId: GENERATION,
      });

      expect(answer).toMatchObject({
        role: 'ASSISTANT',
        parentId: user.message.id,
        depth: 1,
        reasoning: 'Let me think.',
        generationId: GENERATION,
      });
      expect(s.world.conversations[0].activeLeafId).toBe(answer.id);
    });

    it('leaves the active leaf alone if the user moved on to another branch meanwhile', async () => {
      const s = setup();
      const first = await s.service.appendUserMessage(ADA, { content: 'Question' });
      // The user edits the prompt while the answer is still being generated.
      const edited = await s.service.appendUserMessage(ADA, { conversationId: first.conversationId, content: 'Edited' });

      await s.service.appendAssistantMessage(ADA, {
        conversationId: first.conversationId,
        parentId: first.message.id,
        content: 'Late answer',
        generationId: GENERATION,
      });

      expect(s.world.conversations[0].activeLeafId).toBe(edited.message.id);
      expect(s.world.messages).toHaveLength(3);
    });

    it('rejects an answer to an assistant message', async () => {
      const s = setup();
      const first = await exchange(s, ADA, undefined);

      const result = s.service.appendAssistantMessage(ADA, {
        conversationId: first.conversationId,
        parentId: first.answer.id,
        content: 'x',
        generationId: GENERATION,
      });

      expect(await codeOf(result)).toBe('INVALID_MESSAGE_PARENT');
    });

    it('rejects an answer for another owner or a deleted conversation', async () => {
      const s = setup();
      const user = await s.service.appendUserMessage(ADA, { content: 'Q' });
      const request = { conversationId: user.conversationId, parentId: user.message.id, content: 'A', generationId: GENERATION };

      expect(await codeOf(s.service.appendAssistantMessage(BOB, request))).toBe('CONVERSATION_NOT_FOUND');
      await s.service.remove(ADA, user.conversationId);
      expect(await codeOf(s.service.appendAssistantMessage(ADA, request))).toBe('CONVERSATION_NOT_FOUND');
    });

    it('rejects an empty answer', async () => {
      const s = setup();
      const user = await s.service.appendUserMessage(ADA, { content: 'Q' });

      const result = s.service.appendAssistantMessage(ADA, {
        conversationId: user.conversationId,
        parentId: user.message.id,
        content: '  ',
        generationId: GENERATION,
      });

      expect(await codeOf(result)).toBe('INVALID_MESSAGE');
    });
  });

  describe('getPathTo', () => {
    it('returns the path from the root, oldest first, and ignores other branches', async () => {
      const s = setup();
      const one = await exchange(s, ADA, undefined, undefined, 'one');
      const two = await exchange(s, ADA, one.conversationId, one.answer.id, 'two');
      await exchange(s, ADA, one.conversationId, one.answer.id, 'dead branch');

      const path = await s.service.getPathTo(ADA, one.conversationId, two.answer.id, 50);

      expect(path.map((m) => m.content)).toEqual(['one', 'a to one', 'two', 'a to two']);
    });

    it('returns only the last `limit` messages of a long path', async () => {
      const s = setup();
      const one = await exchange(s, ADA, undefined, undefined, 'one');
      const two = await exchange(s, ADA, one.conversationId, one.answer.id, 'two');

      const path = await s.service.getPathTo(ADA, one.conversationId, two.answer.id, 3);

      expect(path.map((m) => m.content)).toEqual(['a to one', 'two', 'a to two']);
    });

    it('is not available to another user', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      expect(await codeOf(s.service.getPathTo(BOB, ada.conversationId, ada.answer.id, 10))).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  describe('titles', () => {
    it('saves a generated title', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      expect(await s.service.applyGeneratedTitle(ada.conversationId, 'Cooking pasta')).toBe(true);
      expect((await s.service.getBranch(ADA, ada.conversationId, {})).title).toBe('Cooking pasta');
    });

    it('never overwrites a title the user typed, even if the generated one arrives later', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);
      await s.service.rename(ADA, ada.conversationId, 'My own title');

      expect(await s.service.applyGeneratedTitle(ada.conversationId, 'Late generated title')).toBe(false);
      expect((await s.service.getBranch(ADA, ada.conversationId, {})).title).toBe('My own title');
    });

    it('does not touch a deleted conversation', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);
      await s.service.remove(ADA, ada.conversationId);

      expect(await s.service.applyGeneratedTitle(ada.conversationId, 'Title')).toBe(false);
    });
  });

  describe('list', () => {
    async function threeConversations(s: Setup) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const ids: string[] = [];
      for (const minute of [1, 2, 3]) {
        vi.setSystemTime(new Date(`2026-11-09T10:0${minute}:00.000Z`));
        ids.push((await exchange(s, ADA, undefined, undefined, `chat ${minute}`)).conversationId);
      }
      return ids;
    }

    it('lists newest activity first, and only your own', async () => {
      const s = setup();
      const [first, second, third] = await threeConversations(s);
      await exchange(s, BOB, undefined);

      const page = await s.service.list(ADA, {});

      expect(page.items.map((c) => c.id)).toEqual([third, second, first]);
      expect(page.nextCursor).toBeNull();
    });

    it('moves a conversation to the top when it gets a new message', async () => {
      const s = setup();
      const [first, , third] = await threeConversations(s);
      vi.setSystemTime(new Date('2026-11-09T11:00:00.000Z'));
      const answer = s.world.messages.find((m) => m.conversationId === first && m.role === 'ASSISTANT')!;

      await s.service.appendUserMessage(ADA, { conversationId: first, parentId: answer.id, content: 'more' });

      expect((await s.service.list(ADA, {})).items.map((c) => c.id)[0]).toBe(first);
      expect((await s.service.list(ADA, {})).items.map((c) => c.id)).toContain(third);
    });

    it('pages without gaps or repeats', async () => {
      const s = setup();
      const [first, second, third] = await threeConversations(s);

      const page1 = await s.service.list(ADA, { limit: 2 });
      const page2 = await s.service.list(ADA, { limit: 2, cursor: page1.nextCursor! });

      expect(page1.items.map((c) => c.id)).toEqual([third, second]);
      expect(page1.nextCursor).not.toBeNull();
      expect(page2.items.map((c) => c.id)).toEqual([first]);
      expect(page2.nextCursor).toBeNull();
    });

    it('keeps paging stable when two conversations share a timestamp', async () => {
      const s = setup();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-09T10:00:00.000Z'));
      const ids = [
        (await exchange(s, ADA, undefined)).conversationId,
        (await exchange(s, ADA, undefined)).conversationId,
        (await exchange(s, ADA, undefined)).conversationId,
      ];

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.service.list(ADA, { limit: 1, cursor });
        seen.push(...page.items.map((c) => c.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect([...seen].sort()).toEqual([...ids].sort());
    });

    it('hides deleted conversations', async () => {
      const s = setup();
      const [first, second, third] = await threeConversations(s);
      await s.service.remove(ADA, second);

      expect((await s.service.list(ADA, {})).items.map((c) => c.id)).toEqual([third, first]);
    });

    it('rejects a bad cursor', async () => {
      expect(await codeOf(setup().service.list(ADA, { cursor: 'nonsense' }))).toBe('INVALID_CURSOR');
    });
  });

  describe('getBranch', () => {
    it('returns an empty conversation as no messages', async () => {
      const s = setup();
      const row = await s.world.repository.createConversation(ADA, new Date());

      expect(await s.service.getBranch(ADA, row.id, {})).toMatchObject({ messages: [], nextBefore: null });
    });

    it('returns the active branch, oldest first, without the dead branch', async () => {
      const s = setup();
      const one = await exchange(s, ADA, undefined, undefined, 'one');
      await exchange(s, ADA, one.conversationId, one.answer.id, 'dead branch');
      await exchange(s, ADA, one.conversationId, one.answer.id, 'live branch');

      const detail = await s.service.getBranch(ADA, one.conversationId, {});

      expect(detail.messages.map((m) => m.content)).toEqual(['one', 'a to one', 'live branch', 'a to live branch']);
      expect(detail.nextBefore).toBeNull();
    });

    it('pages back through a long branch with nextBefore', async () => {
      const s = setup();
      let last = await exchange(s, ADA, undefined, undefined, 'm0');
      for (const n of [1, 2]) last = await exchange(s, ADA, last.conversationId, last.answer.id, `m${n}`);
      // 6 messages, depths 0 to 5.

      const newest = await s.service.getBranch(ADA, last.conversationId, { limit: 2 });
      const middle = await s.service.getBranch(ADA, last.conversationId, { limit: 2, before: newest.nextBefore! });
      const oldest = await s.service.getBranch(ADA, last.conversationId, { limit: 2, before: middle.nextBefore! });

      expect(newest.messages.map((m) => m.depth)).toEqual([4, 5]);
      expect(middle.messages.map((m) => m.depth)).toEqual([2, 3]);
      expect(oldest.messages.map((m) => m.depth)).toEqual([0, 1]);
      expect(newest.nextBefore).toBe(4);
      expect(oldest.nextBefore).toBeNull();
    });

    it('is not found for another user or after deletion', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      expect(await codeOf(s.service.getBranch(BOB, ada.conversationId, {}))).toBe('CONVERSATION_NOT_FOUND');
      await s.service.remove(ADA, ada.conversationId);
      expect(await codeOf(s.service.getBranch(ADA, ada.conversationId, {}))).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  describe('rename and delete', () => {
    it('renames and marks the title as typed by the user', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      const renamed = await s.service.rename(ADA, ada.conversationId, 'Trip plan');

      expect(renamed.title).toBe('Trip plan');
      expect(s.world.conversations[0].titleSource).toBe('MANUAL');
    });

    it("cannot rename or delete someone else's conversation", async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      expect(await codeOf(s.service.rename(BOB, ada.conversationId, 'Mine now'))).toBe('CONVERSATION_NOT_FOUND');
      expect(await codeOf(s.service.remove(BOB, ada.conversationId))).toBe('CONVERSATION_NOT_FOUND');
      expect(s.world.conversations[0]).toMatchObject({ title: null, deletedAt: null });
    });

    it('soft deletes: the rows stay, the conversation is gone for the owner', async () => {
      const s = setup();
      const ada = await exchange(s, ADA, undefined);

      await s.service.remove(ADA, ada.conversationId);

      expect(s.world.conversations[0].deletedAt).not.toBeNull();
      expect(s.world.messages).toHaveLength(2);
      expect(await codeOf(s.service.remove(ADA, ada.conversationId))).toBe('CONVERSATION_NOT_FOUND');
    });
  });
});
