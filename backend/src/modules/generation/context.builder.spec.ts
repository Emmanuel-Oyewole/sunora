import type { ConversationMessage } from '../conversations/index.js';
import { buildContext } from './context.builder.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

let n = 0;
const message = (role: 'USER' | 'ASSISTANT', content: string, reasoning: string | null = null): ConversationMessage => ({
  id: `m${++n}`,
  conversationId: 'c',
  parentId: null,
  role,
  content,
  reasoning,
  depth: n,
  generationId: null,
  createdAt: new Date(),
});

const texts = (messages: ReturnType<typeof buildContext>) => messages.map((m) => `${m.role}:${m.content[0].text}`);

describe('buildContext', () => {
  it('starts with the system prompt and keeps short history whole', () => {
    const result = buildContext([message('USER', 'one'), message('ASSISTANT', 'two'), message('USER', 'three')], 1000);

    expect(texts(result)).toEqual([`system:${SYSTEM_PROMPT}`, 'user:one', 'assistant:two', 'user:three']);
  });

  it('drops the oldest messages first when over the budget', () => {
    const result = buildContext(
      [message('USER', 'a'.repeat(50)), message('ASSISTANT', 'b'.repeat(50)), message('USER', 'c'.repeat(50)), message('ASSISTANT', 'd'.repeat(50)), message('USER', 'e'.repeat(50))],
      120,
    );

    // 120 characters fits two 50-character messages; the history then must not start with an answer.
    expect(texts(result).slice(1)).toEqual([`user:${'e'.repeat(50)}`]);
  });

  it('always keeps the newest message, even if it alone is over the budget', () => {
    const result = buildContext([message('USER', 'old'), message('ASSISTANT', 'older answer'), message('USER', 'x'.repeat(500))], 10);

    expect(texts(result)).toEqual([`system:${SYSTEM_PROMPT}`, `user:${'x'.repeat(500)}`]);
  });

  it('does not begin the history with an assistant message', () => {
    const result = buildContext([message('ASSISTANT', 'answer'), message('USER', 'question')], 1000);

    expect(texts(result).slice(1)).toEqual(['user:question']);
  });

  it('never sends reasoning back to the model', () => {
    const result = buildContext([message('USER', 'q'), message('ASSISTANT', 'a', 'secret reasoning')], 1000);

    expect(JSON.stringify(result)).not.toContain('secret reasoning');
  });
});
