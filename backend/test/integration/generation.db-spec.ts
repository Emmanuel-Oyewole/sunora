import { randomUUID } from 'node:crypto';
import type { Generation } from '../../src/generated/prisma/client.js';
import { ConversationsRepository } from '../../src/modules/conversations/conversations.repository.js';
import { ConversationsService } from '../../src/modules/conversations/conversations.service.js';
import { GenerationRepository, type NewGeneration } from '../../src/modules/generation/generation.repository.js';
import { GenerationService } from '../../src/modules/generation/generation.service.js';
import { isTerminal } from '../../src/modules/generation/generation.state.js';
import { GenerationRunner } from '../../src/modules/generation/generation-runner.js';
import { GenerationLiveFeed } from '../../src/modules/generation/live-feed.js';
import type { PrismaService } from '../../src/shared/database/prisma.service.js';
import type { UnitOfWork } from '../../src/shared/database/unit-of-work.js';
import { FakeAiProvider, answer, hangingAfter } from '../helpers/fake-ai-provider.js';
import { FAST_OPTIONS, generationEnv, waitFor } from '../helpers/generation-world.js';
import { connectTestDatabase, emptyConversationTables, emptyGenerationTables } from './test-database.js';

let prisma: PrismaService;
let unitOfWork: UnitOfWork;
let repository: GenerationRepository;

beforeAll(async () => {
  ({ prisma, unitOfWork } = connectTestDatabase());
  await prisma.$connect();
  repository = new GenerationRepository(prisma);
});
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  await emptyGenerationTables(prisma);
  await emptyConversationTables(prisma);
});

const owner = () => randomUUID();
const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'accepted',
    (error: Error) => error.message,
  );

const newGeneration = (overrides: Partial<NewGeneration> = {}): NewGeneration => ({
  userId: owner(),
  conversationId: randomUUID(),
  userMessageId: randomUUID(),
  attemptNumber: 1,
  trigger: 'INITIAL',
  thinking: false,
  provider: 'deepseek',
  model: 'deepseek-flash',
  ...overrides,
});

/** One process: its own runner, service and live feed over the shared database, like a separate boot. */
function boot(instanceId: string) {
  const provider = new FakeAiProvider();
  const feed = new GenerationLiveFeed();
  const conversations = new ConversationsService(new ConversationsRepository(prisma), unitOfWork);
  const env = generationEnv();
  const runner = new GenerationRunner(repository, conversations, provider, feed, env, instanceId, FAST_OPTIONS);
  const service = new GenerationService(repository, conversations, runner, feed, env, instanceId, FAST_OPTIONS);
  return { provider, runner, service, conversations };
}

const finished = (id: string) =>
  waitFor(async () => {
    const row = await repository.find(id);
    return row && isTerminal(row.status) ? row : undefined;
  }, `generation ${id} to finish`);

describe('generation schema constraints', () => {
  it('rejects an attempt number below 1', async () => {
    expect(await rejection(prisma.generation.create({ data: newGeneration({ attemptNumber: 0 }) }))).toMatch(
      /generations_attempt_number_chk/,
    );
  });

  it('requires a finish time exactly when a generation has ended', async () => {
    const base = newGeneration();

    expect(await rejection(prisma.generation.create({ data: { ...base, status: 'COMPLETED' } }))).toMatch(/generations_finished_at_chk/);
    expect(await rejection(prisma.generation.create({ data: { ...base, status: 'RUNNING', finishedAt: new Date() } }))).toMatch(
      /generations_finished_at_chk/,
    );
    expect(await rejection(prisma.generation.create({ data: { ...base, status: 'FAILED', finishedAt: new Date() } }))).toBe('accepted');
  });

  it('allows an answer id only on a completed generation', async () => {
    const answerId = randomUUID();

    expect(
      await rejection(
        prisma.generation.create({ data: { ...newGeneration(), status: 'FAILED', finishedAt: new Date(), assistantMessageId: answerId } }),
      ),
    ).toMatch(/generations_assistant_message_chk/);
    expect(
      await rejection(
        prisma.generation.create({ data: { ...newGeneration(), status: 'COMPLETED', finishedAt: new Date(), assistantMessageId: answerId } }),
      ),
    ).toBe('accepted');
  });

  it('allows one row per attempt of a message', async () => {
    const data = newGeneration();
    await prisma.generation.create({ data });

    expect(await rejection(prisma.generation.create({ data }))).toMatch(/Unique constraint/);
    expect(await rejection(prisma.generation.create({ data: { ...data, attemptNumber: 2 } }))).toBe('accepted');
  });

  it('numbers chunks from 1, keeps them small, and refuses a repeated number', async () => {
    const { id } = await repository.create(newGeneration());
    const chunk = (seq: number, text = 'x') => prisma.generationChunk.create({ data: { generationId: id, seq, text } });

    expect(await rejection(chunk(0))).toMatch(/generation_chunks_seq_chk/);
    expect(await rejection(chunk(1, 'x'.repeat(20_001)))).toMatch(/generation_chunks_text_length_chk/);
    expect(await rejection(chunk(1))).toBe('accepted');
    expect(await rejection(chunk(1))).toMatch(/Unique constraint/);
  });

  it('bounds idempotency keys', async () => {
    const key = (value: string) =>
      prisma.idempotencyKey.create({ data: { userId: owner(), key: value, requestHash: 'h', expiresAt: new Date(Date.now() + 1000) } });

    expect(await rejection(key(''))).toMatch(/idempotency_keys_key_length_chk/);
    expect(await rejection(key('k'.repeat(129)))).toMatch(/idempotency_keys_key_length_chk/);
    expect(await rejection(key('k'.repeat(128)))).toBe('accepted');
  });

  it('deletes chunks with their generation, and only detaches an idempotency key from it', async () => {
    const generation = await repository.create(newGeneration());
    await repository.appendChunks([{ generationId: generation.id, seq: 1, kind: 'TEXT', text: 'a' }]);
    const key = await prisma.idempotencyKey.create({
      data: { userId: generation.userId, key: 'k', requestHash: 'h', generationId: generation.id, expiresAt: new Date(Date.now() + 1000) },
    });

    await prisma.generation.delete({ where: { id: generation.id } });

    expect(await prisma.generationChunk.count()).toBe(0);
    expect((await prisma.idempotencyKey.findUniqueOrThrow({ where: { id: key.id } })).generationId).toBeNull();
  });

  it('has partial indexes that only cover active generations', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('generations_active_sweep_idx', 'generations_active_user_idx')`;

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.indexdef).toMatch(/WHERE \(status = ANY \(ARRAY\['PENDING'::.*, 'RUNNING'::.*\]\)\)/);
  });
});

describe('one winner under concurrency', () => {
  it('lets only one of two starts claim a pending generation', async () => {
    const { id } = await repository.create(newGeneration());

    const results = await Promise.all([repository.claimRun(id, 'a', new Date()), repository.claimRun(id, 'b', new Date())]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repository.find(id))?.status).toBe('RUNNING');
  });

  it('lets only one of a completion and a cancel win', async () => {
    const { id } = await repository.create(newGeneration());
    await repository.claimRun(id, 'a', new Date());

    const results = await Promise.all([
      repository.transition(id, 'RUNNING', 'COMPLETED', new Date()),
      repository.transition(id, 'RUNNING', 'CANCELLED', new Date()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(isTerminal((await repository.find(id))!.status)).toBe(true);
  });

  it('never leaves a final state', async () => {
    const { id } = await repository.create(newGeneration());
    await repository.claimRun(id, 'a', new Date());
    await repository.transition(id, 'RUNNING', 'FAILED', new Date(), { errorCode: 'X' });

    expect(await repository.transition(id, 'RUNNING', 'COMPLETED', new Date())).toBe(false);
    await expect(repository.transition(id, 'FAILED', 'RUNNING', new Date())).rejects.toThrow(/cannot go from/);
    expect(await repository.claimRun(id, 'b', new Date())).toBe(false);
  });

  it('creates one attempt when two retries race', async () => {
    const data = newGeneration({ attemptNumber: 2, trigger: 'RETRY' });

    const results = await Promise.allSettled([repository.create(data), repository.create(data)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.generation.count()).toBe(1);
  });

  it('lets one of many identical submits claim the idempotency key', async () => {
    const input = { userId: owner(), key: 'same-key', requestHash: 'h', now: new Date(), expiresAt: new Date(Date.now() + 60_000) };

    const claims = await Promise.all(Array.from({ length: 6 }, () => repository.claimKey(input)));

    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    expect(new Set(claims.map((c) => c.row.id)).size).toBe(1);
  });

  it('treats an expired key as free and takes over a stale claim only once', async () => {
    const userId = owner();
    const past = new Date(Date.now() - 60_000);
    await repository.claimKey({ userId, key: 'old', requestHash: 'h', now: new Date(past.getTime() - 120_000), expiresAt: past });

    const reclaimed = await repository.claimKey({ userId, key: 'old', requestHash: 'h2', now: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    expect(reclaimed.claimed).toBe(true);

    const stale = new Date(Date.now() + 1000);
    const takeovers = await Promise.all([
      repository.takeOverClaim(reclaimed.row.id, stale, new Date(Date.now() + 2000)),
      repository.takeOverClaim(reclaimed.row.id, stale, new Date(Date.now() + 2000)),
    ]);
    expect(takeovers.filter(Boolean)).toHaveLength(1);
    expect(await repository.takeOverClaim(reclaimed.row.id, new Date(Date.now() - 60_000), new Date())).toBe(false); // not stale
  });

  it('does not release a claim that already led to a generation', async () => {
    const generation = await repository.create(newGeneration());
    const claim = await repository.claimKey({ userId: generation.userId, key: 'k', requestHash: 'h', now: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    await repository.rememberGeneration(claim.row.id, generation.id);

    await repository.releaseClaim(claim.row.id);

    expect(await prisma.idempotencyKey.count()).toBe(1);
  });
});

describe('queries', () => {
  it('replays chunks in order, after a given number, in pages', async () => {
    const { id } = await repository.create(newGeneration());
    await repository.appendChunks([3, 1, 2, 5, 4].map((seq) => ({ generationId: id, seq, kind: 'TEXT' as const, text: `t${seq}` })));

    expect((await repository.chunksAfter(id, 0, 10)).map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await repository.chunksAfter(id, 2, 2)).map((c) => c.seq)).toEqual([3, 4]);
    expect(await repository.chunksAfter(id, 5, 10)).toEqual([]);
    expect(await repository.lastSeq(id)).toBe(5);
    expect(await repository.lastSeq(randomUUID())).toBe(0);
  });

  it('joins partial output by kind, in order', async () => {
    const { id } = await repository.create(newGeneration());
    await repository.appendChunks([
      { generationId: id, seq: 1, kind: 'REASONING', text: 'think ' },
      { generationId: id, seq: 2, kind: 'REASONING', text: 'more' },
      { generationId: id, seq: 3, kind: 'TEXT', text: 'ans' },
      { generationId: id, seq: 4, kind: 'TEXT', text: 'wer' },
    ]);

    expect(await repository.partialOutput(id)).toEqual({ text: 'answer', reasoning: 'think more' });
  });

  it('counts only a user\'s active generations', async () => {
    const userId = owner();
    const a = await repository.create(newGeneration({ userId }));
    await repository.create(newGeneration({ userId }));
    await repository.create(newGeneration());
    await repository.claimRun(a.id, 'x', new Date());
    const done = await repository.create(newGeneration({ userId }));
    await repository.claimRun(done.id, 'x', new Date());
    await repository.transition(done.id, 'RUNNING', 'COMPLETED', new Date());

    expect(await repository.countActive(userId)).toBe(2);
  });

  it('records a cancel request only while active, and lists newest first', async () => {
    const userId = owner();
    const conversationId = randomUUID();
    const first = await repository.create(newGeneration({ userId, conversationId }));
    const second = await repository.create(newGeneration({ userId, conversationId }));
    await repository.claimRun(first.id, 'x', new Date());
    await repository.transition(first.id, 'RUNNING', 'COMPLETED', new Date());

    expect(await repository.requestCancel(first.id, userId, new Date())).toBe(false);
    expect(await repository.requestCancel(second.id, userId, new Date())).toBe(true);
    expect(await repository.requestCancel(second.id, owner(), new Date())).toBe(false); // not the owner
    expect((await repository.listForConversation(userId, conversationId, 5)).map((g) => g.id)).toEqual([second.id, first.id]);
  });

  it('interrupts only what a dead process left behind', async () => {
    const mine = await repository.create(newGeneration());
    await repository.claimRun(mine.id, 'me', new Date());
    const theirs = await repository.create(newGeneration());
    await repository.claimRun(theirs.id, 'dead', new Date());
    const neverStarted = await repository.create(newGeneration());
    const done = await repository.create(newGeneration());
    await repository.claimRun(done.id, 'dead', new Date());
    await repository.transition(done.id, 'RUNNING', 'COMPLETED', new Date());

    const count = await repository.interruptForeign('me', new Date());

    expect(count).toBe(2);
    const status = async (g: Generation) => (await repository.find(g.id))!;
    expect(await status(mine)).toMatchObject({ status: 'RUNNING' });
    expect(await status(theirs)).toMatchObject({ status: 'INTERRUPTED', errorCode: 'SERVER_RESTART' });
    expect((await status(theirs)).finishedAt).not.toBeNull();
    expect(await status(neverStarted)).toMatchObject({ status: 'INTERRUPTED' });
    expect(await status(done)).toMatchObject({ status: 'COMPLETED' });
  });
});

describe('the whole lifecycle on a real database', () => {
  it('saves the message, the generation, its chunks and the title', async () => {
    const stack = boot('instance-1');
    stack.provider.next(answer(['Hello', ' there'], { reasoning: ['Considering'] }));
    const userId = owner();

    const result = await stack.service.submit(userId, 'key-1', { content: 'Hi' });
    const generation = await finished(result.generationId);

    expect(generation).toMatchObject({ status: 'COMPLETED', finishReason: 'stop', ownerInstanceId: 'instance-1' });
    const messages = await prisma.message.findMany({ orderBy: { depth: 'asc' } });
    expect(messages.map((m) => [m.role, m.content, m.reasoning])).toEqual([
      ['USER', 'Hi', null],
      ['ASSISTANT', 'Hello there', 'Considering'],
    ]);
    expect(generation.assistantMessageId).toBe(messages[1].id);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: result.conversationId } })).activeLeafId).toBe(messages[1].id);
    expect(await repository.partialOutput(generation.id)).toEqual({ text: 'Hello there', reasoning: 'Considering' });
    await waitFor(async () => (await prisma.conversation.findUniqueOrThrow({ where: { id: result.conversationId } })).title, 'the title');
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: result.conversationId } })).toMatchObject({
      title: 'Greeting',
      titleSource: 'GENERATED',
    });
  });

  it('runs one answer and one message when the same submit arrives twice at once', async () => {
    const stack = boot('instance-1');
    const userId = owner();

    const results = await Promise.allSettled([
      stack.service.submit(userId, 'dup', { content: 'Hi' }),
      stack.service.submit(userId, 'dup', { content: 'Hi' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    await waitFor(async () => (await prisma.generation.count()) === 1, 'one generation');
    await finished((await prisma.generation.findFirstOrThrow()).id);
    expect(await prisma.generation.count()).toBe(1);
    expect(await prisma.message.count({ where: { role: 'USER' } })).toBe(1);
  });

  it('retries a failed answer on top of the same message', async () => {
    const stack = boot('instance-1');
    stack.provider.next(hangingAfter(['partial']));
    const userId = owner();
    const first = await stack.service.submit(userId, 'k', { content: 'Hi' });
    await waitFor(async () => (await repository.chunksAfter(first.generationId, 0, 1)).length > 0, 'some output');
    await stack.service.cancel(userId, first.generationId);
    await finished(first.generationId);

    const retried = await stack.service.retry(userId, first.generationId);
    await finished(retried.id);

    expect(await prisma.generation.count({ where: { userMessageId: first.userMessageId } })).toBe(2);
    expect(await prisma.message.count({ where: { role: 'ASSISTANT' } })).toBe(1);
    expect((await repository.find(retried.id))?.status).toBe('COMPLETED');
  });

  it('survives a backend restart in the middle of an answer: the partial output is kept and a retry works', async () => {
    const before = boot('instance-1');
    before.provider.next(hangingAfter(['The answer so fa']));
    const userId = owner();
    const result = await before.service.submit(userId, 'restart-key', { content: 'Tell me something long' });
    await waitFor(async () => (await repository.chunksAfter(result.generationId, 0, 1)).length > 0, 'some output');

    // The process dies and a new one starts on the same database.
    const after = boot('instance-2');
    await after.service.onApplicationBootstrap();

    const orphan = await repository.find(result.generationId);
    expect(orphan).toMatchObject({ status: 'INTERRUPTED', errorCode: 'SERVER_RESTART' });
    expect((await after.service.get(userId, result.generationId)).partial?.text).toBe('The answer so fa');
    expect(await prisma.message.count({ where: { role: 'ASSISTANT' } })).toBe(0); // no partial answer in the history

    // The old process's run cannot overwrite what the sweep decided.
    before.runner.abort(result.generationId);
    await waitFor(() => !before.runner.isRunning(result.generationId), 'the old run to end');
    expect((await repository.find(result.generationId))?.status).toBe('INTERRUPTED');

    // The user retries; the new process answers on the same message.
    const retried = await after.service.retry(userId, result.generationId);
    expect((await finished(retried.id)).status).toBe('COMPLETED');
    expect(await prisma.message.count({ where: { role: 'ASSISTANT' } })).toBe(1);
    expect(await prisma.generation.count({ where: { userMessageId: result.userMessageId } })).toBe(2);
  });
});
