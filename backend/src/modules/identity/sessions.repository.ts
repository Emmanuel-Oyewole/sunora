import { Injectable } from '@nestjs/common';
import type {
  RefreshToken,
  Session,
  SessionRevokedReason,
  User,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/database/prisma.service.js';
import type { DbTransaction } from '../../shared/database/unit-of-work.js';

export type RefreshTokenWithSession = RefreshToken & {
  session: Session & {
    user: Pick<User, 'id' | 'role' | 'disabledAt' | 'passwordChangedAt'>;
  };
};

@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: DbTransaction): DbTransaction {
    return tx ?? this.prisma;
  }

  createSession(
    data: { userId: string; expiresAt: Date; userAgent?: string; ip?: string },
    tx?: DbTransaction,
  ): Promise<Session> {
    return this.db(tx).session.create({ data });
  }

  createRefreshToken(
    data: { sessionId: string; parentId: string | null; tokenHash: string; expiresAt: Date },
    tx?: DbTransaction,
  ): Promise<RefreshToken> {
    return this.db(tx).refreshToken.create({ data });
  }

  findRefreshTokenByHash(
    tokenHash: string,
    tx?: DbTransaction,
  ): Promise<RefreshTokenWithSession | null> {
    return this.db(tx).refreshToken.findUnique({
      where: { tokenHash },
      include: {
        session: {
          include: {
            user: { select: { id: true, role: true, disabledAt: true, passwordChangedAt: true } },
          },
        },
      },
    });
  }

  findRefreshTokenUsedAt(id: string, tx?: DbTransaction): Promise<{ usedAt: Date | null } | null> {
    return this.db(tx).refreshToken.findUnique({ where: { id }, select: { usedAt: true } });
  }

  /** Marks a refresh token used only if nobody else has. True for the one caller that wins, so rotation is atomic. */
  async markRefreshTokenUsed(id: string, at: Date, tx?: DbTransaction): Promise<boolean> {
    const { count } = await this.db(tx).refreshToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: at },
    });
    return count === 1;
  }

  touchSession(
    id: string,
    data: { lastUsedAt: Date; userAgent?: string; ip?: string },
    tx?: DbTransaction,
  ): Promise<Session> {
    return this.db(tx).session.update({ where: { id }, data });
  }

  /** Revokes one session unless it is already revoked. Returns whether it changed. */
  async revokeSession(
    id: string,
    reason: SessionRevokedReason,
    at: Date,
    tx?: DbTransaction,
  ): Promise<boolean> {
    const { count } = await this.db(tx).session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return count === 1;
  }

  /** Revokes every active session of a user. Returns how many were revoked. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokedReason,
    at: Date,
    tx?: DbTransaction,
  ): Promise<number> {
    const { count } = await this.db(tx).session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return count;
  }
}
