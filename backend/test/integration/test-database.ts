import type { AppEnv } from '../../src/shared/config/env.js';
import { PrismaService } from '../../src/shared/database/prisma.service.js';
import { UnitOfWork } from '../../src/shared/database/unit-of-work.js';

/**
 * Connects to the separate test database (TEST_DATABASE_URL, see .env.example).
 * It refuses to run unless the database name ends in "_test", because the tests
 * empty the tables.
 */
export function connectTestDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. See .env.example for how to create the test database.');
  }
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run database tests against "${name}": the name must end in "_test".`);
  }

  const prisma = new PrismaService({ database: { url } } as AppEnv);
  return { prisma, unitOfWork: new UnitOfWork(prisma) };
}

export async function emptyConversationTables(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "conversations"."messages", "conversations"."conversations" CASCADE');
}

export async function emptyGenerationTables(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "generation"."idempotency_keys", "generation"."generation_chunks", "generation"."generations" CASCADE',
  );
}
