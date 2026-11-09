import { Brevo, BrevoError, BrevoTimeoutError } from '@getbrevo/brevo';
import { BrevoEmailProvider, type BrevoMailer } from './brevo.provider.js';
import { EmailSendError, type OutboundEmail } from './email-provider.port.js';

const config = { apiKey: 'xkeysib-secret-key', senderEmail: 'no-reply@sunora.app', senderName: 'Sunora' };
const email: OutboundEmail = {
  to: { email: 'ada@example.com', name: 'Ada' },
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
};

const mailerWith = (sendTransacEmail: BrevoMailer['transactionalEmails']['sendTransacEmail']): BrevoMailer => ({
  transactionalEmails: { sendTransacEmail },
});

describe('BrevoEmailProvider', () => {
  it('sends static HTML content through the SDK and returns the message id', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '<abc@brevo>' });

    const result = await new BrevoEmailProvider(config, mailerWith(send)).send(email);

    expect(result).toEqual({ providerMessageId: '<abc@brevo>' });
    expect(send).toHaveBeenCalledWith({
      sender: { name: 'Sunora', email: 'no-reply@sunora.app' },
      to: [{ email: 'ada@example.com', name: 'Ada' }],
      subject: 'Hello',
      htmlContent: '<p>Hi</p>', // one body type per request: no textContent, no templateId
    });
  });

  it('omits the recipient name when there is none', async () => {
    const send = vi.fn().mockResolvedValue({});

    await new BrevoEmailProvider(config, mailerWith(send)).send({ ...email, to: { email: 'ada@example.com' } });

    expect(send.mock.calls[0][0].to).toEqual([{ email: 'ada@example.com' }]);
  });

  it('can be constructed with just the configuration, using the real SDK client', () => {
    expect(() => new BrevoEmailProvider(config)).not.toThrow();
  });

  describe('failure classification', () => {
    const failWith = (error: unknown) =>
      new BrevoEmailProvider(config, mailerWith(vi.fn().mockRejectedValue(error))).send(email);

    it.each([
      ['429 Too Many Requests', new Brevo.TooManyRequestsError({ code: 'too_many_requests', message: 'm' }), 429],
      ['500 Internal Server Error', new Brevo.InternalServerError({ code: 'internal', message: 'm' }), 500],
      ['an SDK error with status 503', new BrevoError({ statusCode: 503, message: 'x' }), 503],
      ['an SDK error with status 408', new BrevoError({ statusCode: 408, message: 'x' }), 408],
    ])('treats %s as retryable', async (_name, error, status) => {
      await expect(failWith(error)).rejects.toMatchObject({ retryable: true, statusCode: status });
    });

    it.each([
      ['400 Bad Request', new Brevo.BadRequestError({ code: 'invalid_parameter', message: 'm' }), 400],
      ['401 Unauthorized', new Brevo.UnauthorizedError({ code: 'unauthorized', message: 'm' }), 401],
      ['403 Forbidden', new Brevo.ForbiddenError({ code: 'forbidden', message: 'm' }), 403],
    ])('treats %s as permanent', async (_name, error, status) => {
      await expect(failWith(error)).rejects.toMatchObject({ retryable: false, statusCode: status });
    });

    it('treats a timeout as retryable', async () => {
      await expect(failWith(new BrevoTimeoutError('Timeout exceeded'))).rejects.toMatchObject({ retryable: true });
    });

    it('treats a connection failure (no HTTP status) as retryable', async () => {
      await expect(failWith(new BrevoError({ message: 'ECONNRESET' }))).rejects.toMatchObject({ retryable: true });
    });

    it('treats an unexpected non-SDK error as retryable', async () => {
      await expect(failWith(new TypeError('fetch failed'))).rejects.toMatchObject({ retryable: true });
    });

    it('never copies the SDK message, which contains the response body, into its own error', async () => {
      const sdkError = new Brevo.BadRequestError({
        code: 'invalid_parameter',
        message: 'ada@example.com is not a valid recipient',
      });
      expect(sdkError.message).toContain('ada@example.com'); // the SDK really does leak it

      const error = await failWith(sdkError).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EmailSendError);
      expect((error as Error).message).toBe('Brevo rejected the request (HTTP 400, code invalid_parameter)');
      expect((error as Error).message).not.toContain('ada@example.com');
      expect((error as Error).message).not.toContain('xkeysib');
    });

    it('ignores an error code that is not a short identifier', async () => {
      const error = await failWith(
        new Brevo.BadRequestError({ code: 'ada@example.com <script>', message: 'm' }),
      ).catch((e: unknown) => e);

      expect((error as Error).message).toBe('Brevo rejected the request (HTTP 400)');
    });
  });
});
