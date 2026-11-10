import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { ConversationsFacade, ConversationsModule } from '../../src/modules/conversations/index.js';
import { ConversationsRepository } from '../../src/modules/conversations/conversations.repository.js';
import { AuthEventsRepository } from '../../src/modules/identity/auth-events.repository.js';
import { Clock } from '../../src/modules/identity/clock.js';
import { IdentityModule, JwtAuthGuard } from '../../src/modules/identity/index.js';
import { SessionsRepository } from '../../src/modules/identity/sessions.repository.js';
import { UserTokensRepository } from '../../src/modules/identity/user-tokens.repository.js';
import { UserRepository } from '../../src/modules/identity/users.repository.js';
import { NotificationsFacade } from '../../src/modules/notifications/index.js';
import { AppConfigModule } from '../../src/shared/config/config.module.js';
import { APP_ENV, loadEnv } from '../../src/shared/config/env.js';
import { PrismaService } from '../../src/shared/database/prisma.service.js';
import { UnitOfWork } from '../../src/shared/database/unit-of-work.js';
import { AllExceptionsFilter } from '../../src/shared/http/all-exceptions.filter.js';
import { CsrfOriginGuard } from '../../src/shared/http/csrf-origin.guard.js';
import { InMemoryConversations } from '../helpers/in-memory-conversations.js';
import { InMemoryIdentity } from '../helpers/in-memory-identity.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const GENERATION = '0190aaaa-0000-7000-8000-0000000000aa';
const MISSING_ID = '0190aaaa-0000-7000-8000-00000000ffff';
const env = loadEnv({
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'd',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
  DEEPSEEK_API_KEY: 'sk-test',
  WEB_URL: ORIGIN,
});

async function createApp() {
  const identity = new InMemoryIdentity();
  const conversations = new InMemoryConversations();

  // Stands in for DatabaseModule: no Postgres needed. Both modules share one fake unit of work.
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
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();
  return { app, identity, conversations };
}

const cookiesOf = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
const asCookieHeader = (res: request.Response) => cookiesOf(res).map((c) => c.split(';')[0]).join('; ');

describe('Conversations (e2e)', () => {
  let app: INestApplication;
  let identity: InMemoryIdentity;
  let facade: ConversationsFacade;

  // New app per test: fresh data and rate-limit counters.
  beforeEach(async () => {
    ({ app, identity } = await createApp());
    facade = app.get(ConversationsFacade);
  });
  afterEach(() => app.close());

  const server = () => app.getHttpServer();
  const post = (path: string, body?: object) => request(server()).post(path).set('Origin', ORIGIN).send(body);

  async function signIn(email: string) {
    await post('/auth/register', { email, password: PASSWORD, name: 'Test' }).expect(202);
    const link = identity.lastEmail('VERIFY_EMAIL').params.verifyUrl;
    await post('/auth/verify-email', { token: InMemoryIdentity.tokenFromLink(link) }).expect(204);
    const res = await post('/auth/login', { email, password: PASSWORD }).expect(200);
    return { id: res.body.user.id as string, cookie: asCookieHeader(res) };
  }

  const get = (path: string, cookie?: string) => {
    const req = request(server()).get(path);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const patch = (path: string, body: object, cookie?: string) => {
    const req = request(server()).patch(path).set('Origin', ORIGIN).send(body);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const del = (path: string, cookie?: string) => {
    const req = request(server()).delete(path).set('Origin', ORIGIN);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  /** Creates a conversation with one answered exchange for the user. */
  async function seed(ownerId: string, text = 'Hello') {
    const user = await facade.appendUserMessage(ownerId, { content: text });
    await facade.appendAssistantMessage(ownerId, {
      conversationId: user.conversationId,
      parentId: user.message.id,
      content: `Answer to ${text}`,
      reasoning: 'Thinking it through.',
      generationId: GENERATION,
    });
    return user.conversationId;
  }

  describe('authentication', () => {
    it.each([
      ['GET /conversations', () => get('/conversations')],
      ['GET /conversations/:id', () => get(`/conversations/${MISSING_ID}`)],
      ['PATCH /conversations/:id', () => patch(`/conversations/${MISSING_ID}`, { title: 'x' })],
      ['DELETE /conversations/:id', () => del(`/conversations/${MISSING_ID}`)],
    ])('%s needs a signed-in user', async (_name, call) => {
      const res = await call().expect(401);

      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('listing', () => {
    it('lists only your conversations, with no message content', async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const adas = await seed(ada.id, 'Ada question');
      await seed(bob.id, 'Bob question');

      const res = await get('/conversations', ada.cookie).expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ id: adas, title: null });
      expect(res.body.nextCursor).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('Ada question');
    });

    it('pages with an opaque cursor', async () => {
      const ada = await signIn('ada@example.com');
      for (const text of ['one', 'two', 'three']) await seed(ada.id, text);

      const first = await get('/conversations?limit=2', ada.cookie).expect(200);
      const second = await get(`/conversations?limit=2&cursor=${first.body.nextCursor}`, ada.cookie).expect(200);

      expect(first.body.items).toHaveLength(2);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
      const ids = [...first.body.items, ...second.body.items].map((c: { id: string }) => c.id);
      expect(new Set(ids).size).toBe(3);
    });

    it.each([['limit=0'], ['limit=101'], ['limit=abc'], ['cursor=nonsense']])('rejects ?%s with 400', async (query) => {
      const ada = await signIn('ada@example.com');

      await get(`/conversations?${query}`, ada.cookie).expect(400);
    });
  });

  describe('reading one conversation', () => {
    it('returns the active branch with reasoning', async () => {
      const ada = await signIn('ada@example.com');
      const id = await seed(ada.id, 'Hi there');

      const res = await get(`/conversations/${id}`, ada.cookie).expect(200);

      expect(res.body).toMatchObject({ id, titleSource: 'DEFAULT', nextBefore: null });
      expect(res.body.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
        ['USER', 'Hi there'],
        ['ASSISTANT', 'Answer to Hi there'],
      ]);
      expect(res.body.messages[1].reasoning).toBe('Thinking it through.');
    });

    it("answers 404, exactly like a missing conversation, for someone else's", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const adas = await seed(ada.id);

      const intruder = await get(`/conversations/${adas}`, bob.cookie).expect(404);
      const missing = await get(`/conversations/${MISSING_ID}`, bob.cookie).expect(404);

      expect(intruder.body.error.code).toBe('CONVERSATION_NOT_FOUND');
      expect(intruder.body).toEqual(missing.body);
    });

    it('rejects an id that is not a uuid', async () => {
      const ada = await signIn('ada@example.com');

      await get('/conversations/not-a-uuid', ada.cookie).expect(400);
    });
  });

  describe('renaming', () => {
    it('renames and shows the new title in the list', async () => {
      const ada = await signIn('ada@example.com');
      const id = await seed(ada.id);

      const res = await patch(`/conversations/${id}`, { title: '  Trip plan  ' }, ada.cookie).expect(200);

      expect(res.body).toMatchObject({ id, title: 'Trip plan' });
      expect((await get('/conversations', ada.cookie)).body.items[0].title).toBe('Trip plan');
    });

    it('keeps a typed title even if a generated one arrives later', async () => {
      const ada = await signIn('ada@example.com');
      const id = await seed(ada.id);
      await patch(`/conversations/${id}`, { title: 'Mine' }, ada.cookie).expect(200);

      expect(await facade.applyGeneratedTitle(id, 'Generated')).toBe(false);
      expect((await get(`/conversations/${id}`, ada.cookie)).body.title).toBe('Mine');
    });

    it.each([
      ['an empty title', { title: '' }],
      ['a blank title', { title: '   ' }],
      ['a title that is too long', { title: 'x'.repeat(121) }],
      ['a non-string title', { title: 42 }],
      ['an unknown field', { title: 'ok', ownerId: 'someone-else' }],
    ])('rejects %s with 400', async (_name, body) => {
      const ada = await signIn('ada@example.com');
      const id = await seed(ada.id);

      await patch(`/conversations/${id}`, body, ada.cookie).expect(400);
    });

    it("cannot rename someone else's conversation", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const adas = await seed(ada.id);

      await patch(`/conversations/${adas}`, { title: 'Hacked' }, bob.cookie).expect(404);

      expect((await get(`/conversations/${adas}`, ada.cookie)).body.title).toBeNull();
    });
  });

  describe('deleting', () => {
    it('removes the conversation from the list and from reading', async () => {
      const ada = await signIn('ada@example.com');
      const id = await seed(ada.id);

      await del(`/conversations/${id}`, ada.cookie).expect(204);

      expect((await get('/conversations', ada.cookie)).body.items).toHaveLength(0);
      await get(`/conversations/${id}`, ada.cookie).expect(404);
      await del(`/conversations/${id}`, ada.cookie).expect(404);
    });

    it("cannot delete someone else's conversation", async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      const adas = await seed(ada.id);

      await del(`/conversations/${adas}`, bob.cookie).expect(404);

      await get(`/conversations/${adas}`, ada.cookie).expect(200);
    });

    it('is blocked cross-site: a state-changing request from another origin is rejected', async () => {
      const ada = await signIn('ada@example.com');
      const id = await seed(ada.id);

      await request(server()).delete(`/conversations/${id}`).set('Origin', 'https://evil.example').set('Cookie', ada.cookie).expect(403);

      await get(`/conversations/${id}`, ada.cookie).expect(200);
    });
  });
});
