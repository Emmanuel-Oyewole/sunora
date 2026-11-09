import { backoffDelay, withRetry, type RetryPolicy } from './retry.js';

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 2_000 };

describe('backoffDelay', () => {
  it('grows exponentially up to the cap, with full jitter', () => {
    const atMax = () => 0.999999;
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(policy, n, atMax))).toEqual([499, 999, 1999, 1999, 1999]);
    expect(backoffDelay(policy, 3, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  const retryable = { isRetryable: () => true, random: () => 1 };

  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn();
    const result = await withRetry(() => Promise.resolve('ok'), { ...policy, sleep }, retryable);
    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries retryable failures with growing delays, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, { ...policy, sleep }, retryable)).resolves.toBe('ok');

    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockRejectedValue(new Error('still down'));

    await expect(withRetry(operation, { ...policy, sleep }, retryable)).rejects.toThrow('still down');
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('does not retry errors the caller marks as permanent', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('bad request'));

    await expect(
      withRetry(operation, { ...policy, sleep: vi.fn() }, { isRetryable: () => false }),
    ).rejects.toThrow('bad request');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
