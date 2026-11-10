import type { Generation, GenerationChunk, GenerationStatus, IdempotencyKey } from '../../src/generated/prisma/client.js';
import type {
  KeyClaim,
  NewChunk,
  NewGeneration,
  TransitionPatch,
} from '../../src/modules/generation/generation.repository.js';
import { ACTIVE_STATUSES, canTransition, isTerminal } from '../../src/modules/generation/generation.state.js';

/**
 * In-memory stand-in for the generation repository. It copies the rules the
 * code relies on (unique attempts, conditional status changes, one winner per
 * claim), so lifecycle and HTTP tests run without Postgres. The real SQL and
 * constraints are covered by the database tests in test/integration.
 */

let counter = 0;
const id = () => `00000000-0000-7000-9000-${String(++counter).padStart(12, '0')}`;
const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const active = (status: GenerationStatus) => ACTIVE_STATUSES.includes(status);

export class InMemoryGeneration {
  generations: Generation[] = [];
  chunks: GenerationChunk[] = [];
  keys: IdempotencyKey[] = [];
  /** Set to make the next create() fail once, to test a crash half way through a submit. */
  failNextCreate = false;

  readonly repository = {
    create: (data: NewGeneration): Promise<Generation> => {
      if (this.failNextCreate) {
        this.failNextCreate = false;
        return Promise.reject(new Error('database went away'));
      }
      if (this.generations.some((g) => g.userMessageId === data.userMessageId && g.attemptNumber === data.attemptNumber)) {
        return Promise.reject(uniqueViolation());
      }
      const now = new Date();
      const row: Generation = {
        id: id(),
        ...data,
        assistantMessageId: null,
        status: 'PENDING',
        finishReason: null,
        ownerInstanceId: null,
        heartbeatAt: null,
        cancelRequestedAt: null,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.generations.push(row);
      return Promise.resolve({ ...row });
    },

    findOwned: (genId: string, userId: string) => Promise.resolve(this.copy(this.generations.find((g) => g.id === genId && g.userId === userId))),
    find: (genId: string) => Promise.resolve(this.copy(this.generations.find((g) => g.id === genId))),
    findAttempt: (userMessageId: string, attemptNumber: number) =>
      Promise.resolve(this.copy(this.generations.find((g) => g.userMessageId === userMessageId && g.attemptNumber === attemptNumber))),
    latestAttempt: (userMessageId: string) =>
      Promise.resolve(
        this.copy([...this.generations].filter((g) => g.userMessageId === userMessageId).sort((a, b) => b.attemptNumber - a.attemptNumber)[0]),
      ),

    listForConversation: (userId: string, conversationId: string, limit: number): Promise<Generation[]> =>
      Promise.resolve(
        this.generations
          .filter((g) => g.userId === userId && g.conversationId === conversationId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, limit)
          .map((g) => ({ ...g })),
      ),

    countActive: (userId: string) => Promise.resolve(this.generations.filter((g) => g.userId === userId && active(g.status)).length),

    claimRun: (genId: string, instanceId: string, now: Date): Promise<boolean> => {
      const row = this.generations.find((g) => g.id === genId && g.status === 'PENDING');
      if (!row) return Promise.resolve(false);
      Object.assign(row, { status: 'RUNNING', ownerInstanceId: instanceId, heartbeatAt: now, startedAt: now });
      return Promise.resolve(true);
    },

    transition: (genId: string, from: GenerationStatus, to: GenerationStatus, now: Date, patch: TransitionPatch = {}): Promise<boolean> => {
      if (!canTransition(from, to)) throw new Error(`Generation cannot go from ${from} to ${to}`);
      const row = this.generations.find((g) => g.id === genId && g.status === from);
      if (!row) return Promise.resolve(false);
      Object.assign(row, { status: to, ...patch, ...(isTerminal(to) && { finishedAt: now }) });
      return Promise.resolve(true);
    },

    requestCancel: (genId: string, userId: string, now: Date): Promise<boolean> => {
      const row = this.generations.find((g) => g.id === genId && g.userId === userId && active(g.status));
      if (!row) return Promise.resolve(false);
      row.cancelRequestedAt = now;
      return Promise.resolve(true);
    },

    heartbeat: (ids: string[], instanceId: string, now: Date): Promise<void> => {
      for (const row of this.generations) {
        if (ids.includes(row.id) && row.ownerInstanceId === instanceId && row.status === 'RUNNING') row.heartbeatAt = now;
      }
      return Promise.resolve();
    },

    interruptForeign: (instanceId: string, now: Date): Promise<number> => {
      const rows = this.generations.filter((g) => active(g.status) && g.ownerInstanceId !== instanceId);
      for (const row of rows) Object.assign(row, { status: 'INTERRUPTED', errorCode: 'SERVER_RESTART', finishedAt: now });
      return Promise.resolve(rows.length);
    },

    appendChunks: (rows: NewChunk[]): Promise<void> => {
      for (const row of rows) this.chunks.push({ ...row, createdAt: new Date() });
      return Promise.resolve();
    },

    chunksAfter: (genId: string, afterSeq: number, limit: number): Promise<GenerationChunk[]> =>
      Promise.resolve(
        this.chunks
          .filter((c) => c.generationId === genId && c.seq > afterSeq)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit),
      ),

    lastSeq: (genId: string) => Promise.resolve(Math.max(0, ...this.chunks.filter((c) => c.generationId === genId).map((c) => c.seq))),

    partialOutput: (genId: string) => {
      const rows = this.chunks.filter((c) => c.generationId === genId).sort((a, b) => a.seq - b.seq);
      const join = (kind: string) => rows.filter((c) => c.kind === kind).map((c) => c.text).join('');
      return Promise.resolve({ text: join('TEXT'), reasoning: join('REASONING') });
    },

    claimKey: (input: { userId: string; key: string; requestHash: string; now: Date; expiresAt: Date }): Promise<KeyClaim> => {
      this.keys = this.keys.filter((k) => !(k.userId === input.userId && k.key === input.key && k.expiresAt < input.now));
      const existing = this.keys.find((k) => k.userId === input.userId && k.key === input.key);
      if (existing) return Promise.resolve({ claimed: false, row: { ...existing } });
      const row: IdempotencyKey = {
        id: id(),
        userId: input.userId,
        key: input.key,
        requestHash: input.requestHash,
        conversationId: null,
        messageId: null,
        generationId: null,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      };
      this.keys.push(row);
      return Promise.resolve({ claimed: true, row: { ...row } });
    },

    rememberMessage: (claimId: string, conversationId: string, messageId: string): Promise<void> => {
      Object.assign(this.keys.find((k) => k.id === claimId)!, { conversationId, messageId });
      return Promise.resolve();
    },

    rememberGeneration: (claimId: string, generationId: string): Promise<void> => {
      this.keys.find((k) => k.id === claimId)!.generationId = generationId;
      return Promise.resolve();
    },

    releaseClaim: (claimId: string): Promise<void> => {
      this.keys = this.keys.filter((k) => !(k.id === claimId && k.generationId === null));
      return Promise.resolve();
    },

    takeOverClaim: (claimId: string, staleBefore: Date, now: Date): Promise<boolean> => {
      const row = this.keys.find((k) => k.id === claimId && k.generationId === null && k.createdAt < staleBefore);
      if (!row) return Promise.resolve(false);
      row.createdAt = now;
      return Promise.resolve(true);
    },
  };

  private copy(row: Generation | undefined): Generation | null {
    return row ? { ...row } : null;
  }
}
