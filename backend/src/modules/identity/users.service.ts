import { Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client.js';
import { isUniqueViolation } from '../../shared/database/errors.js';
import type { DbTransaction } from '../../shared/database/unit-of-work.js';
import { UserRepository } from './users.repository.js';

export type PublicUser = Omit<User, 'passwordHash'>;
export type UserCredentials = Pick<
  User,
  'id' | 'email' | 'name' | 'role' | 'passwordHash' | 'disabledAt' | 'emailVerifiedAt'
>;

/** Thrown when an account with this email already exists. */
export class EmailTakenError extends Error {
  constructor() {
    super('Email is already registered');
    this.name = 'EmailTakenError';
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublic(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

@Injectable()
export class UsersService {
  constructor(private readonly repo: UserRepository) {}

  async create(
    input: { email: string; name: string; passwordHash: string },
    tx?: DbTransaction,
  ): Promise<PublicUser> {
    try {
      const user = await this.repo.create(
        {
          email: normalizeEmail(input.email),
          name: input.name.trim(),
          passwordHash: input.passwordHash,
        },
        tx,
      );
      return toPublic(user);
    } catch (error) {
      if (isUniqueViolation(error)) throw new EmailTakenError();
      throw error;
    }
  }

  async findById(id: string): Promise<PublicUser | null> {
    const user = await this.repo.findById(id);
    return user ? toPublic(user) : null;
  }

  async findByEmail(email: string): Promise<PublicUser | null> {
    const user = await this.repo.findByEmail(normalizeEmail(email));
    return user ? toPublic(user) : null;
  }

  /** Includes the password hash. For authentication code inside this module only. */
  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const user = await this.repo.findByEmail(normalizeEmail(email));
    if (!user) return null;
    const { id, email: e, name, role, passwordHash, disabledAt, emailVerifiedAt } = user;
    return { id, email: e, name, role, passwordHash, disabledAt, emailVerifiedAt };
  }

  /** Sets a new password and records when it changed (used to invalidate older sessions). */
  async setPassword(
    userId: string,
    passwordHash: string,
    changedAt: Date,
    tx?: DbTransaction,
  ): Promise<void> {
    await this.repo.updatePassword(userId, passwordHash, changedAt, tx);
  }

  async markEmailVerified(userId: string, at: Date, tx?: DbTransaction): Promise<void> {
    await this.repo.markEmailVerified(userId, at, tx);
  }
}
