import { Module } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../shared/config/env.js';
import { NotificationsFacade } from './contracts/notifications.facade.js';
import { NotificationsService } from './notifications.service.js';
import { BrevoEmailProvider } from './providers/brevo.provider.js';
import { ConsoleEmailProvider } from './providers/console.provider.js';
import { EmailProvider } from './providers/email-provider.port.js';
import { DEFAULT_RETRY_POLICY, RETRY_POLICY } from './retry.js';

export function createEmailProvider(env: AppEnv): EmailProvider {
  if (env.email.provider === 'brevo' && env.email.brevo) {
    return new BrevoEmailProvider(env.email.brevo);
  }
  return new ConsoleEmailProvider();
}

@Module({
  providers: [
    { provide: EmailProvider, inject: [APP_ENV], useFactory: createEmailProvider },
    { provide: RETRY_POLICY, useValue: DEFAULT_RETRY_POLICY },
    NotificationsService,
    { provide: NotificationsFacade, useExisting: NotificationsService },
  ],
  exports: [NotificationsFacade],
})
export class NotificationsModule {}
