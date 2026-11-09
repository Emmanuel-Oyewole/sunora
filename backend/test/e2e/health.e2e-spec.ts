import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthModule } from '../../src/modules/health/health.module.js';
import { PrismaService } from '../../src/shared/database/prisma.service.js';

const prisma = { ping: vi.fn<() => Promise<void>>() };

// Stands in for DatabaseModule so the test needs no real database.
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prisma }],
  exports: [PrismaService],
})
class StubDatabaseModule {}

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubDatabaseModule, HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prisma.ping.mockReset();
  });

  describe('GET /health/live', () => {
    it('returns 200 without touching the database', async () => {
      prisma.ping.mockRejectedValue(new Error('database is down'));

      const res = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(prisma.ping).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when the database is reachable', async () => {
      prisma.ping.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.info.database.status).toBe('up');
    });

    it('returns 503 when the database is unreachable, without leaking the error', async () => {
      prisma.ping.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.error.database).toEqual({
        status: 'down',
        reason: 'unreachable',
      });
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });
  });

  it('no longer serves the placeholder GET /health route', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });
});
