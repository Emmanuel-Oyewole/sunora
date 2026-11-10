export const PROVIDER_NAME = 'deepseek';

/** Longest prompt the API accepts. */
export const MAX_PROMPT_LENGTH = 32_000;
/** Generations a user can have running at once. */
export const MAX_ACTIVE_PER_USER = 2;
/** The most history messages read before the character budget trims them. */
export const MAX_HISTORY_MESSAGES = 200;

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A submit that has not finished after this long is treated as abandoned and can be taken over. */
export const IDEMPOTENCY_STALE_MS = 30_000;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const TITLE_MAX_OUTPUT_TOKENS = 24;
export const TITLE_MAX_LENGTH = 60;
/** How much of the question and the answer the title prompt sees. */
export const TITLE_SOURCE_CHARS = 500;

export const CHUNK_PAGE_SIZE = 500;
/** One chunk row holds at most this much text (the database allows 20000). */
export const MAX_CHUNK_CHARS = 8000;

export interface RunnerOptions {
  /** A batch of output is written to the database at least this often. */
  flushIntervalMs: number;
  /** ...or as soon as this much text is waiting. */
  flushMaxChars: number;
  heartbeatIntervalMs: number;
  keepAliveMs: number;
  /** How long a shutdown waits for running generations to be marked. */
  shutdownDrainMs: number;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  flushIntervalMs: 200,
  flushMaxChars: 2000,
  heartbeatIntervalMs: 5000,
  keepAliveMs: 15_000,
  shutdownDrainMs: 10_000,
};

export const RUNNER_OPTIONS = Symbol('GENERATION_RUNNER_OPTIONS');
/** Identifies this process, so a restart can tell which generations were left behind. */
export const INSTANCE_ID = Symbol('GENERATION_INSTANCE_ID');
