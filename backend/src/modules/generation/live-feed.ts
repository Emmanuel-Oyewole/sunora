import { Injectable } from '@nestjs/common';
import type { GenerationStatus } from '../../generated/prisma/client.js';

export type LiveEvent =
  | { type: 'chunk'; seq: number; kind: 'TEXT' | 'REASONING'; text: string }
  | { type: 'status'; status: GenerationStatus; errorCode: string | null; assistantMessageId: string | null };

type Listener = (event: LiveEvent) => void;

/**
 * In-memory fan-out of what a running generation produces, so connected
 * browsers get new text as soon as it is written. Nothing here is the source of
 * truth: the database chunks are, and a browser that misses events replays from them.
 */
@Injectable()
export class GenerationLiveFeed {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(generationId: string, listener: Listener): () => void {
    const set = this.listeners.get(generationId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(generationId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(generationId);
    };
  }

  publish(generationId: string, event: LiveEvent): void {
    for (const listener of this.listeners.get(generationId) ?? []) listener(event);
  }
}
