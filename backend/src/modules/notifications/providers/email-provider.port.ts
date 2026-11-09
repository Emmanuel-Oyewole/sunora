import type { EmailRecipient } from '../contracts/notifications.facade.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  /** Plain-text version. Used by the console provider; Brevo is sent the HTML only (see brevo.provider.ts). */
  text: string;
}

export interface OutboundEmail extends RenderedEmail {
  to: EmailRecipient;
}

export interface SendResult {
  providerMessageId?: string;
}

/** Thrown by providers. `retryable` tells the delivery pipeline whether another attempt can help. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** Port: how an email leaves the system. Adapters: console (development), Brevo (real delivery). */
export abstract class EmailProvider {
  abstract send(email: OutboundEmail): Promise<SendResult>;
}
