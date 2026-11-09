import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';

// OWASP minimum for argon2id: 19 MiB of memory, 2 iterations, 1 lane.
const OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    // Dummy hash checked for unknown emails, so they take as long as a wrong password.
    this.dummyHash = await hash(randomBytes(16).toString('hex'), OPTIONS);
  }

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  /** Pass null when there is no account: the check still runs, and always fails. */
  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    try {
      if (passwordHash === null) {
        await verify(this.dummyHash || (await hash('x', OPTIONS)), password);
        return false;
      }
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
