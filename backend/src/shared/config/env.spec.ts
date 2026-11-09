import { loadEnv } from './env.js';

const validSource = {
  POSTGRES_USER: 'sunora',
  POSTGRES_PASSWORD: 'secret',
  POSTGRES_DB: 'sunora_db',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(validSource);

    expect(env.nodeEnv).toBe('development');
    expect(env.port).toBe(3000);
    expect(env.webOrigin).toBe('http://localhost:3000');
    expect(env.database.url).toBe(
      'postgresql://sunora:secret@localhost:5432/sunora_db',
    );
    expect(env.auth.accessTtlSeconds).toBe(900);
    expect(env.auth.refreshGraceSeconds).toBe(10);
    expect(env.auth.cookieSecure).toBe(false);
    expect(env.email.provider).toBe('console');
  });

  it('reads PORT and NODE_ENV when provided', () => {
    const env = loadEnv({
      ...validSource,
      PORT: '3001',
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'key',
      BREVO_SENDER_EMAIL: 'no-reply@sunora.app',
    });

    expect(env.port).toBe(3001);
    expect(env.nodeEnv).toBe('production');
    expect(env.auth.cookieSecure).toBe(true);
  });

  it('percent-encodes special characters in the password', () => {
    const env = loadEnv({ ...validSource, POSTGRES_PASSWORD: 'p@ss/w:rd#1' });
    const url = new URL(env.database.url);

    expect(decodeURIComponent(url.password)).toBe('p@ss/w:rd#1');
    expect(url.hostname).toBe('localhost');
  });

  it('lists every missing variable without echoing any values', () => {
    expect(() => loadEnv({ POSTGRES_PASSWORD: 'super-secret' })).toThrowError(
      /POSTGRES_USER is required[\s\S]*POSTGRES_DB is required[\s\S]*DB_HOST is required[\s\S]*DB_PORT is required[\s\S]*JWT_SECRET is required/,
    );
    expect(() => loadEnv({ POSTGRES_PASSWORD: 'super-secret' })).not.toThrowError(
      /super-secret/,
    );
  });

  it.each(['0', '70000', 'abc', '3.5'])('rejects invalid port %s', (port) => {
    expect(() => loadEnv({ ...validSource, PORT: port })).toThrowError(
      /PORT must be an integer/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...validSource, NODE_ENV: 'staging' })).toThrowError(
      /NODE_ENV must be one of/,
    );
  });

  describe('auth settings', () => {
    it('rejects a JWT secret that is too short, without echoing it', () => {
      const attempt = () => loadEnv({ ...validSource, JWT_SECRET: 'too-short' });

      expect(attempt).toThrowError(/JWT_SECRET must be at least 32 characters/);
      expect(attempt).not.toThrowError(/too-short/);
    });

    it('reads token lifetimes and rejects out-of-range values', () => {
      expect(loadEnv({ ...validSource, ACCESS_TOKEN_TTL_SECONDS: '300' }).auth.accessTtlSeconds).toBe(300);
      expect(() => loadEnv({ ...validSource, ACCESS_TOKEN_TTL_SECONDS: '5' })).toThrowError(
        /ACCESS_TOKEN_TTL_SECONDS must be an integer between/,
      );
    });

    it('normalises WEB_URL to an origin and rejects non-http URLs', () => {
      expect(loadEnv({ ...validSource, WEB_URL: 'https://app.sunora.dev/some/path/' }).webOrigin).toBe(
        'https://app.sunora.dev',
      );
      expect(() => loadEnv({ ...validSource, WEB_URL: 'ftp://x' })).toThrowError(/WEB_URL must be an http\(s\) URL/);
    });
  });

  describe('email settings', () => {
    it('forbids the console provider in production', () => {
      expect(() => loadEnv({ ...validSource, NODE_ENV: 'production' })).toThrowError(
        /EMAIL_PROVIDER=console is not allowed/,
      );
    });

    it('requires Brevo credentials when the brevo provider is selected', () => {
      expect(() => loadEnv({ ...validSource, EMAIL_PROVIDER: 'brevo' })).toThrowError(
        /BREVO_API_KEY is required[\s\S]*BREVO_SENDER_EMAIL is required/,
      );
    });

    it('accepts a complete Brevo configuration', () => {
      const env = loadEnv({
        ...validSource,
        EMAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'xkeysib-test',
        BREVO_SENDER_EMAIL: 'no-reply@sunora.app',
      });

      expect(env.email.brevo).toEqual({
        apiKey: 'xkeysib-test',
        senderEmail: 'no-reply@sunora.app',
        senderName: 'Sunora',
      });
    });
  });
});
