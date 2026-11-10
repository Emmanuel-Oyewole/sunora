/**
 * Public contract of the conversations module. Other modules use only this
 * file, never the repository or the tables. Plain data only, so it can cross a
 * service boundary unchanged.
 */

export type MessageRole = 'USER' | 'ASSISTANT';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  /** The model's reasoning. Assistant messages only. */
  reasoning: string | null;
  /** Root = 0. */
  depth: number;
  generationId: string | null;
  createdAt: Date;
}

export interface AppendUserMessageRequest {
  /** Leave out to start a new conversation with this message. */
  conversationId?: string;
  /** The assistant message being answered. Leave out for a first message or a new root. */
  parentId?: string | null;
  content: string;
}

export interface AppendedMessage {
  conversationId: string;
  message: ConversationMessage;
}

export interface AppendAssistantMessageRequest {
  conversationId: string;
  /** The user message this answers. */
  parentId: string;
  content: string;
  reasoning?: string | null;
  generationId: string;
}

export abstract class ConversationsFacade {
  /**
   * Adds a user message (creating the conversation if none is given) and makes
   * it the active leaf. A conversation that is missing, deleted or owned by
   * someone else is reported as not found.
   */
  abstract appendUserMessage(ownerId: string, request: AppendUserMessageRequest): Promise<AppendedMessage>;

  /**
   * Adds a finished answer. The active leaf moves to it only if it is still the
   * user message being answered, so a user who switched branch is not pulled back.
   */
  abstract appendAssistantMessage(
    ownerId: string,
    request: AppendAssistantMessageRequest,
  ): Promise<ConversationMessage>;

  /** The messages from the root (or the last `limit` of them) down to `messageId`, oldest first. */
  abstract getPathTo(
    ownerId: string,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<ConversationMessage[]>;

  /** Saves an automatic title unless the user renamed the conversation. Returns whether it was saved. */
  abstract applyGeneratedTitle(conversationId: string, title: string): Promise<boolean>;
}
