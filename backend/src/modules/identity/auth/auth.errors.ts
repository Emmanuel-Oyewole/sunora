import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../../shared/http/app.exception.js';

/** Same error for unknown email, wrong password and disabled account. */
export const invalidCredentials = () =>
  new AppException('INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED, 'Incorrect email or password.');

export const unauthenticated = () =>
  new AppException('UNAUTHENTICATED', HttpStatus.UNAUTHORIZED, 'Authentication required.');

/** Same error for every bad-token reason, so we don't reveal which. */
export const invalidToken = () =>
  new AppException(
    'INVALID_OR_EXPIRED_TOKEN',
    HttpStatus.BAD_REQUEST,
    'This link is invalid or has expired.',
  );
