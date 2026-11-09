import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppException } from './app.exception.js';

export interface ErrorBody {
  statusCode: number;
  error: { code: string; message: string; details?: unknown };
}

const STATUS_CODES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

/**
 * Turns every error into one response shape with a stable code. Unknown errors
 * become a generic 500; details go to the log only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppException) {
      response.status(exception.getStatus()).json(
        this.body(exception.getStatus(), exception.code, exception.message, exception.details),
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      // Health checks return their own body; keep it.
      if (typeof payload === 'object' && payload !== null && 'status' in payload) {
        response.status(status).json(payload);
        return;
      }
      const code = STATUS_CODES[status] ?? 'HTTP_ERROR';
      const message = status === HttpStatus.TOO_MANY_REQUESTS ? 'Too many requests. Please slow down.' : exception.message;
      response.status(status).json(this.body(status, code, message));
      return;
    }

    this.logger.error(
      'Unhandled error',
      exception instanceof Error ? exception.stack : String(exception),
    );
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(this.body(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Something went wrong.'));
  }

  private body(statusCode: number, code: string, message: string, details?: unknown): ErrorBody {
    return { statusCode, error: { code, message, ...(details === undefined ? {} : { details }) } };
  }
}
