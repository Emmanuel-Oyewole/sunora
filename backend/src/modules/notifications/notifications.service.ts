import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import {
  NotificationsFacade,
  type EmailTemplateKey,
  type SendEmailRequest,
} from './contracts/notifications.facade.js';
import { maskEmail } from './mask-email.js';
import { EmailProvider, EmailSendError, type OutboundEmail } from './providers/email-provider.port.js';
import { RETRY_POLICY, withRetry, type RetryPolicy } from './retry.js';
import { templates } from './templates/templates.js';

const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Renders now, sends in the background with in-memory retries. Emails are not
 * saved, so one waiting for a retry is lost if the process dies. The persisted
 * delivery table (ARCH-001 section 11.2) replaces this behind the same facade.
 */
@Injectable()
export class NotificationsService extends NotificationsFacade implements BeforeApplicationShutdown {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly provider: EmailProvider,
    @Inject(RETRY_POLICY) private readonly retryPolicy: RetryPolicy,
  ) {
    super();
  }

  send<K extends EmailTemplateKey>(request: SendEmailRequest<K>): Promise<void> {
    // Render errors are bugs, so let them reach the caller.
    const rendered = templates[request.template](request.params);
    const email: OutboundEmail = { ...rendered, to: request.to };

    const delivery: Promise<void> = this.deliver(request.template, email).finally(() => {
      this.inFlight.delete(delivery);
    });
    this.inFlight.add(delivery);
    return Promise.resolve();
  }

  /** Resolves when every email accepted so far has been delivered or given up on. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.inFlight);
  }

  async beforeApplicationShutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
    });
    await Promise.race([this.drain(), timeout]);
    clearTimeout(timer);
  }

  private async deliver(template: EmailTemplateKey, email: OutboundEmail): Promise<void> {
    let attempts = 0;
    try {
      const result = await withRetry(
        (attempt) => {
          attempts = attempt;
          return this.provider.send(email);
        },
        this.retryPolicy,
        { isRetryable: (error) => error instanceof EmailSendError && error.retryable },
      );
      this.logger.log(
        `Email sent template=${template} to=${maskEmail(email.to.email)} attempts=${attempts} messageId=${result.providerMessageId ?? 'n/a'}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Email delivery failed template=${template} to=${maskEmail(email.to.email)} attempts=${attempts} reason=${reason}`,
      );
    }
  }
}
