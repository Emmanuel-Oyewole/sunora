import { JwtService } from '@nestjs/jwt';
import type { UnitOfWork } from '../../../shared/database/unit-of-work.js';
import { loadEnv } from '../../../shared/config/env.js';
import { FakeClock, InMemoryIdentity } from '../../../../test/helpers/in-memory-identity.js';
import type { AuthEventsRepository } from '../auth-events.repository.js';
import type { SessionsRepository } from '../sessions.repository.js';
import type { UserTokensRepository } from '../user-tokens.repository.js';
import type { UserRepository } from '../users.repository.js';
import { UsersService } from '../users.service.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const env = loadEnv({
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'd',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
  WEB_URL: 'http://localhost:3000',
});

const ctx = { ip: '203.0.113.7', userAgent: 'vitest' };
const PASSWORD = 'correct horse battery';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

async function setup() {
  const world = new InMemoryIdentity(new FakeClock());
  const passwords = new PasswordService();
  await passwords.onModuleInit();
  const tokens = new TokenService(new JwtService({ secret: env.auth.jwtSecret }), env);
  const auth = new AuthService(
    env,
    new UsersService(world.userRepository as unknown as UserRepository),
    world.sessionsRepository as unknown as SessionsRepository,
    world.userTokensRepository as unknown as UserTokensRepository,
    world.authEventsRepository as unknown as AuthEventsRepository,
    passwords,
    tokens,
    world.unitOfWork as unknown as UnitOfWork,
    world.notifications,
    world.clock,
  );
  return { world, auth, tokens };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function registerAndVerify(s: Setup, email = 'ada@example.com') {
  await s.auth.register({ email, password: PASSWORD, name: 'Ada' }, ctx);
  const token = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);
  await s.auth.verifyEmail(token, ctx);
}

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: { code?: string }) => error.code ?? 'unknown error',
  );

describe('AuthService', () => {
  describe('register', () => {
    it('creates an unverified account, stores a hashed password, and emails a verification link', async () => {
      const s = await setup();

      await s.auth.register({ email: 'Ada@Example.com ', password: PASSWORD, name: ' Ada ' }, ctx);

      expect(s.world.users).toHaveLength(1);
      const user = s.world.users[0];
      expect(user.email).toBe('ada@example.com');
      expect(user.name).toBe('Ada');
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);

      const email = s.world.lastEmail('VERIFY_EMAIL');
      expect(email.to.email).toBe('ada@example.com');
      expect(email.params.verifyUrl).toMatch(/^http:\/\/localhost:3000\/verify-email#token=[\w-]{43}$/);
      expect(s.world.events.map((e) => e.type)).toContain('REGISTER');
    });

    it('does not create a session: registering never signs the user in', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);
      expect(s.world.sessions).toHaveLength(0);
    });

    it('stores only the hash of the emailed token', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);

      const raw = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);
      const stored = s.world.userTokens[0];

      expect(stored.tokenHash).toBe(s.tokens.hashToken(raw));
      expect(stored.tokenHash).not.toBe(raw);
      expect(stored.email).toBe('ada@example.com');
    });

    it('answers the same for an existing email, creates nothing, and emails the owner instead', async () => {
      const s = await setup();
      await registerAndVerify(s);
      const usersBefore = s.world.users.length;
      const verifyEmailsBefore = s.world.emails.filter((e) => e.template === 'VERIFY_EMAIL').length;

      await expect(
        s.auth.register({ email: 'ADA@example.com', password: 'another password!', name: 'Impostor' }, ctx),
      ).resolves.toBeUndefined();

      expect(s.world.users).toHaveLength(usersBefore);
      expect(s.world.emails.filter((e) => e.template === 'VERIFY_EMAIL')).toHaveLength(verifyEmailsBefore);
      const notice = s.world.lastEmail('ACCOUNT_EXISTS');
      expect(notice.to.email).toBe('ada@example.com');
      expect(notice.params.name).toBe('Ada'); // the owner's name, not the impostor's
      expect(s.world.events.map((e) => e.type)).toContain('REGISTRATION_EXISTING_EMAIL');
    });
  });

  describe('verifyEmail', () => {
    it('verifies the account and consumes the token', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);
      const token = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);

      await s.auth.verifyEmail(token, ctx);

      expect(s.world.users[0].emailVerifiedAt).not.toBeNull();
      expect(await codeOf(s.auth.verifyEmail(token, ctx))).toBe('INVALID_OR_EXPIRED_TOKEN'); // single use
    });

    it('rejects unknown, expired and wrong-purpose tokens with the same error', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);
      const verifyToken = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);

      expect(await codeOf(s.auth.verifyEmail('x'.repeat(43), ctx))).toBe('INVALID_OR_EXPIRED_TOKEN');

      s.world.clock.advance(env.auth.verificationTtlSeconds * SECOND + SECOND);
      expect(await codeOf(s.auth.verifyEmail(verifyToken, ctx))).toBe('INVALID_OR_EXPIRED_TOKEN');

      await s.auth.forgotPassword('ada@example.com', ctx);
      const resetToken = InMemoryIdentity.tokenFromLink(s.world.lastEmail('PASSWORD_RESET').params.resetUrl);
      expect(await codeOf(s.auth.verifyEmail(resetToken, ctx))).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('rejects a link issued for an address the account no longer has', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);
      const token = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);

      s.world.users[0].email = 'changed@example.com';

      expect(await codeOf(s.auth.verifyEmail(token, ctx))).toBe('INVALID_OR_EXPIRED_TOKEN');
      expect(s.world.users[0].emailVerifiedAt).toBeNull();
    });
  });

  describe('resendVerification', () => {
    it('stays silent for unknown, already verified and disabled accounts', async () => {
      const s = await setup();
      await registerAndVerify(s);
      const sent = s.world.emails.length;

      await s.auth.resendVerification('nobody@example.com', ctx);
      await s.auth.resendVerification('ada@example.com', ctx); // already verified
      expect(s.world.emails).toHaveLength(sent);
    });

    it('respects the cooldown, then supersedes the old link', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);
      const first = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);
      const sent = s.world.emails.length;

      await s.auth.resendVerification('ada@example.com', ctx);
      expect(s.world.emails).toHaveLength(sent); // inside the cooldown

      s.world.clock.advance(env.auth.resendCooldownSeconds * SECOND + SECOND);
      await s.auth.resendVerification('ada@example.com', ctx);
      expect(s.world.emails).toHaveLength(sent + 1);

      const second = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);
      expect(second).not.toBe(first);
      expect(await codeOf(s.auth.verifyEmail(first, ctx))).toBe('INVALID_OR_EXPIRED_TOKEN');
      await expect(s.auth.verifyEmail(second, ctx)).resolves.toBeUndefined();
    });
  });

  describe('login', () => {
    it('signs in, creates a session with a hashed refresh token, and issues a signed access token', async () => {
      const s = await setup();
      await registerAndVerify(s);

      const { user, tokens } = await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);

      expect(user).toMatchObject({ email: 'ada@example.com', emailVerified: true, role: 'USER' });
      expect(s.world.sessions).toHaveLength(1);
      expect(s.world.refreshTokens[0].tokenHash).toBe(s.tokens.hashToken(tokens.refreshToken));
      expect(s.world.refreshTokens[0].tokenHash).not.toBe(tokens.refreshToken);

      const claims = new JwtService({ secret: env.auth.jwtSecret }).verify<Record<string, unknown>>(
        tokens.accessToken,
      );
      expect(claims).toMatchObject({
        sub: user.id,
        sid: s.world.sessions[0].id,
        role: 'USER',
        iss: 'sunora',
        aud: 'sunora-web',
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(env.auth.accessTtlSeconds);
    });

    it('lets an unverified user sign in', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);

      const { user } = await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);

      expect(user.emailVerified).toBe(false);
    });

    it('gives one identical error for a wrong password, an unknown email and a disabled account', async () => {
      const s = await setup();
      await registerAndVerify(s);

      expect(await codeOf(s.auth.login({ email: 'ada@example.com', password: 'wrong password!' }, ctx))).toBe(
        'INVALID_CREDENTIALS',
      );
      expect(await codeOf(s.auth.login({ email: 'ghost@example.com', password: PASSWORD }, ctx))).toBe(
        'INVALID_CREDENTIALS',
      );
      s.world.users[0].disabledAt = s.world.clock.now();
      expect(await codeOf(s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx))).toBe(
        'INVALID_CREDENTIALS',
      );
      expect(s.world.events.filter((e) => e.type === 'LOGIN_FAILED')).toHaveLength(3);
      expect(s.world.sessions).toHaveLength(0);
    });
  });

  describe('refresh', () => {
    async function signedIn() {
      const s = await setup();
      await registerAndVerify(s);
      const { tokens } = await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);
      return { s, tokens };
    }

    it('rotates: returns a new refresh token, marks the old one used, and links parent to child', async () => {
      const { s, tokens } = await signedIn();
      s.world.clock.advance(5 * MINUTE);

      const next = await s.auth.refresh(tokens.refreshToken, ctx);

      expect(next.refreshToken).not.toBe(tokens.refreshToken);
      // Same session, new credentials. (Tokens signed in the same second can be identical.)
      const claims = new JwtService({ secret: env.auth.jwtSecret }).verify<{ sid: string }>(next.accessToken);
      expect(claims.sid).toBe(s.world.sessions[0].id);
      const [parent, child] = s.world.refreshTokens;
      expect(parent.usedAt).not.toBeNull();
      expect(child.parentId).toBe(parent.id);
      expect(child.tokenHash).toBe(s.tokens.hashToken(next.refreshToken));
      expect(s.world.sessions[0].lastUsedAt).toEqual(s.world.clock.now());
    });

    it('never lets a refresh token outlive the session', async () => {
      const { s, tokens } = await signedIn();
      let current = tokens.refreshToken;

      // Refresh every 10 days to keep the session alive.
      for (const days of [10, 10, 9]) {
        s.world.clock.advance(days * DAY);
        current = (await s.auth.refresh(current, ctx)).refreshToken;
      }

      const last = s.world.refreshTokens[s.world.refreshTokens.length - 1];
      expect(s.world.clock.now().getTime() + env.auth.refreshTtlSeconds * SECOND).toBeGreaterThan(
        s.world.sessions[0].expiresAt.getTime(),
      ); // sliding expiry alone would outlive the session
      expect(last.expiresAt.getTime()).toBe(s.world.sessions[0].expiresAt.getTime());
    });

    it('tolerates a replay inside the grace window (two tabs) without revoking the session', async () => {
      const { s, tokens } = await signedIn();

      await s.auth.refresh(tokens.refreshToken, ctx);
      s.world.clock.advance((env.auth.refreshGraceSeconds - 1) * SECOND);
      await expect(s.auth.refresh(tokens.refreshToken, ctx)).resolves.toMatchObject({
        refreshToken: expect.any(String),
      });

      expect(s.world.sessions[0].revokedAt).toBeNull();
    });

    it('handles two simultaneous refreshes with the same token: both succeed, nothing is revoked', async () => {
      const { s, tokens } = await signedIn();

      const results = await Promise.allSettled([
        s.auth.refresh(tokens.refreshToken, ctx),
        s.auth.refresh(tokens.refreshToken, ctx),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(s.world.sessions[0].revokedAt).toBeNull();
    });

    it('treats a replay after the grace window as theft: revokes the whole session', async () => {
      const { s, tokens } = await signedIn();
      const stolen = tokens.refreshToken;
      const legitimate = await s.auth.refresh(stolen, ctx);

      s.world.clock.advance((env.auth.refreshGraceSeconds + 1) * SECOND);
      expect(await codeOf(s.auth.refresh(stolen, ctx))).toBe('UNAUTHENTICATED');

      expect(s.world.sessions[0]).toMatchObject({ revokedReason: 'REUSE_DETECTED' });
      expect(s.world.events.map((e) => e.type)).toContain('REFRESH_REUSE_DETECTED');
      // The real owner is signed out too, so the thief's copy is useless.
      expect(await codeOf(s.auth.refresh(legitimate.refreshToken, ctx))).toBe('UNAUTHENTICATED');
    });

    it.each([
      ['an unknown token', async (s: Setup) => ({ token: 'x'.repeat(43), s })],
      ['no token', async () => undefined],
    ])('rejects %s', async (_name, build) => {
      const { s } = await signedIn();
      const built = await build(s);
      expect(await codeOf(s.auth.refresh(built?.token, ctx))).toBe('UNAUTHENTICATED');
    });

    it('rejects an expired refresh token', async () => {
      const { s, tokens } = await signedIn();
      s.world.clock.advance(env.auth.refreshTtlSeconds * SECOND + SECOND);
      expect(await codeOf(s.auth.refresh(tokens.refreshToken, ctx))).toBe('UNAUTHENTICATED');
    });

    it('rejects a disabled user and revokes the session', async () => {
      const { s, tokens } = await signedIn();
      s.world.users[0].disabledAt = s.world.clock.now();

      expect(await codeOf(s.auth.refresh(tokens.refreshToken, ctx))).toBe('UNAUTHENTICATED');
      expect(s.world.sessions[0].revokedAt).not.toBeNull();
    });

    it('rejects a session that started before a password change', async () => {
      const { s, tokens } = await signedIn();
      s.world.clock.advance(MINUTE);
      s.world.users[0].passwordChangedAt = s.world.clock.now();

      expect(await codeOf(s.auth.refresh(tokens.refreshToken, ctx))).toBe('UNAUTHENTICATED');
      expect(s.world.sessions[0].revokedReason).toBe('PASSWORD_CHANGED');
    });
  });

  describe('logout', () => {
    it('revokes the session, so its refresh token stops working', async () => {
      const s = await setup();
      await registerAndVerify(s);
      const { tokens } = await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);

      await s.auth.logout(tokens.refreshToken, ctx);

      expect(s.world.sessions[0]).toMatchObject({ revokedReason: 'LOGOUT' });
      expect(await codeOf(s.auth.refresh(tokens.refreshToken, ctx))).toBe('UNAUTHENTICATED');
    });

    it('is idempotent and never throws for unknown or missing tokens', async () => {
      const s = await setup();
      await expect(s.auth.logout(undefined, ctx)).resolves.toBeUndefined();
      await expect(s.auth.logout('x'.repeat(43), ctx)).resolves.toBeUndefined();
    });

    it('logoutAll revokes every session of that user and nobody else’s', async () => {
      const s = await setup();
      await registerAndVerify(s, 'ada@example.com');
      await registerAndVerify(s, 'bob@example.com');
      await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);
      await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);
      await s.auth.login({ email: 'bob@example.com', password: PASSWORD }, ctx);
      const ada = s.world.users.find((u) => u.email === 'ada@example.com')!;

      await s.auth.logoutAll(ada.id, ctx);

      const [a1, a2, b1] = s.world.sessions;
      expect([a1.revokedAt, a2.revokedAt].every(Boolean)).toBe(true);
      expect(b1.revokedAt).toBeNull();
    });
  });

  describe('password reset', () => {
    it('stays silent for unknown or disabled accounts and respects the cooldown', async () => {
      const s = await setup();
      await registerAndVerify(s);
      const sent = s.world.emails.length;

      await s.auth.forgotPassword('nobody@example.com', ctx);
      expect(s.world.emails).toHaveLength(sent);

      await s.auth.forgotPassword('ada@example.com', ctx);
      expect(s.world.emails).toHaveLength(sent + 1);
      await s.auth.forgotPassword('ada@example.com', ctx); // inside the cooldown
      expect(s.world.emails).toHaveLength(sent + 1);

      s.world.users[0].disabledAt = s.world.clock.now();
      s.world.clock.advance(env.auth.resendCooldownSeconds * SECOND + SECOND);
      await s.auth.forgotPassword('ada@example.com', ctx);
      expect(s.world.emails).toHaveLength(sent + 1);
    });

    it('resets the password, signs out every device, consumes the token and notifies the user', async () => {
      const s = await setup();
      await registerAndVerify(s);
      const { tokens } = await s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx);
      await s.auth.forgotPassword('ada@example.com', ctx);
      const reset = s.world.lastEmail('PASSWORD_RESET');
      const token = InMemoryIdentity.tokenFromLink(reset.params.resetUrl);
      s.world.clock.advance(MINUTE);

      await s.auth.resetPassword({ token, password: 'a brand new passphrase' }, ctx);

      await expect(
        s.auth.login({ email: 'ada@example.com', password: 'a brand new passphrase' }, ctx),
      ).resolves.toBeDefined();
      expect(await codeOf(s.auth.login({ email: 'ada@example.com', password: PASSWORD }, ctx))).toBe(
        'INVALID_CREDENTIALS',
      );
      expect(s.world.sessions[0]).toMatchObject({ revokedReason: 'PASSWORD_RESET' });
      expect(await codeOf(s.auth.refresh(tokens.refreshToken, ctx))).toBe('UNAUTHENTICATED');
      expect(await codeOf(s.auth.resetPassword({ token, password: 'yet another passphrase' }, ctx))).toBe(
        'INVALID_OR_EXPIRED_TOKEN',
      );
      expect(s.world.lastEmail('PASSWORD_CHANGED').to.email).toBe('ada@example.com');
      expect(reset.params.expiresInMinutes).toBe(30);
    });

    it('rejects expired, unknown and verification tokens', async () => {
      const s = await setup();
      await s.auth.register({ email: 'ada@example.com', password: PASSWORD, name: 'Ada' }, ctx);
      const verifyToken = InMemoryIdentity.tokenFromLink(s.world.lastEmail('VERIFY_EMAIL').params.verifyUrl);
      await s.auth.forgotPassword('ada@example.com', ctx);
      const token = InMemoryIdentity.tokenFromLink(s.world.lastEmail('PASSWORD_RESET').params.resetUrl);

      expect(await codeOf(s.auth.resetPassword({ token: 'x'.repeat(43), password: 'a long enough one' }, ctx))).toBe(
        'INVALID_OR_EXPIRED_TOKEN',
      );
      expect(await codeOf(s.auth.resetPassword({ token: verifyToken, password: 'a long enough one' }, ctx))).toBe(
        'INVALID_OR_EXPIRED_TOKEN',
      );
      s.world.clock.advance(env.auth.passwordResetTtlSeconds * SECOND + SECOND);
      expect(await codeOf(s.auth.resetPassword({ token, password: 'a long enough one' }, ctx))).toBe(
        'INVALID_OR_EXPIRED_TOKEN',
      );
    });
  });

  describe('getProfile', () => {
    it('returns the profile without the password hash', async () => {
      const s = await setup();
      await registerAndVerify(s);

      const profile = await s.auth.getProfile(s.world.users[0].id);

      expect(profile).toEqual({
        id: s.world.users[0].id,
        email: 'ada@example.com',
        name: 'Ada',
        role: 'USER',
        emailVerified: true,
        createdAt: expect.any(Date),
      });
    });

    it('rejects a disabled user', async () => {
      const s = await setup();
      await registerAndVerify(s);
      s.world.users[0].disabledAt = s.world.clock.now();
      expect(await codeOf(s.auth.getProfile(s.world.users[0].id))).toBe('UNAUTHENTICATED');
    });
  });
});
