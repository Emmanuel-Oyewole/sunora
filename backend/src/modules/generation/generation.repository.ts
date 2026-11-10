import { Injectable } from '@nestjs/common';
import type {
  ChunkKind,
  Generation,
  GenerationChunk,
  GenerationStatus,
  GenerationTrigger,
  IdempotencyKey,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/database/prisma.service.js';
import { isUniqueViolation } from '../../shared/database/errors.js';
import { ACTIVE_STATUSES, canTransition, isTerminal } from './generation.state.js';

export interface NewGeneration {
  userId: string;
  conversationId: string;
  userMessageId: string;
  attemptNumber: number;
  trigger: GenerationTrigger;
  thinking: boolean;
  provider: string;
  model: string;
}

export interface TransitionPatch {
  errorCode?: string | null;
  assistantMessageId?: string | null;
  finishReason?: string | null;
}

export interface NewChunk {
  generationId: string;
  seq: number;
  kind: ChunkKind;
  text: string;
}

export type KeyClaim = { claimed: true; row: IdempotencyKey } | { claimed: false; row: IdempotencyKey };

/**
 * The only code that queries the generation tables. Not exported from the
 * module. Every status change is a conditional update ("only if it is still in
 * the state I expect"), so two writers can never both win.
 */
@Injectable()
export class GenerationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Generations

  create(data: NewGeneration): Promise<Generation> {
    return this.prisma.generation.create({ data });
  }

  findOwned(id: string, userId: string): Promise<Generation | null> {
    return this.prisma.generation.findFirst({ where: { id, userId } });
  }

  find(id: string): Promise<Generation | null> {
    return this.prisma.generation.findUnique({ where: { id } });
  }

  /** The highest attempt for a user message. */
  latestAttempt(userMessageId: string): Promise<Generation | null> {
    return this.prisma.generation.findFirst({ where: { userMessageId }, orderBy: { attemptNumber: 'desc' } });
  }

  findAttempt(userMessageId: string, attemptNumber: number): Promise<Generation | null> {
    return this.prisma.generation.findUnique({ where: { userMessageId_attemptNumber: { userMessageId, attemptNumber } } });
  }

  listForConversation(userId: string, conversationId: string, limit: number): Promise<Generation[]> {
    return this.prisma.generation.findMany({
      where: { userId, conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  countActive(userId: string): Promise<number> {
    return this.prisma.generation.count({ where: { userId, status: { in: [...ACTIVE_STATUSES] } } });
  }

  /** PENDING to RUNNING, only if nobody else (a cancel) got there first. */
  async claimRun(id: string, instanceId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.generation.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'RUNNING', ownerInstanceId: instanceId, heartbeatAt: now, startedAt: now },
    });
    return count > 0;
  }

  /** Moves to a new status only if it is still in `from`. Returns whether this call did it. */
  async transition(
    id: string,
    from: GenerationStatus,
    to: GenerationStatus,
    now: Date,
    patch: TransitionPatch = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) throw new Error(`Generation cannot go from ${from} to ${to}`);
    const { count } = await this.prisma.generation.updateMany({
      where: { id, status: from },
      data: { status: to, ...patch, ...(isTerminal(to) && { finishedAt: now }) },
    });
    return count > 0;
  }

  /** Records that the user asked to stop. Only while the generation is still active. */
  async requestCancel(id: string, userId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.generation.updateMany({
      where: { id, userId, status: { in: [...ACTIVE_STATUSES] } },
      data: { cancelRequestedAt: now },
    });
    return count > 0;
  }

  async heartbeat(ids: string[], instanceId: string, now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.generation.updateMany({
      where: { id: { in: ids }, ownerInstanceId: instanceId, status: 'RUNNING' },
      data: { heartbeatAt: now },
    });
  }

  /** Restart sweep: anything still active that this process does not own was left behind by a dead one. */
  async interruptForeign(instanceId: string, now: Date): Promise<number> {
    const { count } = await this.prisma.generation.updateMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        OR: [{ ownerInstanceId: null }, { ownerInstanceId: { not: instanceId } }],
      },
      data: { status: 'INTERRUPTED', errorCode: 'SERVER_RESTART', finishedAt: now },
    });
    return count;
  }

  // Chunks

  async appendChunks(rows: NewChunk[]): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.generationChunk.createMany({ data: rows });
  }

  chunksAfter(generationId: string, afterSeq: number, limit: number): Promise<GenerationChunk[]> {
    return this.prisma.generationChunk.findMany({
      where: { generationId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  }

  async lastSeq(generationId: string): Promise<number> {
    const result = await this.prisma.generationChunk.aggregate({ where: { generationId }, _max: { seq: true } });
    return result._max.seq ?? 0;
  }

  /** Everything written so far, as text and reasoning. For showing partial output after a failure. */
  async partialOutput(generationId: string): Promise<{ text: string; reasoning: string }> {
    const rows = await this.prisma.generationChunk.findMany({ where: { generationId }, orderBy: { seq: 'asc' } });
    const join = (kind: ChunkKind) =>
      rows
        .filter((row) => row.kind === kind)
        .map((row) => row.text)
        .join('');
    return { text: join('TEXT'), reasoning: join('REASONING') };
  }

  // Idempotency keys

  /** Inserts the key, or returns the row that already holds it. An expired key counts as free. */
  async claimKey(input: { userId: string; key: string; requestHash: string; now: Date; expiresAt: Date }): Promise<KeyClaim> {
    const { userId, key, requestHash, now, expiresAt } = input;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.prisma.idempotencyKey.deleteMany({ where: { userId, key, expiresAt: { lt: now } } });
      try {
        const row = await this.prisma.idempotencyKey.create({ data: { userId, key, requestHash, expiresAt } });
        return { claimed: true, row };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const row = await this.prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
        if (row) return { claimed: false, row };
        // The other row vanished between the insert and the read; try once more.
      }
    }
    throw new Error('Could not claim the idempotency key');
  }

  async rememberMessage(claimId: string, conversationId: string, messageId: string): Promise<void> {
    await this.prisma.idempotencyKey.update({ where: { id: claimId }, data: { conversationId, messageId } });
  }

  async rememberGeneration(claimId: string, generationId: string): Promise<void> {
    await this.prisma.idempotencyKey.update({ where: { id: claimId }, data: { generationId } });
  }

  /** Frees a key whose request failed before anything was saved, so the client can fix it and resubmit. */
  async releaseClaim(claimId: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({ where: { id: claimId, generationId: null } });
  }

  /** Takes over a claim that was started but never finished. Only one caller can win. */
  async takeOverClaim(claimId: string, staleBefore: Date, now: Date): Promise<boolean> {
    const { count } = await this.prisma.idempotencyKey.updateMany({
      where: { id: claimId, generationId: null, createdAt: { lt: staleBefore } },
      data: { createdAt: now },
    });
    return count > 0;
  }
}
