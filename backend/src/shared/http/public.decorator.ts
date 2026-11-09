import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'sunora:isPublic';

/** Skips the global JWT guard. Routes are protected by default, so forgetting this gives a 401, not an open route. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
