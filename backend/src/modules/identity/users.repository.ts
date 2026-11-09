import { Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/database/prisma.service.js';
import type { DbTransaction } from '../../shared/database/unit-of-work.js';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: DbTransaction): DbTransaction {
    return tx ?? this.prisma;
  }

  create(
    data: { email: string; name: string; passwordHash: string },
    tx?: DbTransaction,
  ): Promise<User> {
    return this.db(tx).user.create({ data });
  }

  findById(id: string, tx?: DbTransaction): Promise<User | null> {
    return this.db(tx).user.findUnique({ where: { id } });
  }

  findByEmail(email: string, tx?: DbTransaction): Promise<User | null> {
    return this.db(tx).user.findUnique({ where: { email } });
  }

  updatePassword(
    id: string,
    passwordHash: string,
    changedAt: Date,
    tx?: DbTransaction,
  ): Promise<User> {
    return this.db(tx).user.update({
      where: { id },
      data: { passwordHash, passwordChangedAt: changedAt },
    });
  }

  markEmailVerified(id: string, at: Date, tx?: DbTransaction): Promise<User> {
    return this.db(tx).user.update({ where: { id }, data: { emailVerifiedAt: at } });
  }
}
