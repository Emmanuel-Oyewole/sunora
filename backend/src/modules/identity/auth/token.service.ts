import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { APP_ENV, type AppEnv } from '../../../shared/config/env.js';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants.js';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: 'USER' | 'ADMIN';
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * Signs a short-lived access token. The algorithm is set only here and in the
   * JWT strategy, so moving to asymmetric keys is a local change.
   */
  signAccessToken(input: { userId: string; sessionId: string; role: 'USER' | 'ADMIN' }): Promise<string> {
    return this.jwt.signAsync(
      { sid: input.sessionId, role: input.role },
      {
        subject: input.userId,
        expiresIn: this.env.auth.accessTtlSeconds,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
      },
    );
  }

  /**
   * Random opaque token (256 bits). Only its SHA-256 hash is stored, so a leaked
   * database gives no usable tokens. A fast hash is fine since the input is unguessable.
   */
  generateOpaqueToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: this.hashToken(raw) };
  }

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
