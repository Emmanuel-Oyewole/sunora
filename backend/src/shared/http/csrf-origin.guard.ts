import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { AppException } from './app.exception.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie auth. Browsers send Origin (or Referer) on
 * cross-site requests, so state-changing requests must come from the web app's
 * origin. With SameSite=Lax cookies this blocks forged requests, including login CSRF.
 *
 * With no Origin or Referer, a request is allowed only if it has no cookies
 * (curl, server-to-server), since there's no session to forge.
 *
 * Outside production the API's own origin is also allowed, so Swagger UI works.
 * Attackers can't use this: the browser sets Origin to their site, never our Host.
 */
@Injectable()
export class CsrfOriginGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = this.originOf(req);
    if (origin !== undefined) {
      if (origin === this.env.webOrigin || this.isOwnOriginAllowed(req, origin)) return true;
      throw new AppException('CSRF_ORIGIN_MISMATCH', HttpStatus.FORBIDDEN, 'Request origin is not allowed.');
    }
    if (!req.headers.cookie) return true;
    throw new AppException('CSRF_ORIGIN_MISSING', HttpStatus.FORBIDDEN, 'Request origin is missing.');
  }

  private isOwnOriginAllowed(req: Request, origin: string): boolean {
    return this.env.nodeEnv !== 'production' && origin === `${req.protocol}://${req.get('host')}`;
  }

  private originOf(req: Request): string | undefined {
    const origin = req.get('origin');
    if (origin) return origin;
    const referer = req.get('referer');
    if (!referer) return undefined;
    try {
      return new URL(referer).origin;
    } catch {
      return 'invalid';
    }
  }
}
