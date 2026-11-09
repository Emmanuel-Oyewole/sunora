/**
 * Public contract of the notifications module. Other modules use only this file,
 * never providers or templates. Each template key has typed params.
 */
export interface EmailTemplateParams {
  VERIFY_EMAIL: { name: string; verifyUrl: string; expiresInHours: number };
  PASSWORD_RESET: { name: string; resetUrl: string; expiresInMinutes: number };
  PASSWORD_CHANGED: { name: string };
  ACCOUNT_EXISTS: { name: string; signInUrl: string; resetUrl: string };
}

export type EmailTemplateKey = keyof EmailTemplateParams;

export interface EmailRecipient {
  email: string;
  name?: string;
}

export interface SendEmailRequest<K extends EmailTemplateKey = EmailTemplateKey> {
  template: K;
  to: EmailRecipient;
  params: EmailTemplateParams[K];
}

export abstract class NotificationsFacade {
  /**
   * Renders the template and queues it for delivery. Resolves once accepted, not
   * once sent. Delivery runs in the background; failures are logged, not thrown.
   */
  abstract send<K extends EmailTemplateKey>(request: SendEmailRequest<K>): Promise<void>;
}
