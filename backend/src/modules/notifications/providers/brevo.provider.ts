import { BrevoClient, BrevoError, BrevoTimeoutError, type Brevo } from '@getbrevo/brevo';
import { EmailProvider, EmailSendError, type OutboundEmail, type SendResult } from './email-provider.port.js';

const REQUEST_TIMEOUT_SECONDS = 10;

export interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
}

/** The part of the SDK client this adapter uses, so tests can supply a stand-in. */
export interface BrevoMailer {
  transactionalEmails: {
    sendTransacEmail(request: Brevo.SendTransacEmailRequest): PromiseLike<Brevo.SendTransacEmailResponse>;
  };
}

/**
 * Sends through Brevo's official SDK. We render the subject and HTML ourselves;
 * Brevo only delivers. Only `htmlContent` is sent (Brevo takes one body type per
 * request). The sender must be verified in your Brevo account.
 *
 * SDK retries are off (`maxRetries: 0`) because the delivery pipeline owns
 * retries. We only classify each failure.
 *
 * SDK error messages contain the response body, which can echo the recipient.
 * So errors are rebuilt from the status code and Brevo's error code only.
 */
export class BrevoEmailProvider extends EmailProvider {
  private readonly mailer: BrevoMailer;

  constructor(
    private readonly config: BrevoConfig,
    mailer?: BrevoMailer,
  ) {
    super();
    this.mailer =
      mailer ??
      new BrevoClient({
        apiKey: config.apiKey,
        maxRetries: 0,
        timeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
      });
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    try {
      const response = await this.mailer.transactionalEmails.sendTransacEmail({
        sender: { name: this.config.senderName, email: this.config.senderEmail },
        to: [email.to.name ? { email: email.to.email, name: email.to.name } : { email: email.to.email }],
        subject: email.subject,
        htmlContent: email.html,
      });
      return { providerMessageId: response.messageId };
    } catch (error) {
      throw classify(error);
    }
  }
}

const SAFE_CODE = /^[a-z0-9_]{1,64}$/i;

function classify(error: unknown): EmailSendError {
  if (error instanceof BrevoTimeoutError) {
    return new EmailSendError('Brevo request timed out', true);
  }
  if (error instanceof BrevoError) {
    const status = error.statusCode;
    // No status means the request never got an HTTP answer (connection failure).
    if (status === undefined) return new EmailSendError('Brevo request failed (network error)', true);

    const retryable = status === 408 || status === 429 || status >= 500;
    const code = (error.body as { code?: unknown } | null | undefined)?.code;
    const suffix = typeof code === 'string' && SAFE_CODE.test(code) ? `, code ${code}` : '';
    return new EmailSendError(`Brevo rejected the request (HTTP ${status}${suffix})`, retryable, status);
  }
  // Not an SDK error, probably a network failure, so allow a retry.
  return new EmailSendError('Brevo request failed (unexpected error)', true);
}
