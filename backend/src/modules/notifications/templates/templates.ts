import type { EmailTemplateKey, EmailTemplateParams } from '../contracts/notifications.facade.js';
import type { RenderedEmail } from '../providers/email-provider.port.js';
import { renderEmail } from './layout.js';

type Renderers = { [K in EmailTemplateKey]: (params: EmailTemplateParams[K]) => RenderedEmail };

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Email templates live in code, so they're versioned, reviewed and tested with
 * the app. The typed `Renderers` map ensures every key has a matching renderer.
 */
export const templates: Renderers = {
  VERIFY_EMAIL: ({ name, verifyUrl, expiresInHours }) =>
    renderEmail('Verify your email address', {
      preview: 'Confirm your email address to finish setting up your account.',
      heading: 'Verify your email address',
      paragraphs: [
        `Hi ${name}, welcome to Sunora.`,
        'Confirm your email address to finish setting up your account.',
      ],
      button: { label: 'Verify email address', url: verifyUrl },
      note: `This link expires in ${plural(expiresInHours, 'hour')} and can be used once. If you did not create a Sunora account, you can ignore this email.`,
    }),

  PASSWORD_RESET: ({ name, resetUrl, expiresInMinutes }) =>
    renderEmail('Reset your Sunora password', {
      preview: 'Use this link to choose a new password.',
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${name}, we received a request to reset the password for your Sunora account.`,
        'Choose a new password using the button below.',
      ],
      button: { label: 'Reset password', url: resetUrl },
      note: `This link expires in ${plural(expiresInMinutes, 'minute')} and can be used once. If you did not ask for this, ignore this email and your password will stay the same.`,
    }),

  PASSWORD_CHANGED: ({ name }) =>
    renderEmail('Your Sunora password was changed', {
      preview: 'Your password was changed and you were signed out everywhere.',
      heading: 'Your password was changed',
      paragraphs: [
        `Hi ${name}, the password for your Sunora account was just changed, and you were signed out of all devices.`,
        'If this was you, no action is needed. If it was not, reset your password right away and contact support.',
      ],
    }),

  ACCOUNT_EXISTS: ({ name, signInUrl, resetUrl }) =>
    renderEmail('You already have a Sunora account', {
      preview: 'Someone tried to register with your email address.',
      heading: 'You already have an account',
      paragraphs: [
        `Hi ${name}, someone (hopefully you) tried to create a Sunora account with this email address, but an account already exists.`,
        'You can sign in with your existing account.',
      ],
      button: { label: 'Sign in', url: signInUrl },
      secondary: { label: 'Forgot your password? Reset it', url: resetUrl },
      note: 'If this was not you, you can safely ignore this email. No new account was created.',
    }),
};
