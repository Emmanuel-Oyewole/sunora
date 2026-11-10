import type { AppEnv } from '../../src/shared/config/env.js';
import { loadEnv } from '../../src/shared/config/env.js';
import type { UnitOfWork } from '../../src/shared/database/unit-of-work.js';
import type { ConversationsRepository } from '../../src/modules/conversations/conversations.repository.js';
import { ConversationsService } from '../../src/modules/conversations/conversations.service.js';
import { DEFAULT_RUNNER_OPTIONS, type RunnerOptions } from '../../src/modules/generation/generation.constants.js';
import type { GenerationRepository } from '../../src/modules/generation/generation.repository.js';
import { GenerationRunner } from '../../src/modules/generation/generation-runner.js';
import { GenerationService } from '../../src/modules/generation/generation.service.js';
import { GenerationLiveFeed } from '../../src/modules/generation/live-feed.js';
import { FakeAiProvider } from './fake-ai-provider.js';
import { InMemoryConversations } from './in-memory-conversations.js';
import { InMemoryGeneration } from './in-memory-generation.js';

export const ADA = '0190aaaa-0000-7000-8000-00000000000a';
export const BOB = '0190aaaa-0000-7000-8000-00000000000b';

export const generationEnv = (extra: Record<string, string> = {}): AppEnv =>
  loadEnv({
    POSTGRES_USER: 'u',
    POSTGRES_PASSWORD: 'p',
    POSTGRES_DB: 'd',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    JWT_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
    DEEPSEEK_API_KEY: 'sk-test',
    ...extra,
  });

/** Fast timers so tests do not wait for the production intervals. */
export const FAST_OPTIONS: RunnerOptions = {
  ...DEFAULT_RUNNER_OPTIONS,
  flushIntervalMs: 5,
  heartbeatIntervalMs: 10,
  keepAliveMs: 40,
  shutdownDrainMs: 500,
};

/** The conversations and generation modules wired together over in-memory fakes and a scripted provider. */
export function createGenerationWorld(options: Partial<RunnerOptions> = {}, instanceId = 'instance-1') {
  const env = generationEnv();
  const conversationsWorld = new InMemoryConversations();
  const generationWorld = new InMemoryGeneration();
  const provider = new FakeAiProvider();
  const feed = new GenerationLiveFeed();
  const conversations = new ConversationsService(
    conversationsWorld.repository as unknown as ConversationsRepository,
    conversationsWorld.unitOfWork as unknown as UnitOfWork,
  );
  const repository = generationWorld.repository as unknown as GenerationRepository;
  const runnerOptions = { ...FAST_OPTIONS, ...options };
  const runner = new GenerationRunner(repository, conversations, provider, feed, env, instanceId, runnerOptions);
  const service = new GenerationService(repository, conversations, runner, feed, env, instanceId, runnerOptions);

  return { env, conversationsWorld, generationWorld, repository, provider, feed, conversations, runner, service, instanceId };
}

export type GenerationWorld = ReturnType<typeof createGenerationWorld>;

/** Polls until the condition holds, so tests wait for background work without fixed sleeps. */
export async function waitFor<T>(check: () => T | Promise<T>, what = 'condition', timeoutMs = 2000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
