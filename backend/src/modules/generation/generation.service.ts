import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Generation, GenerationStatus, GenerationTrigger } from '../../generated/prisma/client.js';
import { APP_ENV, type AppEnv } from '../../shared/config/env.js';
import { isUniqueViolation } from '../../shared/database/errors.js';
import { ConversationsFacade } from '../conversations/index.js';
import { AsyncQueue, TIMED_OUT } from './async-queue.js';
import {
  CHUNK_PAGE_SIZE,
  IDEMPOTENCY_STALE_MS,
  IDEMPOTENCY_TTL_MS,
  INSTANCE_ID,
  MAX_ACTIVE_PER_USER,
  PROVIDER_NAME,
  RUNNER_OPTIONS,
  type RunnerOptions,
} from './generation.constants.js';
import {
  generationNotFound,
  idempotencyKeyReused,
  notLatestAttempt,
  notRetryable,
  requestInProgress,
  tooManyActiveGenerations,
} from './generation.errors.js';
import { GenerationRepository } from './generation.repository.js';
import { RETRYABLE_STATUSES, isActive, isTerminal } from './generation.state.js';
import { GenerationRunner } from './generation-runner.js';
import { GenerationLiveFeed, type LiveEvent } from './live-feed.js';

export interface SubmitInput {
  conversationId?: string;
  parentId?: string | null;
  content: string;
  thinking?: boolean;
}

export interface SubmitResult {
  generationId: string;
  conversationId: string;
  userMessageId: string;
  status: GenerationStatus;
}

export interface GenerationView {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  attemptNumber: number;
  trigger: GenerationTrigger;
  status: GenerationStatus;
  thinking: boolean;
  finishReason: string | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface GenerationDetail extends GenerationView {
  /** The last chunk number written. A browser that has rendered up to here has seen everything so far. */
  lastSeq: number;
  /** What was produced before it stopped. Only for a failed, stopped or interrupted generation. */
  partial: { text: string; reasoning: string } | null;
}

export type StreamItem = LiveEvent | { type: 'keepalive' };

const toView = (g: Generation): GenerationView => ({
  id: g.id,
  conversationId: g.conversationId,
  userMessageId: g.userMessageId,
  assistantMessageId: g.assistantMessageId,
  attemptNumber: g.attemptNumber,
  trigger: g.trigger,
  status: g.status,
  thinking: g.thinking,
  finishReason: g.finishReason,
  errorCode: g.errorCode,
  createdAt: g.createdAt,
  startedAt: g.startedAt,
  finishedAt: g.finishedAt,
});

const toSubmitResult = (g: Generation): SubmitResult => ({
  generationId: g.id,
  conversationId: g.conversationId,
  userMessageId: g.userMessageId,
  status: g.status,
});

const statusItem = (g: Generation): LiveEvent => ({
  type: 'status',
  status: g.status,
  errorCode: g.errorCode,
  assistantMessageId: g.assistantMessageId,
});

@Injectable()
export class GenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GenerationService.name);

  constructor(
    private readonly repository: GenerationRepository,
    private readonly conversations: ConversationsFacade,
    private readonly runner: GenerationRunner,
    private readonly feed: GenerationLiveFeed,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    @Inject(RUNNER_OPTIONS) private readonly options: RunnerOptions,
  ) {}

  /** Restart detection: anything still active that this process does not own was left behind by a dead one. */
  async onApplicationBootstrap(): Promise<void> {
    const count = await this.repository.interruptForeign(this.instanceId, new Date());
    if (count > 0) this.logger.warn(`${count} generation(s) left by a previous run were marked INTERRUPTED`);
  }

  /**
   * Saves the user's message, creates the first attempt and starts it. The
   * idempotency key makes this safe to repeat: the same key and body gives the
   * same result. The message and the generation live in different modules, so
   * this is not one transaction; a crash between the steps is finished by the
   * client's retry with the same key.
   */
  async submit(userId: string, key: string, input: SubmitInput): Promise<SubmitResult> {
    const now = new Date();
    const requestHash = hashRequest(input);
    const claim = await this.repository.claimKey({
      userId,
      key,
      requestHash,
      now,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
    });
    const row = claim.row;

    if (!claim.claimed) {
      if (row.requestHash !== requestHash) throw idempotencyKeyReused();
      if (row.generationId) {
        const existing = await this.repository.find(row.generationId);
        if (existing) return toSubmitResult(existing);
      }
      const staleBefore = new Date(now.getTime() - IDEMPOTENCY_STALE_MS);
      if (!(await this.repository.takeOverClaim(row.id, staleBefore, now))) throw requestInProgress();
    }

    let conversationId = row.conversationId;
    let messageId = row.messageId;
    if (!conversationId || !messageId) {
      try {
        await this.assertUnderActiveCap(userId);
        const appended = await this.conversations.appendUserMessage(userId, {
          conversationId: input.conversationId,
          parentId: input.parentId,
          content: input.content,
        });
        conversationId = appended.conversationId;
        messageId = appended.message.id;
      } catch (error) {
        await this.repository.releaseClaim(row.id); // nothing was saved, so the key can be used again
        throw error;
      }
      await this.repository.rememberMessage(row.id, conversationId, messageId);
    }

    const generation = await this.createAttempt({
      userId,
      conversationId,
      userMessageId: messageId,
      attemptNumber: 1,
      trigger: 'INITIAL',
      thinking: input.thinking ?? false,
    });
    await this.repository.rememberGeneration(row.id, generation.id);
    this.runner.start(generation);
    return toSubmitResult(generation);
  }

  /** Starts a new attempt for the same message after a failure, an interruption or a stop. */
  async retry(userId: string, id: string): Promise<GenerationView> {
    const generation = await this.requireOwned(userId, id);
    const latest = await this.repository.latestAttempt(generation.userMessageId);
    if (latest && latest.id !== generation.id) throw notLatestAttempt();
    if (!RETRYABLE_STATUSES.includes(generation.status)) throw notRetryable();
    await this.assertUnderActiveCap(userId);

    let attempt: Generation;
    try {
      attempt = await this.repository.create({
        userId,
        conversationId: generation.conversationId,
        userMessageId: generation.userMessageId,
        attemptNumber: generation.attemptNumber + 1,
        trigger: 'RETRY',
        thinking: generation.thinking,
        provider: PROVIDER_NAME,
        model: this.env.ai.deepseek.model,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw notLatestAttempt(); // a concurrent retry got there first
      throw error;
    }
    this.runner.start(attempt);
    return toView(attempt);
  }

  /** A request to stop, not a confirmation: the returned status says what has happened so far. */
  async cancel(userId: string, id: string): Promise<GenerationView> {
    const generation = await this.requireOwned(userId, id);
    if (isActive(generation.status)) {
      const now = new Date();
      await this.repository.requestCancel(id, userId, now);
      if (!this.runner.abort(id)) {
        // Not running in this process: it has not started yet. A run that starts later sees the cancel.
        await this.repository.transition(id, 'PENDING', 'CANCELLED', now);
      }
    }
    return toView((await this.repository.find(id)) ?? generation);
  }

  async get(userId: string, id: string): Promise<GenerationDetail> {
    const generation = await this.requireOwned(userId, id);
    const stopped = ['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(generation.status);
    return {
      ...toView(generation),
      lastSeq: await this.repository.lastSeq(id),
      partial: stopped ? await this.repository.partialOutput(id) : null,
    };
  }

  /** The latest attempts in a conversation, newest first. Used to recover after a refresh. */
  async list(userId: string, conversationId: string, limit: number): Promise<GenerationView[]> {
    return (await this.repository.listForConversation(userId, conversationId, limit)).map(toView);
  }

  /**
   * Checks access, then returns the event stream. Checking first lets the
   * caller answer 404 before it sends any streaming headers.
   */
  async openStream(
    userId: string,
    id: string,
    afterSeq: number,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<StreamItem>> {
    await this.requireOwned(userId, id);
    return this.stream(id, afterSeq, signal);
  }

  /**
   * Replays what was saved after `afterSeq`, then follows the live output until
   * the generation ends. Disconnecting stops this stream only; the generation
   * keeps running.
   */
  private async *stream(id: string, afterSeq: number, signal?: AbortSignal): AsyncGenerator<StreamItem> {
    // Subscribe before reading, so nothing written in between is missed. Duplicates are dropped by seq.
    const queue = new AsyncQueue<LiveEvent | { type: 'close' }>();
    const unsubscribe = this.feed.subscribe(id, (event) => queue.push(event));
    const onAbort = () => queue.push({ type: 'close' }); // wakes a stream that is waiting, when the client leaves
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) return;
      const first = await this.repository.find(id);
      if (!first) return;
      if (isTerminal(first.status)) {
        // Everything was written before it finished, so replay it all and end with the final status.
        yield* this.replay(id, afterSeq);
        yield statusItem(first);
        return;
      }
      yield statusItem(first);

      let sent = yield* this.replay(id, afterSeq);

      let idleTicks = 0;
      for (;;) {
        const item = await queue.next(this.options.keepAliveMs);
        if (item !== TIMED_OUT && item.type === 'close') return;

        if (item === TIMED_OUT) {
          const fresh = await this.repository.find(id);
          if (!fresh) return;
          if (isTerminal(fresh.status)) {
            sent = yield* this.replay(id, sent);
            yield statusItem(fresh);
            return;
          }
          // Active in the database but not running here: nothing will ever arrive, so end and let the client re-check.
          idleTicks = this.runner.isRunning(id) ? 0 : idleTicks + 1;
          if (idleTicks >= 2) return;
          yield { type: 'keepalive' };
          continue;
        }

        if (item.type === 'chunk') {
          if (item.seq <= sent) continue;
          if (item.seq > sent + 1) {
            sent = yield* this.replay(id, sent); // a gap: fill it from the database
            if (item.seq <= sent) continue;
          }
          sent = item.seq;
          yield item;
        } else if (isTerminal(item.status)) {
          sent = yield* this.replay(id, sent);
          yield item;
          return;
        } else {
          yield item;
        }
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Yields saved chunks after `afterSeq` in order and returns the last seq it sent. */
  private async *replay(id: string, afterSeq: number): AsyncGenerator<StreamItem, number> {
    let sent = afterSeq;
    for (;;) {
      const rows = await this.repository.chunksAfter(id, sent, CHUNK_PAGE_SIZE);
      for (const row of rows) {
        yield { type: 'chunk', seq: row.seq, kind: row.kind, text: row.text };
        sent = row.seq;
      }
      if (rows.length < CHUNK_PAGE_SIZE) return sent;
    }
  }

  private async createAttempt(data: {
    userId: string;
    conversationId: string;
    userMessageId: string;
    attemptNumber: number;
    trigger: GenerationTrigger;
    thinking: boolean;
  }): Promise<Generation> {
    try {
      return await this.repository.create({ ...data, provider: PROVIDER_NAME, model: this.env.ai.deepseek.model });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A repeated submit already created this attempt. Use it instead of making a second one.
      const existing = await this.repository.findAttempt(data.userMessageId, data.attemptNumber);
      if (existing) return existing;
      throw error;
    }
  }

  private async assertUnderActiveCap(userId: string): Promise<void> {
    if ((await this.repository.countActive(userId)) >= MAX_ACTIVE_PER_USER) throw tooManyActiveGenerations();
  }

  private async requireOwned(userId: string, id: string): Promise<Generation> {
    const generation = await this.repository.findOwned(id, userId);
    if (!generation) throw generationNotFound();
    return generation;
  }
}

function hashRequest(input: SubmitInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.conversationId ?? null, input.parentId ?? null, input.content, input.thinking ?? false]))
    .digest('hex');
}
