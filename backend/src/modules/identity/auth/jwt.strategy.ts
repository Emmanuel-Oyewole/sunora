import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-jwt';
import { APP_ENV, type AppEnv } from '../../../shared/config/env.js';
import type { AuthenticatedUser } from '../contracts/authenticated-user.js';
import { ACCESS_COOKIE, JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants.js';
import { unauthenticated } from './auth.errors.js';
import type { AccessTokenPayload } from './token.service.js';

const fromCookie = (req: Request): string | null =>
  (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE] ?? null;

/** Verifies the access-token cookie by signature, issuer, audience and expiry. No database call. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super({
      jwtFromRequest: fromCookie,
      ignoreExpiration: false,
      secretOrKey: env.auth.jwtSecret,
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    if (!payload.sub || !payload.sid) throw unauthenticated();
    return { id: payload.sub, sessionId: payload.sid, role: payload.role === 'ADMIN' ? 'ADMIN' : 'USER' };
  }
}
