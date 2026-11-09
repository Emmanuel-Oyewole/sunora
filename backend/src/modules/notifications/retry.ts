export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export const RETRY_POLICY = Symbol('EMAIL_RETRY_POLICY');

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export interface RetryHooks {
  isRetryable: (error: unknown) => boolean;
  random?: () => number;
}

/** Exponential backoff with full jitter: delay is uniform in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks,
): Promise<T> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = hooks.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= policy.maxAttempts || !hooks.isRetryable(error)) throw error;
      await sleep(backoffDelay(policy, attempt, random));
    }
  }
}
