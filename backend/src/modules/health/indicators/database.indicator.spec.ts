import { HealthIndicatorService } from '@nestjs/terminus';
import type { PrismaService } from '../../../shared/database/prisma.service.js';
import { DatabaseHealthIndicator } from './database.indicator.js';

function createIndicator(ping: () => Promise<void>) {
  const prisma = { ping } as unknown as PrismaService;
  return new DatabaseHealthIndicator(new HealthIndicatorService(), prisma);
}

describe('DatabaseHealthIndicator', () => {
  it('reports up when the ping succeeds', async () => {
    const indicator = createIndicator(() => Promise.resolve());

    await expect(indicator.isHealthy('database')).resolves.toEqual({
      database: { status: 'up' },
    });
  });

  it('reports down with a coarse reason when the ping fails', async () => {
    const indicator = createIndicator(() =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    );

    const result = await indicator.isHealthy('database');

    expect(result).toEqual({
      database: { status: 'down', reason: 'unreachable' },
    });
    // The internal error text must not reach the response.
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
  });

  it('reports down with reason "timeout" when the ping hangs', async () => {
    const indicator = createIndicator(() => new Promise<void>(() => {}));

    await expect(indicator.isHealthy('database', 20)).resolves.toEqual({
      database: { status: 'down', reason: 'timeout' },
    });
  });
});
