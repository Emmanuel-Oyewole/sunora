import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthEventType, UserTokenPurpose } from '../../../generated/prisma/client.js';
import { APP_ENV, type AppEnv } from '../../../shared/config/env.js';
import { isUniqueViolation } from '../../../shared/database/errors.js';
import { UnitOfWork, type DbTransaction } from '../../../shared/database/unit-of-work.js';
import { NotificationsFacade, type EmailTemplateKey, type SendEmailRequest } from '../../notifications/index.js';
import { AuthEventsRepository } from '../auth-events.repository.js';
import { Clock } from '../clock.js';
import { SessionsRepository } from '../sessions.repository.js';
import { UserTokensRepository } from '../user-tokens.repository.js';
import {
  EmailTakenError,
  UsersService,
  normalizeEmail,
  type PublicUser,
  type UserCredentials,
} from '../users.service.js';
import { invalidCredentials, invalidToken, unauthenticated } from './auth.errors.js';
import { PasswordService } from './password.service.js';
import type { RequestContext } from './request-context.decorator.js';
import { TokenService } from './token.service.js';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  emailVerified: boolean;
  createdAt: Date;
}

const toProfile = (user: PublicUser): UserProfile => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  emailVerified: user.emailVerifiedAt !== null,
  createdAt: user.createdAt,
});

const seconds = (n: number) => n * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly users: UsersService,
    private readonly sessions: SessionsRepository,
    private readonly userTokens: UserTokensRepository,
    private readonly events: AuthEventsRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly uow: UnitOfWork,
    private readonly notifications: NotificationsFacade,
    private readonly clock: Clock,
  ) {}

  /**
   * Always gives the same result, so callers can't tell if an email is taken.
   * New address: verification email. Existing account: "you already have an account" email.
   */
  async register(input: { email: string; password: string; name: string }, ctx: RequestContext): Promise<void> {
    const email = normalizeEmail(input.email);
    // Hash even if the account exists, so timing doesn't give it away.
    const passwordHash = await this.passwords.hash(input.password);
    const now = this.clock.now();

    let created: { user: PublicUser; rawToken: string };
    try {
      created = await this.uow.run(async (tx) => {
        const user = await this.users.create({ email, name: input.name, passwordHash }, tx);
        const rawToken = await this.issueUserToken(user, 'EMAIL_VERIFICATION', now, ctx, tx);
        return { user, rawToken };
      });
    } catch (error) {
      if (error instanceof EmailTakenError) {
        await this.notifyExistingAccount(email, ctx);
        return;
      }
      throw error;
    }

    await this.record('REGISTER', { userId: created.user.id }, ctx);
    await this.sendVerificationEmail(created.user, created.rawToken);
  }

  private async notifyExistingAccount(email: string, ctx: RequestContext): Promise<void> {
    const existing = await this.users.findCredentialsByEmail(email);
    if (!existing) return; // deleted between the failed insert and this lookup
    await this.record('REGISTRATION_EXISTING_EMAIL', { userId: existing.id }, ctx);
    await this.send({
      template: 'ACCOUNT_EXISTS',
      to: { email: existing.email, name: existing.name },
      params: {
        name: existing.name,
        signInUrl: `${this.env.webOrigin}/sign-in`,
        resetUrl: `${this.env.webOrigin}/forgot-password`,
      },
    });
  }

  async verifyEmail(rawToken: string, ctx: RequestContext): Promise<void> {
    const now = this.clock.now();
    const token = await this.userTokens.findByHash(this.tokens.hashToken(rawToken));
    if (!this.isUsable(token, 'EMAIL_VERIFICATION', now)) throw invalidToken();

    // The link only works for the address it was sent to.
    const user = await this.users.findById(token.userId);
    if (!user || user.email !== token.email) throw invalidToken();

    await this.uow.run(async (tx) => {
      if (!(await this.userTokens.markUsed(token.id, now, tx))) throw invalidToken();
      await this.users.markEmailVerified(user.id, now, tx);
    });
    await this.record('EMAIL_VERIFIED', { userId: user.id }, ctx);
  }

  /** Same result whether or not the account exists, is verified, or is within the cooldown. */
  async resendVerification(email: string, ctx: RequestContext): Promise<void> {
    const user = await this.users.findCredentialsByEmail(email);
    if (!user || user.emailVerifiedAt || user.disabledAt) return;

    const rawToken = await this.issueWithCooldown(user, 'EMAIL_VERIFICATION', ctx);
    if (!rawToken) return;
    await this.record('EMAIL_VERIFICATION_REQUESTED', { userId: user.id }, ctx);
    await this.sendVerificationEmail(user, rawToken);
  }

  async login(
    input: { email: string; password: string },
    ctx: RequestContext,
  ): Promise<{ user: UserProfile; tokens: IssuedTokens }> {
    const credentials = await this.users.findCredentialsByEmail(input.email);
    const valid = await this.passwords.verify(credentials?.passwordHash ?? null, input.password);

    if (!credentials || !valid || credentials.disabledAt) {
      await this.record('LOGIN_FAILED', { userId: credentials?.id }, ctx);
      throw invalidCredentials();
    }

    const tokens = await this.startSession(credentials, ctx);
    await this.record('LOGIN_SUCCESS', { userId: credentials.id }, ctx);
    const user = await this.users.findById(credentials.id);
    if (!user) throw invalidCredentials();
    return { user: toProfile(user), tokens };
  }

  private async startSession(
    user: Pick<UserCredentials, 'id' | 'role'>,
    ctx: RequestContext,
  ): Promise<IssuedTokens> {
    const now = this.clock.now();
    const sessionExpiresAt = new Date(now.getTime() + seconds(this.env.auth.sessionMaxAgeSeconds));
    const refresh = this.tokens.generateOpaqueToken();

    const session = await this.uow.run(async (tx) => {
      const created = await this.sessions.createSession(
        { userId: user.id, expiresAt: sessionExpiresAt, userAgent: ctx.userAgent, ip: ctx.ip },
        tx,
      );
      await this.sessions.createRefreshToken(
        {
          sessionId: created.id,
          parentId: null,
          tokenHash: refresh.hash,
          expiresAt: this.refreshExpiry(now, sessionExpiresAt),
        },
        tx,
      );
      return created;
    });

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      sessionId: session.id,
      role: user.role,
    });
    return { accessToken, refreshToken: refresh.raw };
  }

  /** Refresh tokens slide forward on use but never outlive the session. */
  private refreshExpiry(now: Date, sessionExpiresAt: Date): Date {
    const sliding = now.getTime() + seconds(this.env.auth.refreshTtlSeconds);
    return new Date(Math.min(sliding, sessionExpiresAt.getTime()));
  }

  /**
   * Rotates the refresh token. Replaying an old one within a short grace window
   * is allowed (two tabs); after that it counts as theft and the session is revoked.
   */
  async refresh(rawRefreshToken: string | undefined, ctx: RequestContext): Promise<IssuedTokens> {
    if (!rawRefreshToken) throw unauthenticated();
    const now = this.clock.now();
    const hash = this.tokens.hashToken(rawRefreshToken);

    const found = await this.sessions.findRefreshTokenByHash(hash);
    if (!found) throw unauthenticated();
    const { session } = found;
    const { user } = session;

    if (session.revokedAt || session.expiresAt <= now || found.expiresAt <= now) throw unauthenticated();
    if (user.disabledAt) {
      await this.revokeSession(session.id, 'ADMIN', now, user.id, ctx);
      throw unauthenticated();
    }
    // A password change invalidates every session that started before it.
    if (user.passwordChangedAt && user.passwordChangedAt > session.createdAt) {
      await this.revokeSession(session.id, 'PASSWORD_CHANGED', now, user.id, ctx);
      throw unauthenticated();
    }

    const next = this.tokens.generateOpaqueToken();
    const outcome = await this.uow.run(async (tx) => {
      let usedAt = found.usedAt;
      if (!usedAt) {
        // First use wins the conditional update. A concurrent loser re-reads when it was used.
        usedAt = (await this.sessions.markRefreshTokenUsed(found.id, now, tx))
          ? now
          : ((await this.sessions.findRefreshTokenUsedAt(found.id, tx))?.usedAt ?? now);
      }
      if (now.getTime() - usedAt.getTime() > seconds(this.env.auth.refreshGraceSeconds)) {
        return 'reuse' as const;
      }
      await this.sessions.createRefreshToken(
        {
          sessionId: session.id,
          parentId: found.id,
          tokenHash: next.hash,
          expiresAt: this.refreshExpiry(now, session.expiresAt),
        },
        tx,
      );
      await this.sessions.touchSession(
        session.id,
        { lastUsedAt: now, userAgent: ctx.userAgent, ip: ctx.ip },
        tx,
      );
      return 'issued' as const;
    });

    if (outcome === 'reuse') {
      await this.revokeSession(session.id, 'REUSE_DETECTED', now, user.id, ctx);
      await this.record('REFRESH_REUSE_DETECTED', { userId: user.id, sessionId: session.id }, ctx);
      throw unauthenticated();
    }

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      sessionId: session.id,
      role: user.role,
    });
    return { accessToken, refreshToken: next.raw };
  }

  /** Idempotent: an unknown or already-revoked token is not an error. */
  async logout(rawRefreshToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawRefreshToken) return;
    const found = await this.sessions.findRefreshTokenByHash(this.tokens.hashToken(rawRefreshToken));
    if (!found) return;
    const revoked = await this.sessions.revokeSession(found.sessionId, 'LOGOUT', this.clock.now());
    if (revoked) {
      await this.record('LOGOUT', { userId: found.session.userId, sessionId: found.sessionId }, ctx);
    }
  }

  async logoutAll(userId: string, ctx: RequestContext): Promise<void> {
    const count = await this.sessions.revokeAllForUser(userId, 'LOGOUT_ALL', this.clock.now());
    await this.record('SESSION_REVOKED', { userId, metadata: { reason: 'LOGOUT_ALL', count } }, ctx);
  }

  /** Same result whether or not the account exists or is within the cooldown. */
  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    const user = await this.users.findCredentialsByEmail(email);
    if (!user || user.disabledAt) return;

    const rawToken = await this.issueWithCooldown(user, 'PASSWORD_RESET', ctx);
    if (!rawToken) return;
    await this.record('PASSWORD_RESET_REQUESTED', { userId: user.id }, ctx);
    await this.send({
      template: 'PASSWORD_RESET',
      to: { email: user.email, name: user.name },
      params: {
        name: user.name,
        resetUrl: this.link('/reset-password', rawToken),
        expiresInMinutes: Math.round(this.env.auth.passwordResetTtlSeconds / 60),
      },
    });
  }

  async resetPassword(input: { token: string; password: string }, ctx: RequestContext): Promise<void> {
    const now = this.clock.now();
    const token = await this.userTokens.findByHash(this.tokens.hashToken(input.token));
    if (!this.isUsable(token, 'PASSWORD_RESET', now)) throw invalidToken();

    const user = await this.users.findById(token.userId);
    if (!user || user.disabledAt) throw invalidToken();

    const passwordHash = await this.passwords.hash(input.password);
    await this.uow.run(async (tx) => {
      if (!(await this.userTokens.markUsed(token.id, now, tx))) throw invalidToken();
      await this.users.setPassword(user.id, passwordHash, now, tx);
      // Whoever knew the old password (or stole a session) is signed out everywhere.
      await this.sessions.revokeAllForUser(user.id, 'PASSWORD_RESET', now, tx);
    });

    await this.record('PASSWORD_RESET_COMPLETED', { userId: user.id }, ctx);
    await this.send({
      template: 'PASSWORD_CHANGED',
      to: { email: user.email, name: user.name },
      params: { name: user.name },
    });
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.users.findById(userId);
    if (!user || user.disabledAt) throw unauthenticated();
    return toProfile(user);
  }

  private isUsable(
    token: { purpose: UserTokenPurpose; usedAt: Date | null; revokedAt: Date | null; expiresAt: Date } | null,
    purpose: UserTokenPurpose,
    now: Date,
  ): token is NonNullable<typeof token> & { id: string; userId: string; email: string } {
    return (
      token !== null &&
      token.purpose === purpose &&
      token.usedAt === null &&
      token.revokedAt === null &&
      token.expiresAt > now
    );
  }

  /** Issues a token unless one was sent within the cooldown. Returns the raw token, or null if skipped. */
  private async issueWithCooldown(
    user: Pick<UserCredentials, 'id' | 'email'>,
    purpose: UserTokenPurpose,
    ctx: RequestContext,
  ): Promise<string | null> {
    const now = this.clock.now();
    const latest = await this.userTokens.latestCreatedAt(user.id, purpose);
    if (latest && now.getTime() - latest.getTime() < seconds(this.env.auth.resendCooldownSeconds)) {
      return null;
    }
    try {
      return await this.uow.run((tx) => this.issueUserToken(user, purpose, now, ctx, tx));
    } catch (error) {
      // A concurrent request issued the single allowed active token first.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** Supersedes any active token of this purpose and issues a new one. Returns the raw token. */
  private async issueUserToken(
    user: Pick<PublicUser, 'id' | 'email'>,
    purpose: UserTokenPurpose,
    now: Date,
    ctx: RequestContext,
    tx: DbTransaction,
  ): Promise<string> {
    const ttl =
      purpose === 'EMAIL_VERIFICATION'
        ? this.env.auth.verificationTtlSeconds
        : this.env.auth.passwordResetTtlSeconds;
    await this.userTokens.revokeActive(user.id, purpose, now, tx);
    const token = this.tokens.generateOpaqueToken();
    await this.userTokens.create(
      {
        userId: user.id,
        purpose,
        tokenHash: token.hash,
        email: user.email,
        expiresAt: new Date(now.getTime() + seconds(ttl)),
        requestedIp: ctx.ip,
      },
      tx,
    );
    return token.raw;
  }

  private sendVerificationEmail(user: Pick<PublicUser, 'email' | 'name'>, rawToken: string): Promise<void> {
    return this.send({
      template: 'VERIFY_EMAIL',
      to: { email: user.email, name: user.name },
      params: {
        name: user.name,
        verifyUrl: this.link('/verify-email', rawToken),
        expiresInHours: Math.round(this.env.auth.verificationTtlSeconds / 3600),
      },
    });
  }

  /** The token goes in the URL fragment, so browsers never send it to servers or in Referer. */
  private link(path: string, rawToken: string): string {
    return `${this.env.webOrigin}${path}#token=${rawToken}`;
  }

  private async revokeSession(
    sessionId: string,
    reason: 'REUSE_DETECTED' | 'PASSWORD_CHANGED' | 'ADMIN',
    now: Date,
    userId: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (await this.sessions.revokeSession(sessionId, reason, now)) {
      await this.record('SESSION_REVOKED', { userId, sessionId, metadata: { reason } }, ctx);
    }
  }

  /** Email must never fail the flow that triggered it. */
  private async send<K extends EmailTemplateKey>(request: SendEmailRequest<K>): Promise<void> {
    try {
      await this.notifications.send(request);
    } catch (error) {
      this.logger.error(`Could not queue ${request.template} email: ${(error as Error).message}`);
    }
  }

  /** The audit log must never fail the flow it describes. */
  private async record(
    type: AuthEventType,
    data: { userId?: string; sessionId?: string; metadata?: Record<string, string | number | boolean> },
    ctx: RequestContext,
  ): Promise<void> {
    try {
      await this.events.record({ type, ...data, ip: ctx.ip, userAgent: ctx.userAgent });
    } catch (error) {
      this.logger.error(`Could not record auth event ${type}: ${(error as Error).message}`);
    }
  }
}
