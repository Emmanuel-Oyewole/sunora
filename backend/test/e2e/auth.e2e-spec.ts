import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
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
import { InMemoryIdentity } from '../helpers/in-memory-identity.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
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
  const world = new InMemoryIdentity();

  // Stands in for DatabaseModule: no Postgres needed.
  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: {} },
      { provide: UnitOfWork, useValue: world.unitOfWork },
    ],
    exports: [PrismaService, UnitOfWork],
  })
  class StubDatabaseModule {}

  // Same global wiring as AppModule.
  @Module({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]), AppConfigModule, StubDatabaseModule, IdentityModule],
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
    .useValue(world.clock)
    .overrideProvider(UserRepository)
    .useValue(world.userRepository)
    .overrideProvider(SessionsRepository)
    .useValue(world.sessionsRepository)
    .overrideProvider(UserTokensRepository)
    .useValue(world.userTokensRepository)
    .overrideProvider(AuthEventsRepository)
    .useValue(world.authEventsRepository)
    .overrideProvider(NotificationsFacade)
    .useValue(world.notifications)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();
  return { app, world };
}

const cookiesOf = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
const cookieNamed = (res: request.Response, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`));
const asCookieHeader = (res: request.Response) => cookiesOf(res).map((c) => c.split(';')[0]).join('; ');

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let world: InMemoryIdentity;

  // New app per test: fresh data and rate-limit counters.
  beforeEach(async () => {
    ({ app, world } = await createApp());
  });
  afterEach(() => app.close());

  const server = () => app.getHttpServer();
  const post = (path: string, body?: object) => request(server()).post(path).set('Origin', ORIGIN).send(body);

  async function registerAndVerify(email = 'ada@example.com') {
    await post('/auth/register', { email, password: PASSWORD, name: 'Ada' }).expect(202);
    const link = world.lastEmail('VERIFY_EMAIL').params.verifyUrl;
    await post('/auth/verify-email', { token: InMemoryIdentity.tokenFromLink(link) }).expect(204);
  }

  async function login(email = 'ada@example.com') {
    return post('/auth/login', { email, password: PASSWORD }).expect(200);
  }

  describe('registration and email verification', () => {
    it('returns the same accepted response for a new and an existing email, and sets no cookies', async () => {
      const first = await post('/auth/register', { email: 'ada@example.com', password: PASSWORD, name: 'Ada' });
      const again = await post('/auth/register', { email: 'ADA@example.com', password: PASSWORD, name: 'Ada' });

      expect(first.status).toBe(202);
      expect(again.status).toBe(202);
      expect(again.body).toEqual(first.body);
      expect(cookiesOf(first)).toHaveLength(0);
      expect(cookiesOf(again)).toHaveLength(0);
      expect(world.users).toHaveLength(1);
    });

    it('verifies once; a second use of the link is rejected with the standard error', async () => {
      await post('/auth/register', { email: 'ada@example.com', password: PASSWORD, name: 'Ada' });
      const token = InMemoryIdentity.tokenFromLink(world.lastEmail('VERIFY_EMAIL').params.verifyUrl);

      await post('/auth/verify-email', { token }).expect(204);
      const second = await post('/auth/verify-email', { token }).expect(400);

      expect(second.body).toEqual({
        statusCode: 400,
        error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'This link is invalid or has expired.' },
      });
    });

    it('rejects invalid input with field-level details, and unknown fields', async () => {
      const res = await post('/auth/register', { email: 'nope', password: 'short', name: '', admin: true }).expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const fields = (res.body.error.details as { field: string }[]).map((d) => d.field).sort();
      expect(fields).toEqual(['admin', 'email', 'name', 'password']);
      expect(JSON.stringify(res.body)).not.toContain('short'); // never echoes submitted values
    });
  });

  describe('sign in and session', () => {
    it('sets httpOnly cookies scoped as designed and returns the user, never the password hash', async () => {
      await registerAndVerify();

      const res = await login();

      const access = cookieNamed(res, 'sunora_at')!;
      const refresh = cookieNamed(res, 'sunora_rt')!;
      expect(access).toMatch(/Path=\/;/);
      expect(refresh).toMatch(/Path=\/auth;/);
      for (const cookie of [access, refresh]) {
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/SameSite=Lax/);
      }
      expect(res.body.user).toMatchObject({ email: 'ada@example.com', emailVerified: true });
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);
    });

    it('serves /auth/me to a signed-in user and rejects everyone else with 401', async () => {
      await registerAndVerify();
      const cookie = asCookieHeader(await login());

      const me = await request(server()).get('/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.email).toBe('ada@example.com');

      const anonymous = await request(server()).get('/auth/me').expect(401);
      expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

      await request(server()).get('/auth/me').set('Cookie', 'sunora_at=not.a.jwt').expect(401);
    });

    it('lets an unverified user sign in', async () => {
      await post('/auth/register', { email: 'ada@example.com', password: PASSWORD, name: 'Ada' });

      const res = await login();

      expect(res.body.user.emailVerified).toBe(false);
    });

    it('answers a wrong password and an unknown email identically', async () => {
      await registerAndVerify();

      const wrong = await post('/auth/login', { email: 'ada@example.com', password: 'wrong password!' }).expect(401);
      const unknown = await post('/auth/login', { email: 'ghost@example.com', password: PASSWORD }).expect(401);

      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(cookiesOf(wrong)).toHaveLength(0);
    });

    it('limits repeated login attempts per client with 429', async () => {
      const attempt = () => post('/auth/login', { email: 'ada@example.com', password: 'wrong password!' });
      for (let i = 0; i < 5; i++) await attempt().expect(401);

      const limited = await attempt().expect(429);

      expect(limited.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('refresh and logout', () => {
    it('rotates the cookies on refresh, and the new session keeps working', async () => {
      await registerAndVerify();
      const agent = request.agent(server());
      await agent.post('/auth/login').set('Origin', ORIGIN).send({ email: 'ada@example.com', password: PASSWORD }).expect(200);

      const refreshed = await agent.post('/auth/refresh').set('Origin', ORIGIN).expect(204);

      expect(cookieNamed(refreshed, 'sunora_at')).toBeDefined();
      expect(cookieNamed(refreshed, 'sunora_rt')).toBeDefined();
      await agent.get('/auth/me').expect(200);
    });

    it('rejects refresh without a cookie and clears any stale cookies', async () => {
      const res = await post('/auth/refresh').expect(401);

      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(cookieNamed(res, 'sunora_rt')).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('treats a replay after the grace window as theft and revokes the session', async () => {
      await registerAndVerify();
      const original = asCookieHeader(await login());
      await post('/auth/refresh').set('Cookie', original).expect(204);

      world.clock.advance((env.auth.refreshGraceSeconds + 1) * 1000);
      await post('/auth/refresh').set('Cookie', original).expect(401);

      expect(world.sessions[0].revokedReason).toBe('REUSE_DETECTED');
    });

    it('logout revokes the session: refresh stops working and cookies are cleared', async () => {
      await registerAndVerify();
      const cookie = asCookieHeader(await login());

      const out = await post('/auth/logout').set('Cookie', cookie).expect(204);

      expect(cookieNamed(out, 'sunora_at')).toMatch(/Expires=Thu, 01 Jan 1970/);
      await post('/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('logout is harmless without a session', async () => {
      await post('/auth/logout').expect(204);
    });

    it('logout-all requires authentication and signs out every device', async () => {
      await registerAndVerify();
      const phone = asCookieHeader(await login());
      const laptop = asCookieHeader(await login());

      await post('/auth/logout-all').expect(401);
      await post('/auth/logout-all').set('Cookie', phone).expect(204);

      await post('/auth/refresh').set('Cookie', laptop).expect(401);
      // Stateless access tokens: one already issued stays valid until it expires.
      await request(server()).get('/auth/me').set('Cookie', laptop).expect(200);
    });
  });

  describe('password reset', () => {
    it('answers identically whether or not the account exists', async () => {
      await registerAndVerify();

      const known = await post('/auth/forgot-password', { email: 'ada@example.com' }).expect(202);
      const unknown = await post('/auth/forgot-password', { email: 'ghost@example.com' }).expect(202);

      expect(known.body).toEqual(unknown.body);
      expect(world.emails.filter((e) => e.template === 'PASSWORD_RESET')).toHaveLength(1);
    });

    it('resets the password, signs out old sessions, and the new password works', async () => {
      await registerAndVerify();
      const oldSession = asCookieHeader(await login());
      await post('/auth/forgot-password', { email: 'ada@example.com' });
      const token = InMemoryIdentity.tokenFromLink(world.lastEmail('PASSWORD_RESET').params.resetUrl);

      await post('/auth/reset-password', { token, password: 'a brand new passphrase' }).expect(204);

      await post('/auth/refresh').set('Cookie', oldSession).expect(401);
      await post('/auth/login', { email: 'ada@example.com', password: PASSWORD }).expect(401);
      await post('/auth/login', { email: 'ada@example.com', password: 'a brand new passphrase' }).expect(200);
      await post('/auth/reset-password', { token, password: 'one more passphrase!' }).expect(400);
    });
  });

  describe('CSRF origin check', () => {
    it('blocks a state-changing request from another origin, even login', async () => {
      const res = await request(server())
        .post('/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ email: 'ada@example.com', password: PASSWORD })
        .expect(403);

      expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
    });

    it('blocks a cookie-bearing request that carries no origin at all', async () => {
      await registerAndVerify();
      const cookie = asCookieHeader(await login());

      const res = await request(server()).post('/auth/logout-all').set('Cookie', cookie).expect(403);

      expect(res.body.error.code).toBe('CSRF_ORIGIN_MISSING');
    });

    it('answers CORS preflight only for the web app origin, with credentials', async () => {
      const ok = await request(server())
        .options('/auth/login')
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', 'POST');
      expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(ok.headers['access-control-allow-credentials']).toBe('true');

      const evil = await request(server())
        .options('/auth/login')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    });
  });
});
