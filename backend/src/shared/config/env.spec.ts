import { loadEnv } from './env.js';

const validSource = {
  POSTGRES_USER: 'sunora',
  POSTGRES_PASSWORD: 'secret',
  POSTGRES_DB: 'sunora_db',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(validSource);

    expect(env.nodeEnv).toBe('development');
    expect(env.port).toBe(3000);
    expect(env.database.url).toBe(
      'postgresql://sunora:secret@localhost:5432/sunora_db',
    );
  });

  it('reads PORT and NODE_ENV when provided', () => {
    const env = loadEnv({ ...validSource, PORT: '3001', NODE_ENV: 'production' });

    expect(env.port).toBe(3001);
    expect(env.nodeEnv).toBe('production');
  });

  it('percent-encodes special characters in the password', () => {
    const env = loadEnv({ ...validSource, POSTGRES_PASSWORD: 'p@ss/w:rd#1' });
    const url = new URL(env.database.url);

    expect(decodeURIComponent(url.password)).toBe('p@ss/w:rd#1');
    expect(url.hostname).toBe('localhost');
  });

  it('lists every missing variable without echoing any values', () => {
    expect(() => loadEnv({ POSTGRES_PASSWORD: 'super-secret' })).toThrowError(
      /POSTGRES_USER is required[\s\S]*POSTGRES_DB is required[\s\S]*DB_HOST is required[\s\S]*DB_PORT is required/,
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
});
