import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { ConversationsModule } from '../../src/modules/conversations/index.js';
import { ConversationsRepository } from '../../src/modules/conversations/conversations.repository.js';
import { GenerationModule } from '../../src/modules/generation/index.js';
import { RUNNER_OPTIONS } from '../../src/modules/generation/generation.constants.js';
import { GenerationRepository } from '../../src/modules/generation/generation.repository.js';
import { AiProvider } from '../../src/modules/generation/providers/ai-provider.port.js';
import { AuthEventsRepository } from '../../src/modules/identity/auth-events.repository.js';
import { Clock } from '../../src/modules/identity/clock.js';
import { IdentityModule, JwtAuthGuard } from '../../src/modules/identity/index.js';
import { SessionsRepository } from '../../src/modules/identity/sessions.repository.js';
import { UserTokensRepository } from '../../src/modules/identity/user-tokens.repository.js';
import { UserRepository } from '../../src/modules/identity/users.repository.js';
import { NotificationsFacade } from '../../src/modules/notifications/index.js';
import { AppConfigModule } from '../../src/shared/config/config.module.js';
import { APP_ENV } from '../../src/shared/config/env.js';
import { PrismaService } from '../../src/shared/database/prisma.service.js';
import { UnitOfWork } from '../../src/shared/database/unit-of-work.js';
import { AllExceptionsFilter } from '../../src/shared/http/all-exceptions.filter.js';
import { CsrfOriginGuard } from '../../src/shared/http/csrf-origin.guard.js';
import { FakeAiProvider, USAGE, answer, failingAfter, hangingAfter, type Script } from '../helpers/fake-ai-provider.js';
import { FAST_OPTIONS, generationEnv, waitFor } from '../helpers/generation-world.js';
import { InMemoryConversations } from '../helpers/in-memory-conversations.js';
import { InMemoryGeneration } from '../helpers/in-memory-generation.js';
import { InMemoryIdentity } from '../helpers/in-memory-identity.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const MISSING_ID = '0190aaaa-0000-7000-8000-00000000ffff';
const env = generationEnv({ WEB_URL: ORIGIN });

async function createApp() {
  const identity = new InMemoryIdentity();
  const conversations = new InMemoryConversations();
  const generations = new InMemoryGeneration();
  const provider = new FakeAiProvider();

  // Stands in for DatabaseModule: no Postgres needed.
  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: {} },
      { provide: UnitOfWork, useValue: conversations.unitOfWork },
    ],
    exports: [PrismaService, UnitOfWork],
  })
  class StubDatabaseModule {}

  // Same global wiring as AppModule.
  @Module({
    imports: [
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
      AppConfigModule,
      StubDatabaseModule,
      IdentityModule,
      ConversationsModule,
      GenerationModule,
    ],
    providers: [
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: CsrfOriginGuard },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
  })
  class TestAppModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] })
    .overrideProvider(APP_ENV)
    .useValue(env)
    .overrideProvider(Clock)
    .useValue(identity.clock)
    .overrideProvider(UserRepository)
    .useValue(identity.userRepository)
    .overrideProvider(SessionsRepository)
    .useValue(identity.sessionsRepository)
    .overrideProvider(UserTokensRepository)
    .useValue(identity.userTokensRepository)
    .overrideProvider(AuthEventsRepository)
    .useValue(identity.authEventsRepository)
    .overrideProvider(NotificationsFacade)
    .useValue(identity.notifications)
    .overrideProvider(ConversationsRepository)
    .useValue(conversations.repository)
    .overrideProvider(GenerationRepository)
    .useValue(generations.repository)
    .overrideProvider(AiProvider)
    .useValue(provider)
    .overrideProvider(RUNNER_OPTIONS)
    .useValue(FAST_OPTIONS)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();
  return { app, identity, conversations, generations, provider };
}

const cookiesOf = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
const asCookieHeader = (res: request.Response) => cookiesOf(res).map((c) => c.split(';')[0]).join('; ');

interface SseEvent {
  id?: string;
  event: string;
  data: Record<string, unknown>;
}

/** Splits a text/event-stream body into events, ignoring `:` comment lines. */
function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':'))
    .map((block) => {
      const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]));
      return { id: fields.id, event: fields.event, data: JSON.parse(fields.data) as Record<string, unknown> };
    });
}

const textOf = (events: SseEvent[]) =>
  events
    .filter((e) => e.event === 'text')
    .map((e) => e.data.text)
    .join('');

describe('Generation (e2e)', () => {
  let app: INestApplication;
  let identity: InMemoryIdentity;
  let conversations: InMemoryConversations;
  let generations: InMemoryGeneration;
  let provider: FakeAiProvider;

  // New app per test: fresh data and rate-limit counters.
  beforeEach(async () => {
    ({ app, identity, conversations, generations, provider } = await createApp());
  });
  afterEach(() => app.close());

  const server = () => app.getHttpServer();

  async function signIn(email: string) {
    const post = (path: string, body: object) => request(server()).post(path).set('Origin', ORIGIN).send(body);
    await post('/auth/register', { email, password: PASSWORD, name: 'Test' }).expect(202);
    await post('/auth/verify-email', {
      token: InMemoryIdentity.tokenFromLink(identity.lastEmail('VERIFY_EMAIL').params.verifyUrl),
    }).expect(204);
    const res = await post('/auth/login', { email, password: PASSWORD }).expect(200);
    return { cookie: asCookieHeader(res) };
  }

  const call = (method: 'get' | 'post', path: string, cookie?: string) => {
    const req = request(server())[method](path);
    if (method === 'post') req.set('Origin', ORIGIN);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  const submit = (cookie: string, body: object = { content: 'Hello there' }, key: string | null = randomUUID()) => {
    const req = call('post', '/generations', cookie).send(body);
    return key === null ? req : req.set('Idempotency-Key', key);
  };

  const statusOf = async (cookie: string, id: string) => (await call('get', `/generations/${id}`, cookie)).body.status as string;
  const finished = (cookie: string, id: string) =>
    waitFor(async () => {
      const status = await statusOf(cookie, id);
      return ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(status) ? status : undefined;
    }, 'the generation to finish');

  describe('authentication', () => {
    it.each([
      ['POST /generations', () => call('post', '/generations').set('Idempotency-Key', 'k').send({ content: 'x' })],
      ['GET /generations', () => call('get', `/generations?conversationId=${MISSING_ID}`)],
      ['GET /generations/:id', () => call('get', `/generations/${MISSING_ID}`)],
      ['GET /generations/:id/stream', () => call('get', `/generations/${MISSING_ID}/stream`)],
      ['POST /generations/:id/cancel', () => call('post', `/generations/${MISSING_ID}/cancel`)],
      ['POST /generations/:id/retry', () => call('post', `/generations/${MISSING_ID}/retry`)],
    ])('%s needs a signed-in user', async (_name, send) => {
      const res = await send().expect(401);

      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('sending a message', () => {
    it('accepts it, starts the answer, and returns the ids at once', async () => {
      const ada = await signIn('ada@example.com');

      const res = await submit(ada.cookie).expect(202);

      expect(res.body).toMatchObject({ status: 'PENDING' });
      expect(res.body.generationId).toBeDefined();
      expect(res.body.conversationId).toBeDefined();
      expect(await finished(ada.cookie, res.body.generationId)).toBe('COMPLETED');
      expect(conversations.messages.map((m) => m.content)).toEqual(['Hello there', 'Hello there']);
    });

    it('continues an existing conversation', async () => {
      const ada = await signIn('ada@example.com');
      const first = (await submit(ada.cookie)).body;
      await finished(ada.cookie, first.generationId);
      const answerId = generations.generations[0].assistantMessageId;

      const second = await submit(ada.cookie, { content: 'And then?', conversationId: first.conversationId, parentId: answerId }).expect(202);

      expect(second.body.conversationId).toBe(first.conversationId);
      expect(await finished(ada.cookie, second.body.generationId)).toBe('COMPLETED');
      expect(conversations.messages).toHaveLength(4);
    });

    it('requires an Idempotency-Key', async () => {
      const ada = await signIn('ada@example.com');

      const res = await submit(ada.cookie, { content: 'Hi' }, null).expect(400);

      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(conversations.messages).toHaveLength(0);
    });

    it.each([[''], ['has spaces'], ['x'.repeat(129)], ['semi;colon']])('rejects the Idempotency-Key %j', async (key) => {
      const ada = await signIn('ada@example.com');

      await submit(ada.cookie, { content: 'Hi' }, key).expect(400);
    });

    it.each([
      ['an empty message', { content: '' }],
      ['a message that is too long', { content: 'x'.repeat(32_001) }],
      ['a missing message', {}],
      ['a non-boolean thinking flag', { content: 'Hi', thinking: 'yes' }],
      ['a conversation id that is not a uuid', { content: 'Hi', conversationId: 'nope' }],
      ['an unknown field', { content: 'Hi', model: 'deepseek-v4-pro' }],
    ])('rejects %s with 400', async (_name, body) => {
      const ada = await signIn('ada@example.com');

      await submit(ada.cookie, body).expect(400);

      expect(conversations.messages).toHaveLength(0);
    });

    it('rejects a message that is only whitespace, without starting a conversation', async () => {
      const ada = await signIn('ada@example.com');

      const res = await submit(ada.cookie, { content: '   ' }).expect(422);

      expect(res.body.error.code).toBe('INVALID_MESSAGE');
      expect(conversations.conversations).toHaveLength(0);
    });

    it('answers a repeated request with the same result and does not start a second answer', async () => {
      const ada = await signIn('ada@example.com');
      const key = randomUUID();
      const first = (await submit(ada.cookie, { content: 'Hi' }, key).expect(202)).body;
      await finished(ada.cookie, first.generationId);

      const again = await submit(ada.cookie, { content: 'Hi' }, key).expect(202);

      expect(again.body.generationId).toBe(first.generationId);
      expect(provider.answerRequests).toHaveLength(1);
    });

    it('rejects the same key with a different message', async () => {
      const ada = await signIn('ada@example.com');
      const key = randomUUID();
      await submit(ada.cookie, { content: 'Hi' }, key).expect(202);

      const res = await submit(ada.cookie, { content: 'Something else' }, key).expect(409);

      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it("cannot add to someone else's conversation", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const adas = (await submit(ada.cookie)).body;

      const res = await submit(bob.cookie, { content: 'Hi', conversationId: adas.conversationId }).expect(404);

      expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('refuses a third answer while two are running', async () => {
      const ada = await signIn('ada@example.com');
      provider.next(hangingAfter()).next(hangingAfter());
      await submit(ada.cookie).expect(202);
      await submit(ada.cookie).expect(202);

      const res = await submit(ada.cookie).expect(429);

      expect(res.body.error.code).toBe('TOO_MANY_ACTIVE_GENERATIONS');
    });
  });

  describe('reading the stream', () => {
    it('sends saved and live output as events, ending with the final status', async () => {
      const ada = await signIn('ada@example.com');
      provider.next(answer(['Hello', ' world'], { reasoning: ['Thinking'] }));
      const { generationId } = (await submit(ada.cookie)).body;

      const res = await call('get', `/generations/${generationId}/stream`, ada.cookie).expect(200);
      const events = parseSse(res.text);

      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.headers['cache-control']).toMatch(/no-cache/);
      expect(events.filter((e) => e.event === 'reasoning').map((e) => e.data.text).join('')).toBe('Thinking');
      expect(textOf(events)).toBe('Hello world');
      expect(events.at(-1)).toMatchObject({ event: 'status', data: { status: 'COMPLETED' } });
      expect(events.at(-1)?.data.assistantMessageId).toBe(generations.generations[0].assistantMessageId);
      const ids = events.filter((e) => e.id).map((e) => Number(e.id));
      expect(ids).toEqual(ids.map((_, i) => i + 1));
    });

    it('follows a slow answer live', async () => {
      const ada = await signIn('ada@example.com');
      const slow: Script = async function* () {
        for (const text of ['one ', 'two ', 'three']) {
          yield { type: 'text', text };
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        yield { type: 'done', finishReason: 'stop', usage: USAGE, model: 'deepseek-flash' };
      };
      provider.next(slow);
      const { generationId } = (await submit(ada.cookie)).body;

      const events = parseSse((await call('get', `/generations/${generationId}/stream`, ada.cookie).expect(200)).text);

      expect(textOf(events)).toBe('one two three');
      expect(events.at(-1)?.data.status).toBe('COMPLETED');
    });

    it('resumes after the Last-Event-ID the browser sends, without repeating', async () => {
      const ada = await signIn('ada@example.com');
      provider.next(answer(['a', 'b']));
      const { generationId } = (await submit(ada.cookie)).body;
      await finished(ada.cookie, generationId);
      const all = parseSse((await call('get', `/generations/${generationId}/stream`, ada.cookie)).text);
      const firstChunk = all.find((e) => e.id)!;

      const resumed = parseSse(
        (await call('get', `/generations/${generationId}/stream`, ada.cookie).set('Last-Event-ID', firstChunk.id!).expect(200)).text,
      );

      expect(resumed.filter((e) => e.id).map((e) => e.id)).toEqual(all.filter((e) => e.id && Number(e.id) > Number(firstChunk.id)).map((e) => e.id));
    });

    it.each([['abc'], ['-5'], ['1.5']])('treats the bad Last-Event-ID %j as "from the start"', async (value) => {
      const ada = await signIn('ada@example.com');
      const { generationId } = (await submit(ada.cookie)).body;
      await finished(ada.cookie, generationId);

      const res = await call('get', `/generations/${generationId}/stream`, ada.cookie).set('Last-Event-ID', value).expect(200);

      expect(textOf(parseSse(res.text))).toBe('Hello there');
    });

    it("answers 404 as plain JSON, not a stream, for someone else's generation", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const { generationId } = (await submit(ada.cookie)).body;

      const res = await call('get', `/generations/${generationId}/stream`, bob.cookie).expect(404);

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error.code).toBe('GENERATION_NOT_FOUND');
    });

    it('keeps generating when the browser disconnects, and the answer is there after a reconnect', async () => {
      const ada = await signIn('ada@example.com');
      await app.listen(0);
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const slow: Script = async function* () {
        yield { type: 'text', text: 'first part ' };
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield { type: 'text', text: 'second part' };
        yield { type: 'done', finishReason: 'stop', usage: USAGE, model: 'deepseek-flash' };
      };
      provider.next(slow);
      const { generationId } = (await submit(ada.cookie)).body;

      // Read until the first text arrives, then drop the connection.
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ port, path: `/generations/${generationId}/stream`, headers: { Cookie: ada.cookie } }, (res) => {
          res.on('data', (data: Buffer) => {
            if (data.toString().includes('first part')) {
              req.destroy();
              resolve();
            }
          });
        });
        req.on('error', (error) => ((error as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve() : reject(error)));
      });

      expect(await finished(ada.cookie, generationId)).toBe('COMPLETED');
      const replay = parseSse((await call('get', `/generations/${generationId}/stream`, ada.cookie)).text);
      expect(textOf(replay)).toBe('first part second part');
    });
  });

  describe('status and recovery', () => {
    it('shows the status of a finished generation without partial output', async () => {
      const ada = await signIn('ada@example.com');
      const { generationId } = (await submit(ada.cookie)).body;
      await finished(ada.cookie, generationId);

      const res = await call('get', `/generations/${generationId}`, ada.cookie).expect(200);

      expect(res.body).toMatchObject({ id: generationId, status: 'COMPLETED', attemptNumber: 1, trigger: 'INITIAL', partial: null });
      expect(res.body.lastSeq).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toMatch(/ownerInstanceId|heartbeat|userId/);
    });

    it('shows partial output, clearly as a failure, when the provider failed', async () => {
      const ada = await signIn('ada@example.com');
      provider.next(failingAfter(['Half an ans'], 'PROVIDER_TIMEOUT'));
      const { generationId } = (await submit(ada.cookie)).body;
      await finished(ada.cookie, generationId);

      const res = await call('get', `/generations/${generationId}`, ada.cookie).expect(200);

      expect(res.body).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT', assistantMessageId: null });
      expect(res.body.partial).toEqual({ text: 'Half an ans', reasoning: '' });
    });

    it("finds the latest attempt of a conversation after a refresh, and only the owner's", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const { generationId, conversationId } = (await submit(ada.cookie)).body;

      const mine = await call('get', `/generations?conversationId=${conversationId}`, ada.cookie).expect(200);
      const theirs = await call('get', `/generations?conversationId=${conversationId}`, bob.cookie).expect(200);

      expect(mine.body.map((g: { id: string }) => g.id)).toEqual([generationId]);
      expect(theirs.body).toEqual([]);
    });

    it.each([[''], ['?conversationId=nope'], [`?conversationId=${MISSING_ID}&limit=0`], [`?conversationId=${MISSING_ID}&limit=21`]])(
      'rejects the list query %j',
      async (query) => {
        const ada = await signIn('ada@example.com');

        await call('get', `/generations${query}`, ada.cookie).expect(400);
      },
    );

    it("does not show someone else's generation, or a missing one", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const { generationId } = (await submit(ada.cookie)).body;

      const intruder = await call('get', `/generations/${generationId}`, bob.cookie).expect(404);
      const missing = await call('get', `/generations/${MISSING_ID}`, bob.cookie).expect(404);

      expect(intruder.body).toEqual(missing.body);
      await call('get', '/generations/not-a-uuid', bob.cookie).expect(400);
    });
  });

  describe('stopping and retrying', () => {
    it('stops a running answer and keeps the partial output', async () => {
      const ada = await signIn('ada@example.com');
      provider.next(hangingAfter(['Working on it']));
      const { generationId } = (await submit(ada.cookie)).body;
      await waitFor(() => generations.chunks.length > 0, 'some output');

      const res = await call('post', `/generations/${generationId}/cancel`, ada.cookie).expect(202);

      expect(['RUNNING', 'CANCELLED']).toContain(res.body.status);
      expect(await finished(ada.cookie, generationId)).toBe('CANCELLED');
      expect((await call('get', `/generations/${generationId}`, ada.cookie)).body.partial.text).toBe('Working on it');
      await call('post', `/generations/${generationId}/cancel`, ada.cookie).expect(202);
    });

    it("does not let someone else stop it", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      provider.next(hangingAfter(['x']));
      const { generationId } = (await submit(ada.cookie)).body;
      await waitFor(() => generations.chunks.length > 0, 'some output');

      await call('post', `/generations/${generationId}/cancel`, bob.cookie).expect(404);

      expect(await statusOf(ada.cookie, generationId)).toBe('RUNNING');
    });

    it('retries a failed answer as a new attempt that can be told apart', async () => {
      const ada = await signIn('ada@example.com');
      provider.next(failingAfter([]));
      const first = (await submit(ada.cookie)).body;
      await finished(ada.cookie, first.generationId);

      const retry = await call('post', `/generations/${first.generationId}/retry`, ada.cookie).expect(202);

      expect(retry.body).toMatchObject({ attemptNumber: 2, trigger: 'RETRY', userMessageId: first.userMessageId });
      expect(await finished(ada.cookie, retry.body.id)).toBe('COMPLETED');
      const attempts = await call('get', `/generations?conversationId=${first.conversationId}`, ada.cookie);
      expect(attempts.body.map((g: { attemptNumber: number; status: string }) => [g.attemptNumber, g.status])).toEqual([
        [2, 'COMPLETED'],
        [1, 'FAILED'],
      ]);
    });

    it('refuses to retry a finished answer, and anyone else', async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const { generationId } = (await submit(ada.cookie)).body;
      await finished(ada.cookie, generationId);

      const finishedAnswer = await call('post', `/generations/${generationId}/retry`, ada.cookie).expect(409);
      await call('post', `/generations/${generationId}/retry`, bob.cookie).expect(404);

      expect(finishedAnswer.body.error.code).toBe('GENERATION_NOT_RETRYABLE');
    });

    it('blocks a cross-site request, so another website cannot start or stop answers', async () => {
      const ada = await signIn('ada@example.com');

      await request(server())
        .post('/generations')
        .set('Origin', 'https://evil.example')
        .set('Cookie', ada.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ content: 'Hi' })
        .expect(403);

      expect(conversations.messages).toHaveLength(0);
    });
  });
});
