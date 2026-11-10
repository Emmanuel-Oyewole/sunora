import type { ConversationMessage } from '../conversations/index.js';
import type { AiMessage } from './providers/ai-provider.port.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

/**
 * The system prompt plus as much recent history as fits `charBudget`
 * (about 4 characters per token). The newest message is always kept, and the
 * history never starts with an answer, so the model sees a question first.
 * Reasoning is not sent back to the model.
 */
export function buildContext(history: ConversationMessage[], charBudget: number): AiMessage[] {
  const kept: ConversationMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (kept.length > 0 && used + message.content.length > charBudget) break;
    kept.unshift(message);
    used += message.content.length;
  }
  while (kept.length > 1 && kept[0].role === 'ASSISTANT') kept.shift();

  return [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
    ...kept.map((message): AiMessage => ({
      role: message.role === 'USER' ? 'user' : 'assistant',
      content: [{ type: 'text', text: message.content }],
    })),
  ];
}
