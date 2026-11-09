import { Injectable } from '@nestjs/common';
import type { UserToken, UserTokenPurpose } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/database/prisma.service.js';
import type { DbTransaction } from '../../shared/database/unit-of-work.js';

@Injectable()
export class UserTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: DbTransaction): DbTransaction {
    return tx ?? this.prisma;
  }

  create(
    data: {
      userId: string;
      purpose: UserTokenPurpose;
      tokenHash: string;
      email: string;
      expiresAt: Date;
      requestedIp?: string;
    },
    tx?: DbTransaction,
  ): Promise<UserToken> {
    return this.db(tx).userToken.create({ data });
  }

  findByHash(tokenHash: string, tx?: DbTransaction): Promise<UserToken | null> {
    return this.db(tx).userToken.findUnique({ where: { tokenHash } });
  }

  /** Supersedes the user's active token(s) of a purpose. Returns how many were revoked. */
  async revokeActive(
    userId: string,
    purpose: UserTokenPurpose,
    at: Date,
    tx?: DbTransaction,
  ): Promise<number> {
    const { count } = await this.db(tx).userToken.updateMany({
      where: { userId, purpose, usedAt: null, revokedAt: null },
      data: { revokedAt: at },
    });
    return count;
  }

  /** Marks a token used, but only if it is still unused and unrevoked. True for the single winner. */
  async markUsed(id: string, at: Date, tx?: DbTransaction): Promise<boolean> {
    const { count } = await this.db(tx).userToken.updateMany({
      where: { id, usedAt: null, revokedAt: null },
      data: { usedAt: at },
    });
    return count === 1;
  }

  /** When the most recent token of this purpose was issued, for the resend cooldown. */
  async latestCreatedAt(userId: string, purpose: UserTokenPurpose): Promise<Date | null> {
    const latest = await this.prisma.userToken.findFirst({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return latest?.createdAt ?? null;
  }
}
