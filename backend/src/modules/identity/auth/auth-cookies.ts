import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { APP_ENV, type AppEnv } from '../../../shared/config/env.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.constants.js';

@Injectable()
export class AuthCookies {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  private options(path: string, maxAgeSeconds?: number): CookieOptions {
    return {
      httpOnly: true, // scripts can't read it
      secure: this.env.auth.cookieSecure,
      sameSite: 'lax',
      path,
      ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds * 1000 }),
    };
  }

  set(res: Response, tokens: { accessToken: string; refreshToken: string }): void {
    res.cookie(ACCESS_COOKIE, tokens.accessToken, this.options('/', this.env.auth.accessTtlSeconds));
    res.cookie(
      REFRESH_COOKIE,
      tokens.refreshToken,
      this.options(REFRESH_COOKIE_PATH, this.env.auth.refreshTtlSeconds),
    );
  }

  clear(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, this.options('/'));
    res.clearCookie(REFRESH_COOKIE, this.options(REFRESH_COOKIE_PATH));
  }
}
