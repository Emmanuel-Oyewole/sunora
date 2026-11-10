import { Injectable } from '@nestjs/common';
import type { Conversation, Message } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/database/prisma.service.js';
import type { DbTransaction } from '../../shared/database/unit-of-work.js';
import type { HistoryCursor } from './cursor.js';

export interface NewMessage {
  conversationId: string;
  parentId: string | null;
  role: 'USER' | 'ASSISTANT';
  content: string;
  reasoning?: string | null;
  depth: number;
  generationId?: string | null;
}

/**
 * The only code that queries the conversations tables. Not exported from the
 * module. Every read of a conversation filters out soft-deleted ones here, so
 * a caller cannot forget it.
 */
@Injectable()
export class ConversationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: DbTransaction): DbTransaction {
    return tx ?? this.prisma;
  }

  createConversation(ownerId: string, at: Date, tx?: DbTransaction): Promise<Conversation> {
    return this.db(tx).conversation.create({ data: { ownerId, lastMessageAt: at } });
  }

  /** Null when it does not exist, is deleted, or belongs to someone else. */
  findOwned(id: string, ownerId: string, tx?: DbTransaction): Promise<Conversation | null> {
    return this.db(tx).conversation.findFirst({ where: { id, ownerId, deletedAt: null } });
  }

  /** Newest first. Fetches one extra row so the caller knows whether another page exists. */
  listOwned(ownerId: string, limit: number, cursor?: HistoryCursor, tx?: DbTransaction): Promise<Conversation[]> {
    return this.db(tx).conversation.findMany({
      where: {
        ownerId,
        deletedAt: null,
        ...(cursor && {
          OR: [
            { lastMessageAt: { lt: cursor.lastMessageAt } },
            { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
  }

  /** True if it changed something: the user had not renamed it, or deleted it, in the meantime. */
  async setGeneratedTitle(id: string, title: string, tx?: DbTransaction): Promise<boolean> {
    const { count } = await this.db(tx).conversation.updateMany({
      where: { id, deletedAt: null, titleSource: { not: 'MANUAL' } },
      data: { title, titleSource: 'GENERATED' },
    });
    return count > 0;
  }

  async rename(id: string, ownerId: string, title: string, tx?: DbTransaction): Promise<boolean> {
    const { count } = await this.db(tx).conversation.updateMany({
      where: { id, ownerId, deletedAt: null },
      data: { title, titleSource: 'MANUAL' },
    });
    return count > 0;
  }

  async softDelete(id: string, ownerId: string, at: Date, tx?: DbTransaction): Promise<boolean> {
    const { count } = await this.db(tx).conversation.updateMany({
      where: { id, ownerId, deletedAt: null },
      data: { deletedAt: at },
    });
    return count > 0;
  }

  insertMessage(message: NewMessage, tx?: DbTransaction): Promise<Message> {
    return this.db(tx).message.create({
      data: {
        conversationId: message.conversationId,
        parentId: message.parentId,
        role: message.role,
        content: message.content,
        reasoning: message.reasoning ?? null,
        depth: message.depth,
        generationId: message.generationId ?? null,
      },
    });
  }

  /** Looks up by id and conversation together, so a message from another conversation is never found. */
  findMessage(id: string, conversationId: string, tx?: DbTransaction): Promise<Message | null> {
    return this.db(tx).message.findFirst({ where: { id, conversationId } });
  }

  /** A new user message always becomes the active leaf. */
  async setActiveLeaf(conversationId: string, leafId: string, at: Date, tx?: DbTransaction): Promise<void> {
    await this.db(tx).conversation.update({
      where: { id: conversationId },
      data: { activeLeafId: leafId, lastMessageAt: at },
    });
  }

  async touch(conversationId: string, at: Date, tx?: DbTransaction): Promise<void> {
    await this.db(tx).conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at } });
  }

  /** Moves the leaf only if it is still `expectedLeafId`. Atomic, so a concurrent branch switch wins. */
  async moveActiveLeafIfCurrent(
    conversationId: string,
    expectedLeafId: string,
    newLeafId: string,
    tx?: DbTransaction,
  ): Promise<boolean> {
    const { count } = await this.db(tx).conversation.updateMany({
      where: { id: conversationId, activeLeafId: expectedLeafId },
      data: { activeLeafId: newLeafId },
    });
    return count > 0;
  }

  /**
   * The ancestors of `leafId` (itself included) with `lowestDepth <= depth < beforeDepth`,
   * oldest first. The walk stops at `lowestDepth`, so a long branch is not read in full.
   */
  async branchWindow(
    conversationId: string,
    leafId: string,
    lowestDepth: number,
    beforeDepth: number,
    tx?: DbTransaction,
  ): Promise<Message[]> {
    return this.db(tx).$queryRaw<Message[]>`
      WITH RECURSIVE walk AS (
        SELECT m.* FROM "conversations"."messages" m
        WHERE m.id = ${leafId}::uuid AND m.conversation_id = ${conversationId}::uuid
        UNION ALL
        SELECT p.* FROM "conversations"."messages" p
        JOIN walk w ON p.id = w.parent_id AND p.conversation_id = w.conversation_id
        WHERE w.depth > ${lowestDepth}::int
      )
      SELECT id,
             conversation_id AS "conversationId",
             parent_id AS "parentId",
             role::text AS role,
             content,
             reasoning,
             depth,
             generation_id AS "generationId",
             created_at AS "createdAt"
      FROM walk
      WHERE depth >= ${lowestDepth}::int AND depth < ${beforeDepth}::int
      ORDER BY depth ASC
    `;
  }
}
