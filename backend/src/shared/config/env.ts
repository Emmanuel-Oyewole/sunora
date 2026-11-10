export const APP_ENV = Symbol('APP_ENV');

export type NodeEnv = 'development' | 'test' | 'production';
export type EmailProviderName = 'console' | 'brevo';

export interface AppEnv {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  /** Web app origin (no path). Used for CORS, CSRF checks and email links. */
  readonly webOrigin: string;
  readonly database: {
    /** Connection string with the password. Never log it. */
    readonly url: string;
  };
  readonly auth: {
    /** HS256 signing secret for access tokens. Never log it. */
    readonly jwtSecret: string;
    readonly accessTtlSeconds: number;
    /** Sliding lifetime of a refresh token. */
    readonly refreshTtlSeconds: number;
    /** Absolute lifetime of a session; refreshing can never extend past it. */
    readonly sessionMaxAgeSeconds: number;
    /** A rotated refresh token replayed within this window counts as a race (two tabs), not theft. */
    readonly refreshGraceSeconds: number;
    readonly verificationTtlSeconds: number;
    readonly passwordResetTtlSeconds: number;
    /** Minimum gap between two verification or reset emails to one user. */
    readonly resendCooldownSeconds: number;
    readonly cookieSecure: boolean;
  };
  readonly ai: {
    readonly deepseek: {
      /** Never log it. */
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: string;
    };
  };
  readonly generation: {
    /** Cap on one answer when thinking is off. */
    readonly maxOutputTokens: number;
    /** Cap when thinking is on. Reasoning counts against it, so it is larger. */
    readonly maxOutputTokensThinking: number;
    /** How much conversation history (in characters, about 4 per token) is sent to the model. */
    readonly contextCharBudget: number;
  };
  readonly email: {
    readonly provider: EmailProviderName;
    readonly brevo?: {
      /** Never log it. */
      readonly apiKey: string;
      readonly senderEmail: string;
      readonly senderName: string;
    };
  };
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const EMAIL_PROVIDERS: readonly EmailProviderName[] = ['console', 'brevo'];
const DEFAULT_PORT = 3000;
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Reads and validates env vars once, so the app fails at startup with a clear
 * message. Errors name the variable but never its value.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const errors: string[] = [];

  const text = (key: string): string | undefined => source[key]?.trim() || undefined;

  const required = (key: string): string => {
    const value = text(key);
    if (!value) {
      errors.push(`${key} is required`);
      return '';
    }
    return value;
  };

  const integer = (
    key: string,
    fallback: number | undefined,
    min: number,
    max: number,
  ): number => {
    const raw = text(key);
    if (!raw) {
      if (fallback === undefined) errors.push(`${key} is required`);
      return fallback ?? 0;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback ?? 0;
    }
    return value;
  };

  const oneOf = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const raw = text(key) ?? fallback;
    if (!allowed.includes(raw as T)) {
      errors.push(`${key} must be one of: ${allowed.join(', ')}`);
      return fallback;
    }
    return raw as T;
  };

  const nodeEnv = oneOf('NODE_ENV', NODE_ENVS, 'development');
  const appPort = integer('PORT', DEFAULT_PORT, 1, 65535);

  const dbUser = required('POSTGRES_USER');
  const dbPassword = required('POSTGRES_PASSWORD');
  const dbName = required('POSTGRES_DB');
  const dbHost = required('DB_HOST');
  const dbPort = integer('DB_PORT', undefined, 1, 65535);

  const webOrigin = parseOrigin('WEB_URL', text('WEB_URL') ?? 'http://localhost:3000', errors);

  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }

  const auth = {
    jwtSecret,
    accessTtlSeconds: integer('ACCESS_TOKEN_TTL_SECONDS', 15 * 60, 60, 24 * 3600),
    refreshTtlSeconds: integer('REFRESH_TOKEN_TTL_SECONDS', 14 * 24 * 3600, 3600, 90 * 24 * 3600),
    sessionMaxAgeSeconds: integer('SESSION_MAX_AGE_SECONDS', 30 * 24 * 3600, 3600, 365 * 24 * 3600),
    refreshGraceSeconds: integer('REFRESH_GRACE_SECONDS', 10, 0, 60),
    verificationTtlSeconds: integer('EMAIL_VERIFICATION_TTL_SECONDS', 24 * 3600, 300, 7 * 24 * 3600),
    passwordResetTtlSeconds: integer('PASSWORD_RESET_TTL_SECONDS', 30 * 60, 300, 24 * 3600),
    resendCooldownSeconds: integer('RESEND_COOLDOWN_SECONDS', 60, 0, 3600),
    cookieSecure: nodeEnv === 'production',
  };

  const deepseek = {
    apiKey: required('DEEPSEEK_API_KEY'),
    baseUrl: parseHttpUrl('DEEPSEEK_BASE_URL', text('DEEPSEEK_BASE_URL') ?? DEFAULT_DEEPSEEK_BASE_URL, errors),
    model: text('DEEPSEEK_MODEL') ?? DEFAULT_DEEPSEEK_MODEL,
  };

  const generation = {
    maxOutputTokens: integer('GENERATION_MAX_OUTPUT_TOKENS', 4096, 256, 65536),
    maxOutputTokensThinking: integer('GENERATION_MAX_OUTPUT_TOKENS_THINKING', 16384, 256, 131072),
    contextCharBudget: integer('GENERATION_CONTEXT_CHAR_BUDGET', 60_000, 2000, 1_000_000),
  };

  const emailProvider = oneOf('EMAIL_PROVIDER', EMAIL_PROVIDERS, 'console');
  if (emailProvider === 'console' && nodeEnv === 'production') {
    errors.push('EMAIL_PROVIDER=console is not allowed when NODE_ENV=production');
  }
  let brevo: AppEnv['email']['brevo'];
  if (emailProvider === 'brevo') {
    const apiKey = required('BREVO_API_KEY');
    const senderEmail = required('BREVO_SENDER_EMAIL');
    if (senderEmail && !senderEmail.includes('@')) {
      errors.push('BREVO_SENDER_EMAIL must be an email address');
    }
    brevo = { apiKey, senderEmail, senderName: text('BREVO_SENDER_NAME') ?? 'Sunora' };
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return {
    nodeEnv,
    port: appPort,
    webOrigin,
    database: {
      url: buildDatabaseUrl({
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort,
        name: dbName,
      }),
    },
    auth,
    ai: { deepseek },
    generation,
    email: { provider: emailProvider, brevo },
  };
}

function parseOrigin(key: string, value: string, errors: string[]): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url.origin;
  } catch {
    errors.push(`${key} must be an http(s) URL`);
    return '';
  }
}

function parseHttpUrl(key: string, value: string, errors: string[]): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url.toString().replace(/\/$/, '');
  } catch {
    errors.push(`${key} must be an http(s) URL`);
    return '';
  }
}

function buildDatabaseUrl(parts: {
  user: string;
  password: string;
  host: string;
  port: number;
  name: string;
}): string {
  // URL setters percent-encode credentials, so "@", "/" or "#" in a password
  // don't break the connection string.
  const url = new URL('postgresql://placeholder');
  url.username = parts.user;
  url.password = parts.password;
  url.hostname = parts.host;
  url.port = String(parts.port);
  url.pathname = `/${parts.name}`;
  return url.toString();
}
