import type {
  RefreshToken,
  Session,
  SessionRevokedReason,
  User,
  UserToken,
  UserTokenPurpose,
} from '../../src/generated/prisma/client.js';
import { Clock } from '../../src/modules/identity/clock.js';
import type { RefreshTokenWithSession } from '../../src/modules/identity/sessions.repository.js';
import type {
  EmailTemplateKey,
  NotificationsFacade,
  SendEmailRequest,
} from '../../src/modules/notifications/index.js';

/**
 * In-memory stand-ins for the identity repositories, unit of work and
 * notifications facade. They copy the DB behaviour the services rely on (unique
 * emails, one active token per purpose, conditional updates), so tests run
 * without Postgres. Real constraints still need database integration tests.
 */

export class FakeClock extends Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

let counter = 0;
const id = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;
const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

export interface RecordedEvent {
  type: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export class InMemoryIdentity {
  users: User[] = [];
  sessions: Session[] = [];
  refreshTokens: RefreshToken[] = [];
  userTokens: UserToken[] = [];
  events: RecordedEvent[] = [];
  emails: SendEmailRequest[] = [];

  constructor(readonly clock: FakeClock = new FakeClock()) {}

  readonly userRepository = {
    create: (data: { email: string; name: string; passwordHash: string }): Promise<User> => {
      if (this.users.some((u) => u.email.toLowerCase() === data.email.toLowerCase())) {
        return Promise.reject(uniqueViolation());
      }
      const now = this.clock.now();
      const user: User = {
        id: id(),
        ...data,
        role: 'USER',
        emailVerifiedAt: null,
        passwordChangedAt: null,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.users.push(user);
      return Promise.resolve(user);
    },
    findById: (userId: string) => Promise.resolve(this.users.find((u) => u.id === userId) ?? null),
    findByEmail: (email: string) => Promise.resolve(this.users.find((u) => u.email === email) ?? null),
    updatePassword: (userId: string, passwordHash: string, changedAt: Date) => {
      const user = this.mustFindUser(userId);
      Object.assign(user, { passwordHash, passwordChangedAt: changedAt });
      return Promise.resolve(user);
    },
    markEmailVerified: (userId: string, at: Date) => {
      const user = this.mustFindUser(userId);
      user.emailVerifiedAt = at;
      return Promise.resolve(user);
    },
  };

  readonly sessionsRepository = {
    createSession: (data: { userId: string; expiresAt: Date; userAgent?: string; ip?: string }) => {
      const now = this.clock.now();
      const session: Session = {
        id: id(),
        userId: data.userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: data.expiresAt,
        revokedAt: null,
        revokedReason: null,
        userAgent: data.userAgent ?? null,
        ip: data.ip ?? null,
      };
      this.sessions.push(session);
      return Promise.resolve(session);
    },
    createRefreshToken: (data: {
      sessionId: string;
      parentId: string | null;
      tokenHash: string;
      expiresAt: Date;
    }) => {
      const token: RefreshToken = { id: id(), usedAt: null, createdAt: this.clock.now(), ...data };
      this.refreshTokens.push(token);
      return Promise.resolve(token);
    },
    findRefreshTokenByHash: (tokenHash: string): Promise<RefreshTokenWithSession | null> => {
      const token = this.refreshTokens.find((t) => t.tokenHash === tokenHash);
      if (!token) return Promise.resolve(null);
      const session = this.sessions.find((s) => s.id === token.sessionId)!;
      const { id: userId, role, disabledAt, passwordChangedAt } = this.mustFindUser(session.userId);
      return Promise.resolve({ ...token, session: { ...session, user: { id: userId, role, disabledAt, passwordChangedAt } } });
    },
    findRefreshTokenUsedAt: (tokenId: string) =>
      Promise.resolve(this.refreshTokens.find((t) => t.id === tokenId) ?? null),
    markRefreshTokenUsed: (tokenId: string, at: Date) => {
      const token = this.refreshTokens.find((t) => t.id === tokenId);
      if (!token || token.usedAt) return Promise.resolve(false);
      token.usedAt = at;
      return Promise.resolve(true);
    },
    touchSession: (sessionId: string, data: { lastUsedAt: Date; userAgent?: string; ip?: string }) => {
      const session = this.sessions.find((s) => s.id === sessionId)!;
      Object.assign(session, { lastUsedAt: data.lastUsedAt, userAgent: data.userAgent ?? session.userAgent, ip: data.ip ?? session.ip });
      return Promise.resolve(session);
    },
    revokeSession: (sessionId: string, reason: SessionRevokedReason, at: Date) => {
      const session = this.sessions.find((s) => s.id === sessionId);
      if (!session || session.revokedAt) return Promise.resolve(false);
      Object.assign(session, { revokedAt: at, revokedReason: reason });
      return Promise.resolve(true);
    },
    revokeAllForUser: (userId: string, reason: SessionRevokedReason, at: Date) => {
      const active = this.sessions.filter((s) => s.userId === userId && !s.revokedAt);
      active.forEach((s) => Object.assign(s, { revokedAt: at, revokedReason: reason }));
      return Promise.resolve(active.length);
    },
  };

  readonly userTokensRepository = {
    create: (data: {
      userId: string;
      purpose: UserTokenPurpose;
      tokenHash: string;
      email: string;
      expiresAt: Date;
      requestedIp?: string;
    }) => {
      // Mirrors the partial unique index: one active token per user and purpose.
      if (this.userTokens.some((t) => t.userId === data.userId && t.purpose === data.purpose && !t.usedAt && !t.revokedAt)) {
        return Promise.reject(uniqueViolation());
      }
      const token: UserToken = {
        id: id(),
        usedAt: null,
        revokedAt: null,
        requestedIp: data.requestedIp ?? null,
        createdAt: this.clock.now(),
        ...data,
      };
      this.userTokens.push(token);
      return Promise.resolve(token);
    },
    findByHash: (tokenHash: string) =>
      Promise.resolve(this.userTokens.find((t) => t.tokenHash === tokenHash) ?? null),
    revokeActive: (userId: string, purpose: UserTokenPurpose, at: Date) => {
      const active = this.userTokens.filter((t) => t.userId === userId && t.purpose === purpose && !t.usedAt && !t.revokedAt);
      active.forEach((t) => (t.revokedAt = at));
      return Promise.resolve(active.length);
    },
    markUsed: (tokenId: string, at: Date) => {
      const token = this.userTokens.find((t) => t.id === tokenId);
      if (!token || token.usedAt || token.revokedAt) return Promise.resolve(false);
      token.usedAt = at;
      return Promise.resolve(true);
    },
    latestCreatedAt: (userId: string, purpose: UserTokenPurpose) => {
      const times = this.userTokens
        .filter((t) => t.userId === userId && t.purpose === purpose)
        .map((t) => t.createdAt.getTime());
      return Promise.resolve(times.length ? new Date(Math.max(...times)) : null);
    },
  };

  readonly authEventsRepository = {
    record: (event: RecordedEvent) => {
      this.events.push(event);
      return Promise.resolve();
    },
  };

  /** No rollback: enough for service logic; real atomicity needs a database. */
  readonly unitOfWork = { run: <T>(work: (tx: never) => Promise<T>) => work(undefined as never) };

  readonly notifications: NotificationsFacade = {
    send: (request) => {
      this.emails.push(request as SendEmailRequest);
      return Promise.resolve();
    },
  };

  /** The most recent email of a template. */
  lastEmail<K extends EmailTemplateKey>(template: K): SendEmailRequest<K> {
    const found = [...this.emails].reverse().find((e) => e.template === template);
    if (!found) throw new Error(`No ${template} email was sent`);
    return found as SendEmailRequest<K>;
  }

  /** Extracts the raw token from a link like https://app/verify-email#token=abc. */
  static tokenFromLink(link: string): string {
    return new URL(link).hash.replace('#token=', '');
  }

  private mustFindUser(userId: string): User {
    const user = this.users.find((u) => u.id === userId);
    if (!user) throw new Error('user not found');
    return user;
  }
}
