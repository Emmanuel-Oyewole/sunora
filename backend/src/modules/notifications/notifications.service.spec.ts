import { Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { EmailProvider, EmailSendError, type OutboundEmail } from './providers/email-provider.port.js';

const policy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: () => Promise.resolve() };
const request = {
  template: 'PASSWORD_CHANGED' as const,
  to: { email: 'ada@example.com', name: 'Ada' },
  params: { name: 'Ada' },
};

class FakeProvider extends EmailProvider {
  sent: OutboundEmail[] = [];
  attempts = 0;
  constructor(private failures: EmailSendError[] = []) {
    super();
  }
  send(email: OutboundEmail) {
    this.attempts++;
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push(email);
    return Promise.resolve({ providerMessageId: 'm1' });
  }
}

describe('NotificationsService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the template and delivers it with the recipient', async () => {
    const provider = new FakeProvider();
    const service = new NotificationsService(provider, policy);

    await service.send(request);
    await service.drain();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ to: request.to, subject: 'Your Sunora password was changed' });
    expect(provider.sent[0].html).toContain('Ada');
  });

  it('resolves before delivery finishes: callers are not blocked on the provider', async () => {
    let release!: () => void;
    const slow = new (class extends EmailProvider {
      send() {
        return new Promise<{ providerMessageId: string }>((resolve) => {
          release = () => resolve({ providerMessageId: 'late' });
        });
      }
    })();
    const service = new NotificationsService(slow, policy);

    await service.send(request); // returns although the provider has not answered
    let drained = false;
    const draining = service.drain().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await draining;
    expect(drained).toBe(true);
  });

  it('retries retryable failures and then succeeds', async () => {
    const provider = new FakeProvider([new EmailSendError('429', true, 429), new EmailSendError('503', true, 503)]);
    const service = new NotificationsService(provider, policy);

    await service.send(request);
    await service.drain();

    expect(provider.attempts).toBe(3);
    expect(provider.sent).toHaveLength(1);
  });

  it('does not retry a permanent failure, and does not throw to the caller', async () => {
    const provider = new FakeProvider([new EmailSendError('rejected', false, 400)]);
    const service = new NotificationsService(provider, policy);

    await expect(service.send(request)).resolves.toBeUndefined();
    await service.drain();

    expect(provider.attempts).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });

  it('gives up after the maximum attempts and logs without the full address', async () => {
    const provider = new FakeProvider(Array.from({ length: 5 }, () => new EmailSendError('down', true, 503)));
    const service = new NotificationsService(provider, policy);
    const errorLog = vi.spyOn(Logger.prototype, 'error');

    await service.send(request);
    await service.drain();

    expect(provider.attempts).toBe(3);
    const message = String(errorLog.mock.calls[0][0]);
    expect(message).toContain('attempts=3');
    expect(message).toContain('a***@example.com');
    expect(message).not.toContain('ada@example.com');
  });
});
