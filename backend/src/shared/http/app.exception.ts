import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An expected, client-facing error with a stable code. The message is shown to
 * users, so never put secrets or internals in it.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    status: HttpStatus,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}
