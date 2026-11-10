import OpenAI from 'openai';
import { AiProviderError, type AiRequest, type AiStreamEvent } from './ai-provider.port.js';
import {
  DeepSeekProvider,
  FIRST_TOKEN_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  type DeepSeekChatParams,
  type DeepSeekChunk,
  type DeepSeekClient,
} from './deepseek.provider.js';

const config = { apiKey: 'sk-secret-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

const request: AiRequest = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
    { role: 'user', content: [{ type: 'text', text: 'my private prompt' }] },
  ],
  maxOutputTokens: 500,
  thinking: false,
};

const chunk = (
  delta: { content?: string; reasoning_content?: string },
  finish_reason: string | null = null,
  extra: Partial<DeepSeekChunk> = {},
): DeepSeekChunk => ({ model: 'deepseek-flash', choices: [{ delta, finish_reason }], ...extra });

const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_cache_hit_tokens: 60,
  prompt_cache_miss_tokens: 40,
  completion_tokens_details: { reasoning_tokens: 5 },
};

const lastChunk = (finish: string, extra: Partial<DeepSeekChunk> = {}) =>
  chunk({ content: '' }, finish, { usage, ...extra });

/** Waits until the caller aborts, like a real connection that is stuck. */
const hang = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new OpenAI.APIUserAbortError()), { once: true });
  });

interface Script {
  chunks?: DeepSeekChunk[];
  /** What happens after the chunks: end normally, fail, or hang. */
  after?: 'end' | 'hang' | { fail: unknown };
}

function clientFor(script: Script) {
  const create = vi.fn(async (_body: DeepSeekChatParams, options: { signal: AbortSignal }) => {
    async function* iterate() {
      for (const item of script.chunks ?? []) yield item;
      if (script.after === 'hang') await hang(options.signal);
      else if (typeof script.after === 'object') throw script.after.fail;
    }
    return iterate();
  });
  const client: DeepSeekClient = { chat: { completions: { create } } };
  return { client, create };
}

async function collect(stream: AsyncIterable<AiStreamEvent>) {
  const events: AiStreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    return { events, error: error as AiProviderError };
  }
  return { events, error: undefined };
}

const run = (script: Script, req: AiRequest = request) => {
  const { client, create } = clientFor(script);
  return { create, result: collect(new DeepSeekProvider(config, client).stream(req)) };
};

describe('DeepSeekProvider', () => {
  describe('request', () => {
    it('sends a streaming request with usage, a token cap and thinking disabled', async () => {
      const { create, result } = run({ chunks: [lastChunk('stop')] });
      await result;

      expect(create.mock.calls[0][0]).toEqual({
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'my private prompt' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 500,
        thinking: { type: 'disabled' },
      });
    });

    it('enables thinking and passes the user id when asked', async () => {
      const { create, result } = run(
        { chunks: [lastChunk('stop')] },
        { ...request, thinking: true, userId: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000' },
      );
      await result;

      expect(create.mock.calls[0][0]).toMatchObject({
        thinking: { type: 'enabled' },
        user_id: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
      });
    });

    it('joins several text parts into one message', async () => {
      const { create, result } = run(
        { chunks: [lastChunk('stop')] },
        {
          ...request,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Hello ' },
                { type: 'text', text: 'there' },
              ],
            },
          ],
        },
      );
      await result;

      expect(create.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'Hello there' }]);
    });

    it('can be constructed with just the configuration, using the real SDK client', () => {
      expect(() => new DeepSeekProvider(config)).not.toThrow();
    });
  });

  describe('streaming', () => {
    it('yields text as it arrives and ends with usage, finish reason and model', async () => {
      const { events, error } = await run({
        chunks: [chunk({ content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), lastChunk('stop')],
      }).result;

      expect(error).toBeUndefined();
      expect(events).toEqual([
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        {
          type: 'done',
          finishReason: 'stop',
          model: 'deepseek-flash',
          usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 5, cacheHitTokens: 60, cacheMissTokens: 40 },
        },
      ]);
    });

    it('yields reasoning before the answer', async () => {
      const { events } = await run({
        chunks: [
          chunk({ reasoning_content: 'Let me think' }),
          chunk({ reasoning_content: ' more' }),
          chunk({ content: 'Done.' }),
          lastChunk('stop'),
        ],
      }).result;

      expect(events.slice(0, 3)).toEqual([
        { type: 'reasoning', text: 'Let me think' },
        { type: 'reasoning', text: ' more' },
        { type: 'text', text: 'Done.' },
      ]);
    });

    it('falls back to cached_tokens and computes misses when the cache fields are missing', async () => {
      const { events } = await run({
        chunks: [
          chunk({ content: 'x' }),
          lastChunk('stop', {
            usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 30 } },
          }),
        ],
      }).result;

      expect(events.at(-1)).toMatchObject({
        usage: { cacheHitTokens: 30, cacheMissTokens: 20, reasoningTokens: 0 },
      });
    });

    it.each(['stop', 'length', 'content_filter'] as const)('passes the %s finish reason through', async (reason) => {
      const { events } = await run({ chunks: [chunk({ content: 'x' }), lastChunk(reason)] }).result;

      expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: reason });
    });

    it.each(['insufficient_system_resource', 'aborted'])(
      'treats finish reason %s as a retryable interruption, keeping the partial output',
      async (reason) => {
        const { events, error } = await run({ chunks: [chunk({ content: 'partial' }), lastChunk(reason)] }).result;

        expect(events).toEqual([{ type: 'text', text: 'partial' }]);
        expect(error).toMatchObject({ code: 'PROVIDER_INTERRUPTED', retryable: true });
      },
    );

    it('treats a stream that ends without a finish reason as an interruption', async () => {
      const { error } = await run({ chunks: [chunk({ content: 'cut off' })] }).result;

      expect(error).toMatchObject({ code: 'PROVIDER_INTERRUPTED', retryable: true });
    });

    it('rejects a finish reason it never asked for', async () => {
      const { error } = await run({ chunks: [lastChunk('tool_calls')] }).result;

      expect(error).toMatchObject({ code: 'PROVIDER_REJECTED', retryable: false });
    });
  });

  describe('failure classification', () => {
    const http = (status: number) => OpenAI.APIError.generate(status, {}, 'private prompt leaked here', new Headers());
    const failWith = (fail: unknown) => run({ after: { fail } }).result;

    it.each([
      [401, 'PROVIDER_AUTH', false],
      [402, 'PROVIDER_BALANCE', false],
      [400, 'PROVIDER_REJECTED', false],
      [422, 'PROVIDER_REJECTED', false],
      [429, 'PROVIDER_RATE_LIMITED', true],
      [408, 'PROVIDER_UNAVAILABLE', true],
      [500, 'PROVIDER_UNAVAILABLE', true],
      [503, 'PROVIDER_UNAVAILABLE', true],
    ])('maps HTTP %i to %s (retryable: %s)', async (status, code, retryable) => {
      const { error } = await failWith(http(status));

      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({ code, retryable, statusCode: status });
    });

    it('treats SDK timeouts and connection failures as retryable', async () => {
      expect((await failWith(new OpenAI.APIConnectionTimeoutError())).error).toMatchObject({
        code: 'PROVIDER_TIMEOUT',
        retryable: true,
      });
      expect((await failWith(new OpenAI.APIConnectionError({ message: 'ECONNRESET' }))).error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      expect((await failWith(new TypeError('boom'))).error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    });

    it('keeps the partial output when the connection drops mid-answer', async () => {
      const { events, error } = await run({
        chunks: [chunk({ content: 'Hello' })],
        after: { fail: new OpenAI.APIConnectionError({ message: 'reset' }) },
      }).result;

      expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });

    it('never exposes the API key, the prompt or the SDK message', async () => {
      for (const status of [400, 401, 402, 429, 500]) {
        const { error } = await failWith(http(status));
        expect(error?.message).not.toContain('sk-secret-key');
        expect(error?.message).not.toContain('private prompt');
      }
    });
  });

  describe('cancel and timeouts', () => {
    afterEach(() => vi.useRealTimers());

    it('fails with CANCELLED, without calling the API, if already aborted', async () => {
      const { create, result } = run({ chunks: [lastChunk('stop')] }, { ...request, signal: AbortSignal.abort() });

      expect((await result).error).toMatchObject({ code: 'CANCELLED', retryable: false });
      expect(create).not.toHaveBeenCalled();
    });

    it('stops with CANCELLED when the caller aborts mid-answer', async () => {
      const controller = new AbortController();
      const { client } = clientFor({ chunks: [chunk({ content: 'Hi' })], after: 'hang' });
      const iterator = new DeepSeekProvider(config, client).stream({ ...request, signal: controller.signal });

      expect(await iterator.next()).toEqual({ done: false, value: { type: 'text', text: 'Hi' } });
      const next = iterator.next();
      controller.abort();

      await expect(next).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    });

    it('closes the connection when the caller stops reading early', async () => {
      const { client, create } = clientFor({
        chunks: [chunk({ content: 'a' }), chunk({ content: 'b' }), lastChunk('stop')],
      });

      for await (const event of new DeepSeekProvider(config, client).stream(request)) {
        if (event.type === 'text') break;
      }

      expect(create.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('times out when nothing arrives within the first-token limit', async () => {
      vi.useFakeTimers();
      const { result } = run({ after: 'hang' });

      await vi.advanceTimersByTimeAsync(FIRST_TOKEN_TIMEOUT_MS);

      expect((await result).error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
    });

    it('times out when the answer goes silent, keeping what was received', async () => {
      vi.useFakeTimers();
      const { result } = run({ chunks: [chunk({ content: 'Hel' })], after: 'hang' });

      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
      const { events, error } = await result;

      expect(events).toEqual([{ type: 'text', text: 'Hel' }]);
      expect(error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
    });
  });
});
