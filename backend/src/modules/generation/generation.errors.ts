import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../shared/http/app.exception.js';

/** Same error for a missing generation and someone else's, so ids can't be probed. */
export const generationNotFound = () =>
  new AppException('GENERATION_NOT_FOUND', HttpStatus.NOT_FOUND, 'Generation not found.');

export const idempotencyKeyInvalid = () =>
  new AppException(
    'IDEMPOTENCY_KEY_REQUIRED',
    HttpStatus.BAD_REQUEST,
    'Send an Idempotency-Key header of 1 to 128 letters, digits, "-" or "_".',
  );

export const idempotencyKeyReused = () =>
  new AppException(
    'IDEMPOTENCY_KEY_REUSED',
    HttpStatus.CONFLICT,
    'This Idempotency-Key was already used for a different request.',
  );

export const requestInProgress = () =>
  new AppException('REQUEST_IN_PROGRESS', HttpStatus.CONFLICT, 'This request is still being processed. Try again shortly.');

export const tooManyActiveGenerations = () =>
  new AppException(
    'TOO_MANY_ACTIVE_GENERATIONS',
    HttpStatus.TOO_MANY_REQUESTS,
    'Wait for your current answers to finish before asking for another.',
  );

export const notLatestAttempt = () =>
  new AppException('NOT_LATEST_ATTEMPT', HttpStatus.CONFLICT, 'A newer attempt exists for this message.');

export const notRetryable = () =>
  new AppException('GENERATION_NOT_RETRYABLE', HttpStatus.CONFLICT, 'Only a failed, interrupted or stopped answer can be retried.');
