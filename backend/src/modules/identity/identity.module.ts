import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_ENV, type AppEnv } from '../../shared/config/env.js';
import { NotificationsModule } from '../notifications/index.js';
import { AuthEventsRepository } from './auth-events.repository.js';
import { AuthCookies } from './auth/auth-cookies.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { PasswordService } from './auth/password.service.js';
import { TokenService } from './auth/token.service.js';
import { Clock, SystemClock } from './clock.js';
import { SessionsRepository } from './sessions.repository.js';
import { UserTokensRepository } from './user-tokens.repository.js';
import { UserRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => ({ secret: env.auth.jwtSecret }),
    }),
    NotificationsModule,
  ],
  controllers: [AuthController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    UserRepository,
    UsersService,
    SessionsRepository,
    UserTokensRepository,
    AuthEventsRepository,
    PasswordService,
    TokenService,
    AuthCookies,
    AuthService,
    JwtStrategy,
  ],
})
export class IdentityModule {}
