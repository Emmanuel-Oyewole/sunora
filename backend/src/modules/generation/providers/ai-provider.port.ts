export interface AiContentPart {
  type: 'text';
  text: string;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  /** Parts, not a string, so images can be added later without changing callers. */
  content: AiContentPart[];
}

export interface AiRequest {
  messages: AiMessage[];
  /** Always set, so one answer has a bounded cost. */
  maxOutputTokens: number;
  thinking: boolean;
  /** Opaque id (never an email). Lets the provider isolate its cache per user. */
  userId?: string;
  /** Abort to stop the answer early. The stream then fails with CANCELLED. */
  signal?: AbortSignal;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export type AiFinishReason = 'stop' | 'length' | 'content_filter';

export type AiStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done'; finishReason: AiFinishReason; usage: AiUsage; model: string };

export type AiProviderErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_BALANCE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_INTERRUPTED'
  | 'CANCELLED';

/**
 * Thrown by providers. `code` is stable and safe to store; the message never
 * holds provider text, prompts or answers. `retryable` says whether another
 * attempt can help (only safe if no output has been produced yet).
 */
export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/**
 * Port: how an answer is generated. The stream yields reasoning and text as it
 * arrives and ends with one `done` event. A failure mid-stream is thrown after
 * the events that were already yielded, so callers can keep the partial output.
 */
export abstract class AiProvider {
  abstract stream(request: AiRequest): AsyncIterable<AiStreamEvent>;
}
