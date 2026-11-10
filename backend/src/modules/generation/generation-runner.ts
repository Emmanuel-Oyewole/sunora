import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import type { ChunkKind, Generation, GenerationStatus } from '../../generated/prisma/client.js';
import { APP_ENV, type AppEnv } from '../../shared/config/env.js';
import { AppException } from '../../shared/http/app.exception.js';
import { ConversationsFacade } from '../conversations/index.js';
import { buildContext } from './context.builder.js';
import {
  INSTANCE_ID,
  MAX_CHUNK_CHARS,
  MAX_HISTORY_MESSAGES,
  RUNNER_OPTIONS,
  TITLE_MAX_LENGTH,
  TITLE_MAX_OUTPUT_TOKENS,
  TITLE_SOURCE_CHARS,
  type RunnerOptions,
} from './generation.constants.js';
import { GenerationRepository } from './generation.repository.js';
import { GenerationLiveFeed } from './live-feed.js';
import { AiProvider, AiProviderError, type AiStreamEvent } from './providers/ai-provider.port.js';
import { TITLE_SYSTEM_PROMPT } from './system-prompt.js';

interface LiveRun {
  controller: AbortController;
  /** Set when the process is stopping, so the run ends as INTERRUPTED rather than CANCELLED. */
  shuttingDown: boolean;
}

type DoneEvent = Extract<AiStreamEvent, { type: 'done' }>;

/** What a run has produced so far, and the part of it not yet written to the database. */
class RunOutput {
  text = '';
  reasoning = '';
  /** Set if a background write failed; the run checks it and stops. */
  error: unknown;
  private pending: { kind: ChunkKind; text: string }[] = [];
  private pendingChars = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly generationId: string,
    private readonly repository: GenerationRepository,
    private readonly feed: GenerationLiveFeed,
    private readonly options: RunnerOptions,
  ) {}

  add(kind: ChunkKind, text: string): void {
    if (kind === 'TEXT') this.text += text;
    else this.reasoning += text;

    const last = this.pending.at(-1);
    if (last?.kind === kind) last.text += text;
    else this.pending.push({ kind, text });
    this.pendingChars += text.length;

    if (this.pendingChars >= this.options.flushMaxChars) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.options.flushIntervalMs);
    }
  }

  /** Writes what is waiting, in order. Safe to call from a timer and from the run at once. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(async () => {
      const batch = this.pending;
      this.pending = [];
      this.pendingChars = 0;
      if (batch.length === 0) return;

      const rows = batch.flatMap(({ kind, text }) =>
        splitText(text, MAX_CHUNK_CHARS).map((piece) => ({
          generationId: this.generationId,
          seq: ++this.seq,
          kind,
          text: piece,
        })),
      );
      try {
        await this.repository.appendChunks(rows);
      } catch (error) {
        this.error = error;
        return;
      }
      // Published only after the write, so a browser that replays never sees an event the database lacks.
      for (const row of rows) this.feed.publish(this.generationId, { type: 'chunk', seq: row.seq, kind: row.kind, text: row.text });
    });
    return this.chain;
  }
}

function splitText(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

/**
 * Runs generations in this process, independently of any browser connection.
 * A generation is claimed (PENDING to RUNNING), streamed from the AI provider,
 * saved as chunks while it runs, and finished with a conditional status change.
 *
 * Logs only ids and stable codes, never prompts, answers or reasoning.
 */
@Injectable()
export class GenerationRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GenerationRunner.name);
  private readonly live = new Map<string, LiveRun>();
  private readonly background = new Set<Promise<void>>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: GenerationRepository,
    private readonly conversations: ConversationsFacade,
    private readonly provider: AiProvider,
    private readonly feed: GenerationLiveFeed,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    @Inject(RUNNER_OPTIONS) private readonly options: RunnerOptions,
  ) {}

  isRunning(generationId: string): boolean {
    return this.live.has(generationId);
  }

  /** Starts it in the background and returns at once. */
  start(generation: Generation): void {
    this.track(
      this.run(generation).catch(() => {
        // run() records its own failures; this only keeps an unexpected one from going unhandled.
        this.logger.error(`Generation ${generation.id} stopped unexpectedly`);
      }),
    );
  }

  /** Stops the provider call. The run then ends as CANCELLED. Returns false if it is not running here. */
  abort(generationId: string): boolean {
    const run = this.live.get(generationId);
    run?.controller.abort();
    return run !== undefined;
  }

  async beforeApplicationShutdown(): Promise<void> {
    for (const run of this.live.values()) {
      run.shuttingDown = true;
      run.controller.abort();
    }
    const drained = Promise.allSettled(this.background);
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, this.options.shutdownDrainMs).unref())]);
  }

  private async run(generation: Generation): Promise<void> {
    if (!(await this.repository.claimRun(generation.id, this.instanceId, new Date()))) return; // cancelled before it started

    const run: LiveRun = { controller: new AbortController(), shuttingDown: false };
    this.live.set(generation.id, run);
    this.ensureHeartbeat();
    // A cancel that arrived between the claim and now found nothing to abort, so honour it here.
    if ((await this.repository.find(generation.id))?.cancelRequestedAt) run.controller.abort();
    const output = new RunOutput(generation.id, this.repository, this.feed, this.options);

    try {
      const history = await this.conversations.getPathTo(
        generation.userId,
        generation.conversationId,
        generation.userMessageId,
        MAX_HISTORY_MESSAGES,
      );
      const maxTokens = generation.thinking
        ? this.env.generation.maxOutputTokensThinking
        : this.env.generation.maxOutputTokens;

      let done: DoneEvent | undefined;
      for await (const event of this.provider.stream({
        messages: buildContext(history, this.env.generation.contextCharBudget),
        maxOutputTokens: maxTokens,
        thinking: generation.thinking,
        userId: generation.userId,
        signal: run.controller.signal,
      })) {
        if (output.error) throw output.error;
        if (event.type === 'done') done = event;
        else output.add(event.type === 'text' ? 'TEXT' : 'REASONING', event.text);
      }

      await output.flush();
      if (output.error) throw output.error;
      if (!done) throw new AiProviderError('PROVIDER_INTERRUPTED', 'The answer ended early', true);

      await this.complete(generation, output, done, history.at(-1)?.content ?? '');
    } catch (error) {
      await output.flush();
      if (output.error !== undefined && error === output.error) {
        // Chunks could not be saved (UJ-038). Say so, rather than showing an answer we could not keep.
        this.logger.error(`Generation ${generation.id} could not save its output (${errorName(error)})`);
        await this.finish(generation.id, 'FAILED', 'PERSISTENCE_FAILED');
      } else {
        await this.fail(generation, error, run.shuttingDown);
      }
    } finally {
      this.live.delete(generation.id);
      if (this.live.size === 0) this.stopHeartbeat();
    }
  }

  private async complete(generation: Generation, output: RunOutput, done: DoneEvent, question: string): Promise<void> {
    if (output.text.trim() === '') {
      await this.finish(generation.id, 'FAILED', done.finishReason === 'content_filter' ? 'CONTENT_FILTERED' : 'EMPTY_ANSWER');
      return;
    }

    let depth: number;
    let messageId: string;
    try {
      const message = await this.conversations.appendAssistantMessage(generation.userId, {
        conversationId: generation.conversationId,
        parentId: generation.userMessageId,
        content: output.text,
        reasoning: output.reasoning || null,
        generationId: generation.id,
      });
      ({ depth, id: messageId } = message);
    } catch (error) {
      if (error instanceof AppException && ['CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND'].includes(error.code)) {
        await this.finish(generation.id, 'CANCELLED', 'CONVERSATION_DELETED');
      } else if (error instanceof AppException && error.code === 'INVALID_MESSAGE') {
        await this.finish(generation.id, 'FAILED', 'ANSWER_TOO_LONG');
      } else {
        this.logger.error(`Generation ${generation.id} could not save its answer (${errorName(error)})`);
        await this.finish(generation.id, 'FAILED', 'SAVE_FAILED');
      }
      return;
    }

    await this.finish(generation.id, 'COMPLETED', null, { assistantMessageId: messageId, finishReason: done.finishReason });

    // The first answer of a conversation gets an automatic title, in the background.
    if (depth === 1) this.track(this.generateTitle(generation, question, output.text));
  }

  private async fail(generation: Generation, error: unknown, shuttingDown: boolean): Promise<void> {
    if (error instanceof AiProviderError) {
      if (error.code !== 'CANCELLED') return this.finish(generation.id, 'FAILED', error.code);
      return shuttingDown
        ? this.finish(generation.id, 'INTERRUPTED', 'SERVER_SHUTDOWN')
        : this.finish(generation.id, 'CANCELLED', null);
    }
    if (error instanceof AppException && ['CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND'].includes(error.code)) {
      return this.finish(generation.id, 'CANCELLED', 'CONVERSATION_DELETED');
    }
    this.logger.error(`Generation ${generation.id} failed unexpectedly (${errorName(error)})`);
    return this.finish(generation.id, 'FAILED', 'INTERNAL_ERROR');
  }

  /** Moves RUNNING to a final status, then tells connected browsers whatever the status ended up being. */
  private async finish(
    generationId: string,
    to: GenerationStatus,
    errorCode: string | null,
    patch: { assistantMessageId?: string; finishReason?: string } = {},
  ): Promise<void> {
    try {
      await this.repository.transition(generationId, 'RUNNING', to, new Date(), { errorCode, ...patch });
      const current = await this.repository.find(generationId);
      if (current) {
        this.feed.publish(generationId, {
          type: 'status',
          status: current.status,
          errorCode: current.errorCode,
          assistantMessageId: current.assistantMessageId,
        });
      }
    } catch (error) {
      // The database is unreachable. The restart sweep will settle this generation.
      this.logger.error(`Generation ${generationId} could not be marked ${to} (${errorName(error)})`);
    }
  }

  private async generateTitle(generation: Generation, question: string, answer: string): Promise<void> {
    try {
      let title = '';
      for await (const event of this.provider.stream({
        messages: [
          { role: 'system', content: [{ type: 'text', text: TITLE_SYSTEM_PROMPT }] },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Question: ${question.slice(0, TITLE_SOURCE_CHARS)}\n\nAnswer: ${answer.slice(0, TITLE_SOURCE_CHARS)}`,
              },
            ],
          },
        ],
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        thinking: false,
        userId: generation.userId,
      })) {
        if (event.type === 'text') title += event.text;
      }
      const cleaned = cleanTitle(title);
      if (cleaned) await this.conversations.applyGeneratedTitle(generation.conversationId, cleaned);
    } catch (error) {
      // A missing title is harmless: the conversation keeps its default one.
      this.logger.warn(`Title for conversation ${generation.conversationId} was not generated (${errorName(error)})`);
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.repository.heartbeat([...this.live.keys()], this.instanceId, new Date()).catch(() => {
        this.logger.warn('Generation heartbeat could not be written');
      });
    }, this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private track(promise: Promise<void>): void {
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise));
  }
}

/** Models like to wrap titles in quotes or end them with a full stop. */
export function cleanTitle(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, '');
  return cleaned.slice(0, TITLE_MAX_LENGTH).trim();
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');
