import { JwtService } from '@nestjs/jwt';
import { loadEnv } from '../../../shared/config/env.js';
import { TokenService } from './token.service.js';

const env = loadEnv({
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'd',
  DB_HOST: 'h',
  DB_PORT: '5432',
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
});
const service = new TokenService(new JwtService({ secret: env.auth.jwtSecret }), env);

describe('TokenService', () => {
  it('generates 256-bit URL-safe tokens whose stored hash is SHA-256', () => {
    const a = service.generateOpaqueToken();
    const b = service.generateOpaqueToken();

    expect(a.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.raw).not.toBe(b.raw);
    expect(service.hashToken(a.raw)).toBe(a.hash); // deterministic, so lookups by hash work
  });

  it('signs an HS256 access token with subject, session id and role', async () => {
    const token = await service.signAccessToken({ userId: 'u1', sessionId: 's1', role: 'ADMIN' });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    const claims = new JwtService({ secret: env.auth.jwtSecret }).verify<Record<string, unknown>>(token);
    expect(claims).toMatchObject({ sub: 'u1', sid: 's1', role: 'ADMIN', iss: 'sunora', aud: 'sunora-web' });
  });

  it('produces tokens that do not verify under a different secret', async () => {
    const token = await service.signAccessToken({ userId: 'u1', sessionId: 's1', role: 'USER' });
    expect(() => new JwtService({ secret: 'x'.repeat(40) }).verify(token)).toThrow();
  });
});
