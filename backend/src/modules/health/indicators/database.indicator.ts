import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from '../../../shared/database/prisma.service.js';

const DEFAULT_TIMEOUT_MS = 2000;

class PingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database ping exceeded ${timeoutMs}ms`);
  }
}

@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(
    private readonly healthIndicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  /** Up only if a round trip finishes within the timeout. Real errors are logged, not returned. */
  async isHealthy(
    key: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<HealthIndicatorResult> {
    const session = this.healthIndicator.check(key);
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.prisma.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PingTimeoutError(timeoutMs)),
            timeoutMs,
          );
        }),
      ]);
      return session.up();
    } catch (error) {
      this.logger.warn(`Readiness check failed: ${(error as Error).message}`);
      return session.down({
        reason: error instanceof PingTimeoutError ? 'timeout' : 'unreachable',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
