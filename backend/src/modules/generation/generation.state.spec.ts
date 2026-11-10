import type { GenerationStatus } from '../../generated/prisma/client.js';
import { canTransition, isActive, isTerminal, RETRYABLE_STATUSES } from './generation.state.js';

const ALL: GenerationStatus[] = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
const TERMINAL: GenerationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

describe('generation state machine', () => {
  it.each([
    ['PENDING', 'RUNNING'],
    ['PENDING', 'CANCELLED'],
    ['PENDING', 'INTERRUPTED'],
    ['RUNNING', 'COMPLETED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'CANCELLED'],
    ['RUNNING', 'INTERRUPTED'],
  ] as const)('allows %s to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('never leaves a terminal state', () => {
    for (const from of TERMINAL) for (const to of ALL) expect(canTransition(from, to)).toBe(false);
  });

  it('cannot skip running, or go back to pending', () => {
    expect(canTransition('PENDING', 'COMPLETED')).toBe(false);
    expect(canTransition('PENDING', 'FAILED')).toBe(false);
    expect(canTransition('RUNNING', 'PENDING')).toBe(false);
  });

  it('knows which states are active and final', () => {
    expect(ALL.filter(isActive)).toEqual(['PENDING', 'RUNNING']);
    expect(ALL.filter(isTerminal)).toEqual(TERMINAL);
  });

  it('only lets a user retry something that did not succeed', () => {
    expect([...RETRYABLE_STATUSES].sort()).toEqual(['CANCELLED', 'FAILED', 'INTERRUPTED']);
  });
});
