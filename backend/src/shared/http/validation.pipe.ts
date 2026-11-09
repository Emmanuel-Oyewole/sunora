import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException } from './app.exception.js';

function flatten(errors: ValidationError[], parent = ''): { field: string; messages: string[] }[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints ? [{ field, messages: Object.values(error.constraints) }] : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/**
 * Strips and rejects unknown properties, converts payloads to DTOs, and returns
 * errors in the standard shape. Messages never echo the submitted value.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      new AppException(
        'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        'The request is invalid.',
        flatten(errors),
      ),
  });
}
