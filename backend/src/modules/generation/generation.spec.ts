import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Generation } from '../../generated/prisma/client.js';
import { USAGE, answer, failingAfter, hangingAfter, type Script } from '../../../test/helpers/fake-ai-provider.js';
import { ADA, BOB, createGenerationWorld, waitFor, type GenerationWorld } from '../../../test/helpers/generation-world.js';
import { GenerationService, type StreamItem } from './generation.service.js';
import { isTerminal } from './generation.state.js';

let w: GenerationWorld;
beforeEach(() => {
  w = createGenerationWorld();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await w.runner.beforeApplicationShutdown(); // stops anything still running and waits for background work
});

const submit = (
  user = ADA,
  content = 'Hi there',
  extra: { conversationId?: string; parentId?: string; thinking?: boolean } = {},
  key = randomUUID(),
) => w.service.submit(user, key, { content, ...extra });

const row = (id: string): Generation => w.generationWorld.generations.find((g) => g.id === id)!;
const finished = (id: string) => waitFor(() => (isTerminal(row(id).status) ? row(id) : undefined), `generation ${id} to finish`);
const running = (id: string) => waitFor(() => row(id).status === 'RUNNING' && w.generationWorld.chunks.some((c) => c.generationId === id), 'it to be running');
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: { code?: string }) => error.code ?? 'unknown error',
  );
const chunkText = (id: string, kind: 'TEXT' | 'REASONING') =>
  w.generationWorld.chunks
    .filter((c) => c.generationId === id && c.kind === kind)
    .sort((a, b) => a.seq - b.seq)
    .map((c) => c.text)
    .join('');

/** A script that holds back its answer until the test lets it go. */
function gated(text: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const script: Script = async function* () {
    await gate;
    yield { type: 'text', text };
    yield { type: 'done', finishReason: 'stop', usage: USAGE, model: 'deepseek-flash' };
  };
  return { script, release };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a generation that succeeds', () => {
  it('saves the answer with its reasoning, finishes COMPLETED, and records what ran', async () => {
    w.provider.next(answer(['Hello', ' world'], { reasoning: ['Thinking it through'] }));

    const result = await submit();
    const generation = await finished(result.generationId);

    expect(result).toMatchObject({ status: 'PENDING' });
    expect(generation).toMatchObject({
      status: 'COMPLETED',
      finishReason: 'stop',
      errorCode: null,
      attemptNumber: 1,
      trigger: 'INITIAL',
      thinking: false,
      provider: 'deepseek',
      model: 'deepseek-flash',
      ownerInstanceId: 'instance-1',
    });
    expect(generation.startedAt).not.toBeNull();
    expect(generation.finishedAt).not.toBeNull();

    const [user, assistant] = w.conversationsWorld.messages;
    expect([user.role, user.content]).toEqual(['USER', 'Hi there']);
    expect(assistant).toMatchObject({
      role: 'ASSISTANT',
      content: 'Hello world',
      reasoning: 'Thinking it through',
      parentId: user.id,
      generationId: result.generationId,
    });
    expect(generation.assistantMessageId).toBe(assistant.id);
    expect(w.conversationsWorld.conversations[0].activeLeafId).toBe(assistant.id);
  });

  it('keeps the output as numbered chunks, reasoning and text apart', async () => {
    w.provider.next(answer(['Hello', ' world'], { reasoning: ['Thinking ', 'hard'] }));

    const result = await submit();
    await finished(result.generationId);

    expect(chunkText(result.generationId, 'REASONING')).toBe('Thinking hard');
    expect(chunkText(result.generationId, 'TEXT')).toBe('Hello world');
    const detail = await w.service.get(ADA, result.generationId);
    expect(detail.lastSeq).toBe(w.generationWorld.chunks.length);
    expect(detail.partial).toBeNull(); // a finished answer is read from the conversation, not from chunks
  });

  it('sends the history, a token cap, no thinking and the user id to the provider', async () => {
    const result = await submit(ADA, 'What is 2 + 2?');
    await finished(result.generationId);

    const request = w.provider.answerRequests[0];
    expect(request).toMatchObject({ thinking: false, maxOutputTokens: 4096, userId: ADA });
    expect(request.messages.map((m) => `${m.role}:${m.content[0].text}`)).toEqual([
      expect.stringMatching(/^system:/),
      'user:What is 2 + 2?',
    ]);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks for thinking, with the larger token cap, when the user wants it', async () => {
    const result = await submit(ADA, 'Hard question', { thinking: true });
    await finished(result.generationId);

    expect(w.provider.answerRequests[0]).toMatchObject({ thinking: true, maxOutputTokens: 16384 });
    expect(row(result.generationId).thinking).toBe(true);
  });

  it('writes a long answer in several chunks with consecutive numbers', async () => {
    w = createGenerationWorld({ flushMaxChars: 10 });
    const pieces = Array.from({ length: 12 }, (_, i) => `piece-${i} `);
    w.provider.next(answer(pieces));

    const result = await submit();
    await finished(result.generationId);

    const seqs = w.generationWorld.chunks.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(chunkText(result.generationId, 'TEXT')).toBe(pieces.join(''));
  });

  it('gives the first answer of a conversation an automatic title, without the quotes', async () => {
    const result = await submit();
    await finished(result.generationId);

    await waitFor(() => w.conversationsWorld.conversations[0].title, 'the title');
    expect(w.conversationsWorld.conversations[0]).toMatchObject({ title: 'Greeting', titleSource: 'GENERATED' });
  });

  it('does not title a later exchange', async () => {
    const first = await submit();
    await finished(first.generationId);
    await waitFor(() => w.conversationsWorld.conversations[0].title, 'the title');
    const answerId = row(first.generationId).assistantMessageId!;
    w.provider.titleScript = answer(['Should not be used']);

    const second = await submit(ADA, 'Follow up', { conversationId: first.conversationId, parentId: answerId });
    await finished(second.generationId);
    await w.runner.beforeApplicationShutdown();

    expect(w.conversationsWorld.conversations[0].title).toBe('Greeting');
  });
});

describe('when something goes wrong', () => {
  it('keeps what arrived when the provider fails half way, and saves no answer', async () => {
    w.provider.next(failingAfter(['Partial ans'], 'PROVIDER_UNAVAILABLE'));

    const result = await submit();
    const generation = await finished(result.generationId);

    expect(generation).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE', assistantMessageId: null });
    expect(w.conversationsWorld.messages).toHaveLength(1); // only the user's message
    const detail = await w.service.get(ADA, result.generationId);
    expect(detail.partial).toEqual({ text: 'Partial ans', reasoning: '' });
  });

  it('fails with a stable code when the provider fails before any output', async () => {
    w.provider.next(failingAfter([], 'PROVIDER_AUTH'));

    const generation = await finished((await submit()).generationId);

    expect(generation).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_AUTH' });
  });

  it('treats an empty answer as a failure rather than saving a blank message', async () => {
    w.provider.next(answer([]));

    const generation = await finished((await submit()).generationId);

    expect(generation).toMatchObject({ status: 'FAILED', errorCode: 'EMPTY_ANSWER' });
    expect(w.conversationsWorld.messages).toHaveLength(1);
  });

  it('says so when the provider filtered the answer', async () => {
    w.provider.next(answer([], { finishReason: 'content_filter' }));

    expect(await finished((await submit()).generationId)).toMatchObject({ status: 'FAILED', errorCode: 'CONTENT_FILTERED' });
  });

  it('stops quietly, with no answer, if the conversation is deleted while it runs', async () => {
    const { script, release } = gated('A late answer');
    w.provider.next(script);
    const result = await submit();
    await waitFor(() => row(result.generationId).status === 'RUNNING', 'it to start');

    await w.conversations.remove(ADA, result.conversationId);
    release();
    const generation = await finished(result.generationId);

    expect(generation).toMatchObject({ status: 'CANCELLED', errorCode: 'CONVERSATION_DELETED' });
    expect(w.conversationsWorld.messages).toHaveLength(1);
  });

  it('fails with SAVE_FAILED, not a lost answer, when the conversation cannot take it', async () => {
    w.provider.next(answer(['An answer']));
    vi.spyOn(w.conversations, 'appendAssistantMessage').mockRejectedValue(new Error('database went away'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const generation = await finished((await submit()).generationId);

    expect(generation).toMatchObject({ status: 'FAILED', errorCode: 'SAVE_FAILED' });
  });

  it('still completes when the title cannot be generated, and leaves the default title', async () => {
    w.provider.titleScript = failingAfter([]);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const generation = await finished((await submit()).generationId);
    await w.runner.beforeApplicationShutdown();

    expect(generation.status).toBe('COMPLETED');
    expect(w.conversationsWorld.conversations[0].title).toBeNull();
  });

  it('never replaces a title the user typed, even if the generated one arrives later', async () => {
    const title = gated('Generated title');
    w.provider.titleScript = title.script;
    const result = await submit();
    await finished(result.generationId);

    await w.conversations.rename(ADA, result.conversationId, 'My own title');
    title.release();
    await w.runner.beforeApplicationShutdown();

    expect(w.conversationsWorld.conversations[0]).toMatchObject({ title: 'My own title', titleSource: 'MANUAL' });
  });

  it('writes no prompt, answer or reasoning to the logs, even when it fails', async () => {
    const logged: unknown[][] = [];
    for (const level of ['error', 'warn', 'log'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args));
    }
    w.provider.next(failingAfter(['secret answer text'], 'PROVIDER_UNAVAILABLE'));
    w.provider.next(answer(['another secret answer'], { reasoning: ['secret reasoning'] }));
    w.provider.titleScript = failingAfter([]);

    const failed = await submit(ADA, 'private prompt');
    await finished(failed.generationId);
    const retried = await w.service.retry(ADA, failed.generationId);
    await finished(retried.id);
    await w.runner.beforeApplicationShutdown();

    const everything = JSON.stringify(logged);
    for (const secret of ['private prompt', 'secret answer', 'secret reasoning']) expect(everything).not.toContain(secret);
  });
});

describe('stopping a generation', () => {
  it('stops it, keeps the partial output, saves no answer, and is safe to repeat', async () => {
    w.provider.next(hangingAfter(['Starting to answer']));
    const result = await submit();
    await running(result.generationId);

    const request = await w.service.cancel(ADA, result.generationId);
    const generation = await finished(result.generationId);
    const again = await w.service.cancel(ADA, result.generationId);

    expect(['RUNNING', 'CANCELLED']).toContain(request.status); // a request, not yet a confirmation
    expect(generation).toMatchObject({ status: 'CANCELLED', errorCode: null, assistantMessageId: null });
    expect(generation.cancelRequestedAt).not.toBeNull();
    expect(again.status).toBe('CANCELLED');
    expect(w.provider.answerRequests[0].signal?.aborted).toBe(true);
    expect(w.conversationsWorld.messages).toHaveLength(1);
    expect((await w.service.get(ADA, result.generationId)).partial?.text).toBe('Starting to answer');
  });

  it("does not let anyone else stop someone's generation", async () => {
    w.provider.next(hangingAfter(['x']));
    const result = await submit();
    await running(result.generationId);

    expect(await codeOf(w.service.cancel(BOB, result.generationId))).toBe('GENERATION_NOT_FOUND');
    expect(row(result.generationId).status).toBe('RUNNING');
  });

  it('lets a finished generation be "cancelled" without changing it', async () => {
    const result = await submit();
    await finished(result.generationId);

    expect((await w.service.cancel(ADA, result.generationId)).status).toBe('COMPLETED');
  });
});

describe('retrying', () => {
  it('starts a new attempt for the same message and keeps the failed one as history', async () => {
    w.provider.next(failingAfter(['part'])).next(answer(['Second try']));
    const first = await submit();
    await finished(first.generationId);

    const retried = await w.service.retry(ADA, first.generationId);
    const second = await finished(retried.id);

    expect(retried).toMatchObject({ attemptNumber: 2, trigger: 'RETRY', userMessageId: first.userMessageId });
    expect(second.status).toBe('COMPLETED');
    expect(row(first.generationId)).toMatchObject({ status: 'FAILED', attemptNumber: 1 });
    expect((await w.service.get(ADA, first.generationId)).partial?.text).toBe('part');
    const [user, assistant] = w.conversationsWorld.messages;
    expect(w.conversationsWorld.messages).toHaveLength(2);
    expect(assistant).toMatchObject({ content: 'Second try', parentId: user.id, generationId: retried.id });
  });

  it('keeps the thinking setting of the attempt it retries', async () => {
    w.provider.next(failingAfter([]));
    const first = await submit(ADA, 'Q', { thinking: true });
    await finished(first.generationId);

    await w.service.retry(ADA, first.generationId);

    await waitFor(() => w.provider.answerRequests.length === 2, 'the retry to start');
    expect(w.provider.answerRequests[1].thinking).toBe(true);
  });

  it('can retry a stopped generation', async () => {
    w.provider.next(hangingAfter(['x']));
    const first = await submit();
    await running(first.generationId);
    await w.service.cancel(ADA, first.generationId);
    await finished(first.generationId);

    const retried = await w.service.retry(ADA, first.generationId);

    expect((await finished(retried.id)).status).toBe('COMPLETED');
  });

  it.each([['a finished answer', answer(['ok'])]])('refuses to retry %s', async (_name, script) => {
    w.provider.next(script);
    const first = await submit();
    await finished(first.generationId);

    expect(await codeOf(w.service.retry(ADA, first.generationId))).toBe('GENERATION_NOT_RETRYABLE');
  });

  it('refuses to retry one that is still running', async () => {
    w.provider.next(hangingAfter(['x']));
    const first = await submit();
    await running(first.generationId);

    expect(await codeOf(w.service.retry(ADA, first.generationId))).toBe('GENERATION_NOT_RETRYABLE');
  });

  it('only retries the latest attempt', async () => {
    w.provider.next(failingAfter([])).next(failingAfter([]));
    const first = await submit();
    await finished(first.generationId);
    const second = await w.service.retry(ADA, first.generationId);
    await finished(second.id);

    expect(await codeOf(w.service.retry(ADA, first.generationId))).toBe('NOT_LATEST_ATTEMPT');
  });

  it("does not retry someone else's generation", async () => {
    w.provider.next(failingAfter([]));
    const first = await submit();
    await finished(first.generationId);

    expect(await codeOf(w.service.retry(BOB, first.generationId))).toBe('GENERATION_NOT_FOUND');
  });

  it('creates exactly one new attempt when two retries arrive together', async () => {
    w.provider.next(failingAfter([]));
    const first = await submit();
    await finished(first.generationId);

    const results = await Promise.allSettled([w.service.retry(ADA, first.generationId), w.service.retry(ADA, first.generationId)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(w.generationWorld.generations.filter((g) => g.userMessageId === first.userMessageId)).toHaveLength(2);
  });
});

describe('submitting safely (idempotency)', () => {
  it('gives the same result for the same key and body, without a second message or answer', async () => {
    const key = randomUUID();
    const first = await w.service.submit(ADA, key, { content: 'Hi there' });
    await finished(first.generationId);

    const again = await w.service.submit(ADA, key, { content: 'Hi there' });

    expect(again).toMatchObject({ generationId: first.generationId, conversationId: first.conversationId, userMessageId: first.userMessageId });
    expect(w.conversationsWorld.messages.filter((m) => m.role === 'USER')).toHaveLength(1);
    expect(w.provider.answerRequests).toHaveLength(1);
  });

  it('rejects the same key with a different request', async () => {
    const key = randomUUID();
    await w.service.submit(ADA, key, { content: 'Hi there' });

    expect(await codeOf(w.service.submit(ADA, key, { content: 'Something else' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await codeOf(w.service.submit(ADA, key, { content: 'Hi there', thinking: true }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keeps keys separate per user', async () => {
    const key = randomUUID();

    const ada = await w.service.submit(ADA, key, { content: 'Hi there' });
    const bob = await w.service.submit(BOB, key, { content: 'Hi there' });

    expect(ada.generationId).not.toBe(bob.generationId);
  });

  it('frees the key when nothing was saved, so the client can fix the request and resubmit', async () => {
    const key = randomUUID();

    expect(await codeOf(w.service.submit(ADA, key, { content: 'Hi', conversationId: randomUUID() }))).toBe('CONVERSATION_NOT_FOUND');
    const retry = await w.service.submit(ADA, key, { content: 'Hi' });

    expect(retry.generationId).toBeDefined();
  });

  it('does not run a duplicate when the same request arrives twice at once', async () => {
    const key = randomUUID();

    const results = await Promise.allSettled([
      w.service.submit(ADA, key, { content: 'Hi there' }),
      w.service.submit(ADA, key, { content: 'Hi there' }),
    ]);

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures.every((f) => (f.reason as { code: string }).code === 'REQUEST_IN_PROGRESS')).toBe(true);
    await waitFor(() => w.generationWorld.generations.length > 0, 'a generation');
    expect(w.generationWorld.generations).toHaveLength(1);
    expect(w.conversationsWorld.messages.filter((m) => m.role === 'USER')).toHaveLength(1);
  });

  it('finishes a submit that stopped half way, once its claim is stale, without a second message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00.000Z'));
    const key = randomUUID();
    w.generationWorld.failNextCreate = true;

    await expect(w.service.submit(ADA, key, { content: 'Hi there' })).rejects.toThrow('database went away');
    expect(w.conversationsWorld.messages).toHaveLength(1); // saved, but no generation yet
    expect(await codeOf(w.service.submit(ADA, key, { content: 'Hi there' }))).toBe('REQUEST_IN_PROGRESS');

    vi.setSystemTime(new Date('2026-11-09T10:00:31.000Z'));
    const result = await w.service.submit(ADA, key, { content: 'Hi there' });

    expect(w.conversationsWorld.messages.filter((m) => m.role === 'USER')).toHaveLength(1);
    expect(w.generationWorld.generations).toHaveLength(1);
    expect(result.generationId).toBe(w.generationWorld.generations[0].id);
    vi.useRealTimers();
    expect((await finished(result.generationId)).status).toBe('COMPLETED');
  });

  it('treats an expired key as free', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00.000Z'));
    const key = randomUUID();
    const first = await w.service.submit(ADA, key, { content: 'Hi there' });

    vi.setSystemTime(new Date('2026-11-10T10:00:01.000Z')); // a day later
    const second = await w.service.submit(ADA, key, { content: 'A different message' });

    expect(second.generationId).not.toBe(first.generationId);
  });
});

describe('limits', () => {
  it('allows two answers at a time and refuses a third, releasing its key', async () => {
    w.provider.next(hangingAfter()).next(hangingAfter());
    const one = await submit();
    await submit();
    const key = randomUUID();

    expect(await codeOf(w.service.submit(ADA, key, { content: 'Third' }))).toBe('TOO_MANY_ACTIVE_GENERATIONS');
    await w.service.cancel(ADA, one.generationId);
    await finished(one.generationId);
    const accepted = await w.service.submit(ADA, key, { content: 'Third' });

    expect(accepted.generationId).toBeDefined();
  });

  it('counts per user', async () => {
    w.provider.next(hangingAfter()).next(hangingAfter());
    await submit(ADA);
    await submit(ADA);

    expect((await submit(BOB)).generationId).toBeDefined();
  });
});

describe('looking at generations', () => {
  it("lists a conversation's attempts newest first, only for its owner", async () => {
    w.provider.next(failingAfter([]));
    const first = await submit();
    await finished(first.generationId);
    const retried = await w.service.retry(ADA, first.generationId);
    await finished(retried.id);

    const list = await w.service.list(ADA, first.conversationId, 5);

    expect(list.map((g) => g.attemptNumber)).toEqual([2, 1]);
    expect(await w.service.list(BOB, first.conversationId, 5)).toEqual([]);
  });

  it("does not show someone else's generation", async () => {
    const result = await submit();

    expect(await codeOf(w.service.get(BOB, result.generationId))).toBe('GENERATION_NOT_FOUND');
    expect(await codeOf(w.service.get(ADA, randomUUID()))).toBe('GENERATION_NOT_FOUND');
  });
});

describe('restart and shutdown', () => {
  it('marks generations left behind by a dead process INTERRUPTED, keeping their partial output', async () => {
    w.provider.next(hangingAfter(['half an answer']));
    const orphan = await submit();
    await running(orphan.generationId);
    const done = await submit();
    await finished(done.generationId);
    // A new process starts: the old one is gone, so what it owned is orphaned.
    const restarted = new GenerationService(w.repository, w.conversations, w.runner, w.feed, w.env, 'instance-2', {
      ...w.service['options'],
    });

    await restarted.onApplicationBootstrap();

    expect(row(orphan.generationId)).toMatchObject({ status: 'INTERRUPTED', errorCode: 'SERVER_RESTART' });
    expect(row(orphan.generationId).finishedAt).not.toBeNull();
    expect(row(done.generationId).status).toBe('COMPLETED'); // untouched
    expect((await w.service.get(ADA, orphan.generationId)).partial?.text).toBe('half an answer');
    expect(w.conversationsWorld.messages.filter((m) => m.role === 'ASSISTANT')).toHaveLength(1); // only the finished one
  });

  it('also settles a generation that never started', async () => {
    const created = await w.repository.create({
      userId: ADA,
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      attemptNumber: 1,
      trigger: 'INITIAL',
      thinking: false,
      provider: 'deepseek',
      model: 'deepseek-flash',
    });

    await w.service.onApplicationBootstrap();

    expect(row(created.id)).toMatchObject({ status: 'INTERRUPTED', errorCode: 'SERVER_RESTART' });
  });

  it('lets the user retry after a restart', async () => {
    w.provider.next(hangingAfter(['x']));
    const orphan = await submit();
    await running(orphan.generationId);
    await new GenerationService(w.repository, w.conversations, w.runner, w.feed, w.env, 'instance-2', w.service['options']).onApplicationBootstrap();
    // The old process's run ends on its own once it notices; here it is told to stop.
    w.runner.abort(orphan.generationId);
    await waitFor(() => !w.runner.isRunning(orphan.generationId), 'the old run to end');

    const retried = await w.service.retry(ADA, orphan.generationId);

    expect((await finished(retried.id)).status).toBe('COMPLETED');
    expect(row(orphan.generationId).status).toBe('INTERRUPTED'); // the old run could not overwrite it
  });

  it('marks running generations INTERRUPTED, with their partial output, on shutdown', async () => {
    w.provider.next(hangingAfter(['partial']));
    const result = await submit();
    await running(result.generationId);

    await w.runner.beforeApplicationShutdown();

    expect(row(result.generationId)).toMatchObject({ status: 'INTERRUPTED', errorCode: 'SERVER_SHUTDOWN' });
    expect((await w.service.get(ADA, result.generationId)).partial?.text).toBe('partial');
  });

  it('keeps a heartbeat while it runs, so a stuck process can be told from a live one', async () => {
    w.provider.next(hangingAfter(['x']));
    const result = await submit();
    await running(result.generationId);
    const started = row(result.generationId).heartbeatAt!.getTime();

    await waitFor(() => row(result.generationId).heartbeatAt!.getTime() > started, 'a newer heartbeat');
  });
});

describe('streaming events', () => {
  const collect = async (stream: AsyncIterable<StreamItem>) => {
    const items: StreamItem[] = [];
    for await (const item of stream) items.push(item);
    return items;
  };
  const chunks = (items: StreamItem[]) => items.filter((i): i is Extract<StreamItem, { type: 'chunk' }> => i.type === 'chunk');

  it('replays a finished generation and ends with its final status', async () => {
    w.provider.next(answer(['Hello', ' world'], { reasoning: ['Thinking'] }));
    const result = await submit();
    await finished(result.generationId);

    const items = await collect(await w.service.openStream(ADA, result.generationId, 0));

    expect(chunks(items).map((c) => [c.kind, c.text]).flat().join('|')).toContain('Hello world');
    expect(items.at(-1)).toMatchObject({ type: 'status', status: 'COMPLETED', assistantMessageId: row(result.generationId).assistantMessageId });
    expect(chunks(items).map((c) => c.seq)).toEqual(chunks(items).map((_, i) => i + 1));
  });

  it('resumes after the last chunk the browser saw, without repeating any', async () => {
    w = createGenerationWorld({ flushMaxChars: 8 });
    w.provider.next(answer(Array.from({ length: 10 }, (_, i) => `part${i} `)));
    const result = await submit();
    await finished(result.generationId);
    const all = chunks(await collect(await w.service.openStream(ADA, result.generationId, 0)));
    const seen = all[2].seq;

    const resumed = chunks(await collect(await w.service.openStream(ADA, result.generationId, seen)));

    expect(resumed.map((c) => c.seq)).toEqual(all.filter((c) => c.seq > seen).map((c) => c.seq));
    expect(resumed.length).toBeGreaterThan(0);
  });

  it('follows a live generation to the end, in order, with nothing repeated or missing', async () => {
    const slow: Script = async function* () {
      for (const text of ['one ', 'two ', 'three ', 'four']) {
        yield { type: 'text', text };
        await sleep(15);
      }
      yield { type: 'done', finishReason: 'stop', usage: USAGE, model: 'deepseek-flash' };
    };
    w.provider.next(slow);
    const result = await submit();

    const items = await collect(await w.service.openStream(ADA, result.generationId, 0));

    expect(chunks(items).map((c) => c.text).join('')).toBe('one two three four');
    const seqs = chunks(items).map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(items.at(-1)).toMatchObject({ type: 'status', status: 'COMPLETED' });
  });

  it('does not stop the generation when the browser disconnects', async () => {
    const { script, release } = gated('Finished anyway');
    w.provider.next(script);
    const result = await submit();
    const controller = new AbortController();
    const stream = await w.service.openStream(ADA, result.generationId, 0, controller.signal);
    const reading = collect(stream);

    await waitFor(() => row(result.generationId).status === 'RUNNING', 'it to start');
    controller.abort(); // the tab is closed
    await reading;
    release();

    expect((await finished(result.generationId)).status).toBe('COMPLETED');
    expect(w.conversationsWorld.messages.at(-1)?.content).toBe('Finished anyway');
  });

  it('sends keep-alives while it waits', async () => {
    w.provider.next(hangingAfter());
    const result = await submit();
    const controller = new AbortController();
    const items: StreamItem[] = [];

    const reading = (async () => {
      for await (const item of await w.service.openStream(ADA, result.generationId, 0, controller.signal)) {
        items.push(item);
        if (item.type === 'keepalive') controller.abort();
      }
    })();
    await reading;

    expect(items.some((i) => i.type === 'keepalive')).toBe(true);
  });

  it('ends instead of hanging when a generation is active but nothing is running it', async () => {
    const orphan = await w.repository.create({
      userId: ADA,
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      attemptNumber: 1,
      trigger: 'INITIAL',
      thinking: false,
      provider: 'deepseek',
      model: 'deepseek-flash',
    });

    const items = await collect(await w.service.openStream(ADA, orphan.id, 0));

    expect(items[0]).toMatchObject({ type: 'status', status: 'PENDING' });
  });

  it("is not available to another user, and is checked before anything is sent", async () => {
    const result = await submit();

    expect(await codeOf(w.service.openStream(BOB, result.generationId, 0))).toBe('GENERATION_NOT_FOUND');
  });
});
