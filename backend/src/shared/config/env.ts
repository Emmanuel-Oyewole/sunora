export const APP_ENV = Symbol('APP_ENV');

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppEnv {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly database: {
    /** Connection string. Contains the password: never log it or expose it. */
    readonly url: string;
  };
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const DEFAULT_PORT = 3000;

/**
 * Reads and validates environment variables once, so the app fails at startup
 * with a clear message instead of failing later at first use. Error messages
 * name the offending variables but never include their values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const errors: string[] = [];

  const required = (key: string): string => {
    const value = source[key]?.trim();
    if (!value) {
      errors.push(`${key} is required`);
      return '';
    }
    return value;
  };

  const port = (key: string, fallback?: number): number => {
    const raw = source[key]?.trim();
    if (!raw) {
      if (fallback === undefined) errors.push(`${key} is required`);
      return fallback ?? 0;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      errors.push(`${key} must be an integer between 1 and 65535`);
      return 0;
    }
    return value;
  };

  const rawNodeEnv = source.NODE_ENV?.trim() || 'development';
  if (!NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
  }

  const appPort = port('PORT', DEFAULT_PORT);
  const dbUser = required('POSTGRES_USER');
  const dbPassword = required('POSTGRES_PASSWORD');
  const dbName = required('POSTGRES_DB');
  const dbHost = required('DB_HOST');
  const dbPort = port('DB_PORT');

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return {
    nodeEnv: rawNodeEnv as NodeEnv,
    port: appPort,
    database: {
      url: buildDatabaseUrl({
        user: dbUser,
        password: dbPassword,
        host: dbHost,
        port: dbPort,
        name: dbName,
      }),
    },
  };
}

function buildDatabaseUrl(parts: {
  user: string;
  password: string;
  host: string;
  port: number;
  name: string;
}): string {
  // The URL setters percent-encode credentials, so passwords containing
  // characters such as "@", "/" or "#" do not corrupt the connection string.
  const url = new URL('postgresql://placeholder');
  url.username = parts.user;
  url.password = parts.password;
  url.hostname = parts.host;
  url.port = String(parts.port);
  url.pathname = `/${parts.name}`;
  return url.toString();
}
