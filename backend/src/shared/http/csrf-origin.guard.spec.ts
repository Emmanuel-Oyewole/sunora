import type { ExecutionContext } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { CsrfOriginGuard } from './csrf-origin.guard.js';

const source = {
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'd',
  DB_HOST: 'h',
  DB_PORT: '5432',
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
  WEB_URL: 'http://localhost:3000',
};
const env = loadEnv(source);
const productionEnv = loadEnv({
  ...source,
  NODE_ENV: 'production',
  EMAIL_PROVIDER: 'brevo',
  BREVO_API_KEY: 'k',
  BREVO_SENDER_EMAIL: 'no-reply@sunora.app',
});

function run(method: string, headers: Record<string, string> = {}, appEnv = env) {
  const lower = Object.fromEntries(
    Object.entries({ host: 'localhost:3001', ...headers }).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const req = { method, protocol: 'http', headers: lower, get: (name: string) => lower[name.toLowerCase()] };
  const context = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return () => new CsrfOriginGuard(appEnv).canActivate(context);
}

describe('CsrfOriginGuard', () => {
  it('never blocks safe methods', () => {
    expect(run('GET', { Origin: 'https://evil.example' })()).toBe(true);
    expect(run('OPTIONS')()).toBe(true);
  });

  it('allows a state-changing request from the web app origin', () => {
    expect(run('POST', { Origin: 'http://localhost:3000', Cookie: 'sunora_at=x' })()).toBe(true);
  });

  it('blocks a state-changing request from another origin, with or without cookies', () => {
    expect(run('POST', { Origin: 'https://evil.example' })).toThrowError(/origin is not allowed/);
    expect(run('POST', { Origin: 'null', Cookie: 'sunora_at=x' })).toThrowError(/origin is not allowed/);
  });

  describe('requests from the API own origin (Swagger UI)', () => {
    it('are accepted outside production', () => {
      expect(run('POST', { Origin: 'http://localhost:3001', Cookie: 'a=b' })()).toBe(true);
    });

    it('are rejected in production', () => {
      expect(run('POST', { Origin: 'http://localhost:3001' }, productionEnv)).toThrowError(/origin is not allowed/);
    });

    it('do not open the door to other origins, or to a forged Host', () => {
      expect(run('POST', { Origin: 'https://evil.example' })).toThrowError(/origin is not allowed/);
      expect(run('POST', { Origin: 'http://localhost:3002' })).toThrowError(/origin is not allowed/);
    });
  });

  it('falls back to the Referer when there is no Origin', () => {
    expect(run('POST', { Referer: 'http://localhost:3000/settings', Cookie: 'a=b' })()).toBe(true);
    expect(run('POST', { Referer: 'https://evil.example/page' })).toThrowError(/origin is not allowed/);
    expect(run('POST', { Referer: 'not a url' })).toThrowError(/origin is not allowed/);
  });

  it('accepts a request with no origin only when it carries no cookies', () => {
    expect(run('POST')()).toBe(true); // curl, server-to-server
    expect(run('POST', { Cookie: 'sunora_at=x' })).toThrowError(/origin is missing/);
  });
});
