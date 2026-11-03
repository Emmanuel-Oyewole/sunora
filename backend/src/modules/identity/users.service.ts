import { ConflictException, Injectable } from '@nestjs/common';
import { User } from '../../generated/prisma/client.js';
import { UserRepository } from './users.repository.js';

export type PublicUser = Omit<User, 'passwordHash'>;
export type UserCredentials = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'role'
  | 'passwordHash'
  | 'disabledAt'
  | 'emailVerifiedAt'
>;

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

  async create(input: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<PublicUser> {
    try {
      const user = await this.repo.create({
        email: normalizeEmail(input.email),
        name: input.name.trim(),
        passwordHash: input.passwordHash,
      });
      return toPublic(user);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('Email is already registered');
      }
      throw err;
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
  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const user = await this.repo.findByEmail(normalizeEmail(email));
    if (!user) return null;
    const {
      id,
      email: e,
      name,
      role,
      passwordHash,
      disabledAt,
      emailVerifiedAt,
    } = user;
    return {
      id,
      email: e,
      name,
      role,
      passwordHash,
      disabledAt,
      emailVerifiedAt,
    };
  }
  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.repo.updatePasswordHash(userId, passwordHash);
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.repo.markEmailVerified(userId);
  }
}
