import type { EmailTemplateParams } from '../contracts/notifications.facade.js';
import { renderEmail } from './layout.js';
import { templates } from './templates.js';

const samples: { [K in keyof EmailTemplateParams]: EmailTemplateParams[K] } = {
  VERIFY_EMAIL: { name: 'Ada', verifyUrl: 'https://app.test/verify-email#token=abc', expiresInHours: 24 },
  PASSWORD_RESET: { name: 'Ada', resetUrl: 'https://app.test/reset-password#token=abc', expiresInMinutes: 30 },
  PASSWORD_CHANGED: { name: 'Ada' },
  ACCOUNT_EXISTS: { name: 'Ada', signInUrl: 'https://app.test/sign-in', resetUrl: 'https://app.test/forgot-password' },
};

describe('email templates', () => {
  it.each(Object.keys(samples) as (keyof typeof samples)[])('%s renders a subject, HTML and plain text', (key) => {
    const render = templates[key] as (params: unknown) => ReturnType<typeof renderEmail>;
    const email = render(samples[key]);

    expect(email.subject.length).toBeGreaterThan(0);
    expect(email.html).toContain('<!doctype html>');
    expect(email.html).toContain('Ada');
    expect(email.text).toContain('Ada');
    expect(email.text).not.toContain('<');
  });

  it('puts the link in both versions and states the expiry', () => {
    const email = templates.PASSWORD_RESET(samples.PASSWORD_RESET);

    expect(email.html).toContain('href="https://app.test/reset-password#token=abc"');
    expect(email.text).toContain('https://app.test/reset-password#token=abc');
    expect(email.text).toContain('30 minutes');
  });

  it('uses the singular for one hour', () => {
    expect(templates.VERIFY_EMAIL({ ...samples.VERIFY_EMAIL, expiresInHours: 1 }).text).toContain('1 hour ');
  });

  it('escapes dynamic values so a hostile name cannot inject markup', () => {
    const email = templates.PASSWORD_CHANGED({ name: '<script>alert(1)</script> & "co"' });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;');
  });

  it('refuses links that are not http(s), so a bad value cannot become a javascript: URL', () => {
    expect(() =>
      templates.VERIFY_EMAIL({ ...samples.VERIFY_EMAIL, verifyUrl: 'javascript:alert(1)' }),
    ).toThrow(/http or https/);
  });

  it('escapes quotes in link attributes', () => {
    const email = templates.VERIFY_EMAIL({
      ...samples.VERIFY_EMAIL,
      verifyUrl: 'https://app.test/x?a="b"#token=abc',
    });
    expect(email.html).not.toMatch(/href="[^"]*"[^>]*"b"/);
  });
});
