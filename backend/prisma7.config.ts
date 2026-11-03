import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Connection string for Prisma CLI commands (migrate, studio, ...), which run
 * on the host machine, not inside Docker.
 *
 * - DATABASE_URL wins if set.
 * - Otherwise it is built from the same POSTGRES_* variables the app uses.
 *   DB_HOST in .env is the Docker service name ("db"), which the host cannot
 *   resolve, so the CLI uses MIGRATE_DB_HOST (default: localhost), which is
 *   where docker-compose publishes Postgres.
 */
function cliDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, DB_PORT } =
    process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) return undefined;

  const url = new URL('postgresql://placeholder');
  url.username = POSTGRES_USER;
  url.password = POSTGRES_PASSWORD;
  url.hostname = process.env.MIGRATE_DB_HOST ?? 'localhost';
  url.port = DB_PORT ?? '5432';
  url.pathname = `/${POSTGRES_DB}`;
  return url.toString();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: cliDatabaseUrl(),
  },
});
