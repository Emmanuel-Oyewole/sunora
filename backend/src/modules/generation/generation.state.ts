import type { GenerationStatus } from '../../generated/prisma/client.js';

/** The only place that says which status changes are allowed. Terminal states are final. */
const NEXT: Record<GenerationStatus, readonly GenerationStatus[]> = {
  PENDING: ['RUNNING', 'CANCELLED', 'INTERRUPTED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

export const ACTIVE_STATUSES: readonly GenerationStatus[] = ['PENDING', 'RUNNING'];
/** Statuses a user can retry from. */
export const RETRYABLE_STATUSES: readonly GenerationStatus[] = ['FAILED', 'INTERRUPTED', 'CANCELLED'];

export const canTransition = (from: GenerationStatus, to: GenerationStatus): boolean => NEXT[from].includes(to);
export const isActive = (status: GenerationStatus): boolean => ACTIVE_STATUSES.includes(status);
export const isTerminal = (status: GenerationStatus): boolean => !isActive(status);
