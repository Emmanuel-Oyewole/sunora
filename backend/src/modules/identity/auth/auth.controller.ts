import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../../shared/http/public.decorator.js';
import type { AuthenticatedUser } from '../contracts/authenticated-user.js';
import { AuthCookies } from './auth-cookies.js';
import { REFRESH_COOKIE } from './auth.constants.js';
import { AuthService, type UserProfile } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto } from './dto/auth.dto.js';
import { Ctx, type RequestContext } from './request-context.decorator.js';

// Strict rate limits for routes that send email or check passwords.
const STRICT = { default: { limit: 5, ttl: 60_000 } };

/** Same reply for every outcome, so it can't be used to probe accounts. */
const ACCEPTED = { message: 'If this request can be completed, you will receive an email shortly.' };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: AuthCookies,
  ) {}

  @Public()
  @Throttle(STRICT)
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Create an account. Sends a verification email; does not sign the user in.' })
  async register(@Body() dto: RegisterDto, @Ctx() ctx: RequestContext) {
    await this.auth.register(dto, ctx);
    return ACCEPTED;
  }

  @Public()
  @Throttle(STRICT)
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm an email address with the token from the verification email.' })
  async verifyEmail(@Body() dto: TokenDto, @Ctx() ctx: RequestContext): Promise<void> {
    await this.auth.verifyEmail(dto.token, ctx);
  }

  @Public()
  @Throttle(STRICT)
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a new verification email. Always answers the same way.' })
  async resendVerification(@Body() dto: EmailDto, @Ctx() ctx: RequestContext) {
    await this.auth.resendVerification(dto.email, ctx);
    return ACCEPTED;
  }

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in. Sets the access and refresh token cookies.' })
  async login(
    @Body() dto: LoginDto,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: UserProfile }> {
    const { user, tokens } = await this.auth.login(dto, ctx);
    this.cookies.set(res, tokens);
    return { user };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token.' })
  async refresh(
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    try {
      this.cookies.set(res, await this.auth.refresh(this.refreshCookie(req), ctx));
    } catch (error) {
      this.cookies.clear(res); // drop the cookie of a dead session
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session and clear the cookies.' })
  async logout(
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(this.refreshCookie(req), ctx);
    this.cookies.clear(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End every session of the current user.' })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user.id, ctx);
    this.cookies.clear(res);
  }

  @Public()
  @Throttle(STRICT)
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Email a password reset link. Always answers the same way.' })
  async forgotPassword(@Body() dto: EmailDto, @Ctx() ctx: RequestContext) {
    await this.auth.forgotPassword(dto.email, ctx);
    return ACCEPTED;
  }

  @Public()
  @Throttle(STRICT)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a new password with the token from the reset email. Signs out every device.' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Ctx() ctx: RequestContext): Promise<void> {
    await this.auth.resetPassword(dto, ctx);
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user.' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfile> {
    return this.auth.getProfile(user.id);
  }

  private refreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  }
}
