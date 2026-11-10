import OpenAI from 'openai';
import {
  AiProvider,
  AiProviderError,
  type AiFinishReason,
  type AiRequest,
  type AiStreamEvent,
  type AiUsage,
} from './ai-provider.port.js';

/** No chunk at all within this time means the request is stuck in a queue. */
export const FIRST_TOKEN_TIMEOUT_MS = 60_000;
/** Longest silence allowed between two chunks once the answer has started. */
export const IDLE_TIMEOUT_MS = 60_000;

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** The request body we send. `thinking` and `user_id` are DeepSeek additions to the OpenAI format. */
export interface DeepSeekChatParams {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens: number;
  thinking: { type: 'enabled' | 'disabled' };
  user_id?: string;
}

export interface DeepSeekChunk {
  model: string;
  choices: {
    delta: { content?: string | null; reasoning_content?: string | null };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

/** The part of the SDK client this adapter uses, so tests can supply a stand-in. */
export interface DeepSeekClient {
  chat: {
    completions: {
      create(
        body: DeepSeekChatParams,
        options: { signal: AbortSignal },
      ): PromiseLike<AsyncIterable<DeepSeekChunk>>;
    };
  };
}

/**
 * Streams answers from DeepSeek through the OpenAI SDK (DeepSeek's API is
 * OpenAI-compatible). The model comes from config, never from the caller.
 *
 * SDK retries are off (`maxRetries: 0`): the generation pipeline owns retries.
 * This adapter only classifies failures.
 *
 * Nothing here logs prompts, answers or reasoning. Errors are rebuilt from the
 * status code only; the SDK message is never copied.
 */
export class DeepSeekProvider extends AiProvider {
  private readonly client: DeepSeekClient;

  constructor(
    private readonly config: DeepSeekConfig,
    client?: DeepSeekClient,
  ) {
    super();
    this.client = client ?? createSdkClient(config);
  }

  async *stream(request: AiRequest): AsyncGenerator<AiStreamEvent> {
    if (request.signal?.aborted) throw cancelled();

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    };

    let finishReason: string | null = null;
    let model = this.config.model;
    let usage: AiUsage = emptyUsage();

    try {
      arm(FIRST_TOKEN_TIMEOUT_MS);
      const chunks = await this.client.chat.completions.create(this.toParams(request), {
        signal: controller.signal,
      });

      for await (const chunk of chunks) {
        arm(IDLE_TIMEOUT_MS);
        model = chunk.model || model;
        if (chunk.usage) usage = toUsage(chunk.usage);

        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.reasoning_content) {
          yield { type: 'reasoning', text: choice.delta.reasoning_content };
        }
        if (choice.delta.content) {
          yield { type: 'text', text: choice.delta.content };
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (error) {
      if (timedOut) throw new AiProviderError('PROVIDER_TIMEOUT', 'DeepSeek stopped responding', true);
      if (request.signal?.aborted) throw cancelled();
      throw classify(error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abortFromCaller);
      // Closes the connection if the caller stopped reading early.
      controller.abort();
    }

    yield { type: 'done', finishReason: toFinishReason(finishReason), usage, model };
  }

  private toParams(request: AiRequest): DeepSeekChatParams {
    return {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content.map((part) => part.text).join(''),
      })),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxOutputTokens,
      thinking: { type: request.thinking ? 'enabled' : 'disabled' },
      ...(request.userId ? { user_id: request.userId } : {}),
    };
  }
}

function createSdkClient(config: DeepSeekConfig): DeepSeekClient {
  const sdk = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0 });
  // The SDK types don't know DeepSeek's extra fields (thinking, reasoning_content, cache counts).
  return sdk as unknown as DeepSeekClient;
}

const cancelled = () => new AiProviderError('CANCELLED', 'Generation was cancelled', false);

function emptyUsage(): AiUsage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

function toUsage(usage: NonNullable<DeepSeekChunk['usage']>): AiUsage {
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cacheHitTokens: hit,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? Math.max(usage.prompt_tokens - hit, 0),
  };
}

function toFinishReason(reason: string | null): AiFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content_filter':
      return reason;
    case null:
    case 'insufficient_system_resource':
    case 'aborted':
      // The stream ended without a normal finish, so the answer is incomplete.
      throw new AiProviderError('PROVIDER_INTERRUPTED', 'DeepSeek interrupted the answer', true);
    default:
      throw new AiProviderError('PROVIDER_REJECTED', 'DeepSeek returned an unexpected result', false);
  }
}

function classify(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof OpenAI.APIUserAbortError) return cancelled();
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiProviderError('PROVIDER_TIMEOUT', 'DeepSeek request timed out', true);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new AiProviderError('PROVIDER_UNAVAILABLE', 'DeepSeek request failed (network error)', true);
  }
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    return fromStatus(error.status);
  }
  // Not an SDK error, probably a network failure, so allow a retry.
  return new AiProviderError('PROVIDER_UNAVAILABLE', 'DeepSeek request failed (unexpected error)', true);
}

function fromStatus(status: number): AiProviderError {
  const text = `DeepSeek rejected the request (HTTP ${status})`;
  if (status === 401) return new AiProviderError('PROVIDER_AUTH', text, false, status);
  if (status === 402) return new AiProviderError('PROVIDER_BALANCE', text, false, status);
  if (status === 429) return new AiProviderError('PROVIDER_RATE_LIMITED', text, true, status);
  if (status === 408 || status >= 500) return new AiProviderError('PROVIDER_UNAVAILABLE', text, true, status);
  return new AiProviderError('PROVIDER_REJECTED', text, false, status);
}
