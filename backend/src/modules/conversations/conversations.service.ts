import { Injectable } from '@nestjs/common';
import type { Conversation, Message } from '../../generated/prisma/client.js';
import { UnitOfWork, type DbTransaction } from '../../shared/database/unit-of-work.js';
import {
  DEFAULT_BRANCH_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_MESSAGE_LENGTH,
  MAX_REASONING_LENGTH,
} from './conversations.constants.js';
import {
  conversationNotFound,
  invalidMessage,
  invalidMessageParent,
  messageNotFound,
} from './conversations.errors.js';
import { ConversationsRepository } from './conversations.repository.js';
import {
  ConversationsFacade,
  type AppendAssistantMessageRequest,
  type AppendUserMessageRequest,
  type AppendedMessage,
  type ConversationMessage,
} from './contracts/conversations.facade.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export interface ConversationSummary {
  id: string;
  title: string | null;
  lastMessageAt: Date;
  createdAt: Date;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  titleSource: 'DEFAULT' | 'GENERATED' | 'MANUAL';
  /** The active branch, oldest first. */
  messages: ConversationMessage[];
  /** Pass as `before` to load older messages. Null when this page reaches the first message. */
  nextBefore: number | null;
}

const toMessage = (row: Message): ConversationMessage => ({
  id: row.id,
  conversationId: row.conversationId,
  parentId: row.parentId,
  role: row.role,
  content: row.content,
  reasoning: row.reasoning,
  depth: row.depth,
  generationId: row.generationId,
  createdAt: row.createdAt,
});

const toSummary = (row: Conversation): ConversationSummary => ({
  id: row.id,
  title: row.title,
  lastMessageAt: row.lastMessageAt,
  createdAt: row.createdAt,
});

@Injectable()
export class ConversationsService extends ConversationsFacade {
  constructor(
    private readonly repository: ConversationsRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {
    super();
  }

  // Facade (used by other modules)

  async appendUserMessage(ownerId: string, request: AppendUserMessageRequest): Promise<AppendedMessage> {
    const content = validText(request.content, MAX_MESSAGE_LENGTH, 'The message');
    const now = new Date();

    return this.unitOfWork.run(async (tx) => {
      let conversationId = request.conversationId;
      let parent: Message | null = null;

      if (conversationId === undefined) {
        if (request.parentId) throw invalidMessageParent();
        conversationId = (await this.repository.createConversation(ownerId, now, tx)).id;
      } else {
        await this.requireOwned(ownerId, conversationId, tx);
        if (request.parentId) parent = await this.requireMessage(conversationId, request.parentId, tx);
      }
      if (parent && parent.role !== 'ASSISTANT') throw invalidMessageParent();

      const message = await this.repository.insertMessage(
        { conversationId, parentId: parent?.id ?? null, role: 'USER', content, depth: parent ? parent.depth + 1 : 0 },
        tx,
      );
      await this.repository.setActiveLeaf(conversationId, message.id, now, tx);
      return { conversationId, message: toMessage(message) };
    });
  }

  async appendAssistantMessage(
    ownerId: string,
    request: AppendAssistantMessageRequest,
  ): Promise<ConversationMessage> {
    const content = validText(request.content, MAX_MESSAGE_LENGTH, 'The answer');
    const reasoning = request.reasoning ? validText(request.reasoning, MAX_REASONING_LENGTH, 'The reasoning') : null;
    const now = new Date();

    return this.unitOfWork.run(async (tx) => {
      await this.requireOwned(ownerId, request.conversationId, tx);
      const parent = await this.requireMessage(request.conversationId, request.parentId, tx);
      if (parent.role !== 'USER') throw invalidMessageParent();

      const message = await this.repository.insertMessage(
        {
          conversationId: request.conversationId,
          parentId: parent.id,
          role: 'ASSISTANT',
          content,
          reasoning,
          depth: parent.depth + 1,
          generationId: request.generationId,
        },
        tx,
      );
      await this.repository.touch(request.conversationId, now, tx);
      await this.repository.moveActiveLeafIfCurrent(request.conversationId, parent.id, message.id, tx);
      return toMessage(message);
    });
  }

  async getPathTo(
    ownerId: string,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<ConversationMessage[]> {
    await this.requireOwned(ownerId, conversationId);
    const target = await this.requireMessage(conversationId, messageId);
    const rows = await this.repository.branchWindow(
      conversationId,
      target.id,
      Math.max(0, target.depth + 1 - limit),
      target.depth + 1,
    );
    return rows.map(toMessage);
  }

  applyGeneratedTitle(conversationId: string, title: string): Promise<boolean> {
    return this.repository.setGeneratedTitle(conversationId, title);
  }

  // HTTP use cases

  async list(ownerId: string, query: { limit?: number; cursor?: string }): Promise<ConversationPage> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    const rows = await this.repository.listOwned(ownerId, limit, cursor);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > limit && last ? encodeCursor({ lastMessageAt: last.lastMessageAt, id: last.id }) : null,
    };
  }

  async getBranch(ownerId: string, id: string, query: { limit?: number; before?: number }): Promise<ConversationDetail> {
    const conversation = await this.requireOwned(ownerId, id);
    const base = { ...toSummary(conversation), titleSource: conversation.titleSource };
    if (!conversation.activeLeafId) return { ...base, messages: [], nextBefore: null };

    const limit = query.limit ?? DEFAULT_BRANCH_PAGE_SIZE;
    const leaf = await this.requireMessage(conversation.id, conversation.activeLeafId);
    const before = Math.min(query.before ?? leaf.depth + 1, leaf.depth + 1);
    const rows = await this.repository.branchWindow(conversation.id, leaf.id, Math.max(0, before - limit), before);

    // Depths along a branch are consecutive, so older messages exist whenever the first one is not a root.
    const oldest = rows[0];
    return { ...base, messages: rows.map(toMessage), nextBefore: oldest && oldest.depth > 0 ? oldest.depth : null };
  }

  async rename(ownerId: string, id: string, title: string): Promise<ConversationSummary> {
    if (!(await this.repository.rename(id, ownerId, title))) throw conversationNotFound();
    return toSummary(await this.requireOwned(ownerId, id));
  }

  async remove(ownerId: string, id: string): Promise<void> {
    if (!(await this.repository.softDelete(id, ownerId, new Date()))) throw conversationNotFound();
  }

  private async requireOwned(ownerId: string, id: string, tx?: DbTransaction): Promise<Conversation> {
    const conversation = await this.repository.findOwned(id, ownerId, tx);
    if (!conversation) throw conversationNotFound();
    return conversation;
  }

  private async requireMessage(conversationId: string, id: string, tx?: DbTransaction): Promise<Message> {
    const message = await this.repository.findMessage(id, conversationId, tx);
    if (!message) throw messageNotFound();
    return message;
  }
}

function validText(value: string, max: number, what: string): string {
  if (value.trim().length === 0) throw invalidMessage(`${what} cannot be empty.`);
  if (value.length > max) throw invalidMessage(`${what} is too long.`);
  return value;
}
