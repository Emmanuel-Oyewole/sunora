import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '../mask-email.js';
import { EmailProvider, type OutboundEmail, type SendResult } from './email-provider.port.js';

/**
 * Dev adapter: prints the email instead of sending it, so verify and reset links
 * work without Brevo. It logs the body on purpose, so it's refused in production.
 */
@Injectable()
export class ConsoleEmailProvider extends EmailProvider {
  private readonly logger = new Logger('Email(console)');

  send(email: OutboundEmail): Promise<SendResult> {
    this.logger.log(
      `To: ${maskEmail(email.to.email)} | Subject: ${email.subject}\n${email.text}`,
    );
    return Promise.resolve({ providerMessageId: 'console' });
  }
}
