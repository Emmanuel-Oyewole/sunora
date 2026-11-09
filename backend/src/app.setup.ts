import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { AppEnv } from './shared/config/env.js';
import { createValidationPipe } from './shared/http/validation.pipe.js';

/** Shared by the app and the e2e tests, so both behave the same. */
export function configureApp(app: INestApplication, env: AppEnv): void {
  app.use(cookieParser());
  app.enableCors({ origin: env.webOrigin, credentials: true });
  app.useGlobalPipes(createValidationPipe());
  // Runs shutdown hooks (like the Prisma disconnect) on SIGTERM and SIGINT.
  app.enableShutdownHooks();
}
