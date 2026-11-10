import {
  AiProvider,
  AiProviderError,
  type AiRequest,
  type AiStreamEvent,
  type AiUsage,
} from '../../src/modules/generation/providers/ai-provider.port.js';

export const USAGE: AiUsage = { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 10 };

export type Script = (request: AiRequest) => AsyncGenerator<AiStreamEvent>;

const isTitleRequest = (request: AiRequest) => request.messages[0].content[0].text.includes('short title');

/** Waits until the caller aborts, like a provider call that is stuck. */
const untilAborted = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new AiProviderError('CANCELLED', 'Generation was cancelled', false));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });

/** An answer that arrives as the given pieces, optionally after some reasoning. */
export const answer =
  (pieces: string[], options: { reasoning?: string[]; finishReason?: 'stop' | 'length' | 'content_filter' } = {}): Script =>
  async function* () {
    for (const text of options.reasoning ?? []) yield { type: 'reasoning', text };
    for (const text of pieces) yield { type: 'text', text };
    yield { type: 'done', finishReason: options.finishReason ?? 'stop', usage: USAGE, model: 'deepseek-flash' };
  };

/** Some text, then a failure. */
export const failingAfter = (pieces: string[], code: AiProviderError['code'] = 'PROVIDER_UNAVAILABLE'): Script =>
  async function* () {
    for (const text of pieces) yield { type: 'text', text };
    await Promise.resolve();
    throw new AiProviderError(code, 'provider failed', code !== 'PROVIDER_AUTH');
  };

/** Some text, then nothing until it is cancelled. */
export const hangingAfter = (pieces: string[] = []): Script =>
  async function* (request) {
    for (const text of pieces) yield { type: 'text', text };
    await untilAborted(request.signal);
  };

/**
 * A provider whose behaviour is scripted per call. Calls without a script
 * answer "Hello there"; title requests get "Greeting" unless given their own script.
 */
export class FakeAiProvider extends AiProvider {
  readonly requests: AiRequest[] = [];
  private readonly scripts: Script[] = [];
  titleScript: Script = answer(['"Greeting"']);

  /** The next answer request uses this script. */
  next(script: Script): this {
    this.scripts.push(script);
    return this;
  }

  get answerRequests(): AiRequest[] {
    return this.requests.filter((request) => !isTitleRequest(request));
  }

  stream(request: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(request);
    const script = isTitleRequest(request) ? this.titleScript : (this.scripts.shift() ?? answer(['Hello there']));
    return script(request);
  }
}
