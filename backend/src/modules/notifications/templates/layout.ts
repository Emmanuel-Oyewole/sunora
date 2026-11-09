import type { RenderedEmail } from '../providers/email-provider.port.js';

export interface EmailContent {
  /** Short text shown by mail clients next to the subject. */
  preview: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  /** A secondary plain link, for example "Forgot your password?". */
  secondary?: { label: string; url: string };
  /** Small print under the button. */
  note?: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every dynamic value goes through this before it is placed in HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Only http(s) links are ever rendered, so a bad value cannot become a javascript: URL. */
function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Email links must use http or https');
  }
  return parsed.toString();
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Renders the shared layout (HTML and plain text) for every email. */
export function renderEmail(subject: string, content: EmailContent): RenderedEmail {
  const button = content.button && { ...content.button, url: safeUrl(content.button.url) };
  const secondary = content.secondary && { ...content.secondary, url: safeUrl(content.secondary.url) };

  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2937;">${escapeHtml(p)}</p>`)
    .join('');
  const buttonHtml = button
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-size:16px;font-weight:600;">${escapeHtml(button.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#6b7280;">Button not working? Copy and paste this link into your browser:<br><a href="${escapeHtml(button.url)}" style="color:#4f46e5;word-break:break-all;">${escapeHtml(button.url)}</a></p>`
    : '';
  const secondaryHtml = secondary
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:20px;"><a href="${escapeHtml(secondary.url)}" style="color:#4f46e5;">${escapeHtml(secondary.label)}</a></p>`
    : '';
  const noteHtml = content.note
    ? `<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:#6b7280;">${escapeHtml(content.note)}</p>`
    : '';

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6;font-family:${FONT};">` +
    `<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preview)}</span>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;"><tr><td style="padding:32px;">` +
    `<p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#4f46e5;">Sunora</p>` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;color:#111827;">${escapeHtml(content.heading)}</h1>` +
    `${paragraphs}${buttonHtml}${secondaryHtml}${noteHtml}` +
    `</td></tr></table>` +
    `<p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">You received this email because of activity on your Sunora account.</p>` +
    `</td></tr></table></body></html>`;

  const text = [
    content.heading,
    '',
    ...content.paragraphs.flatMap((p) => [p, '']),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...(secondary ? [`${secondary.label}: ${secondary.url}`, ''] : []),
    ...(content.note ? [content.note] : []),
  ]
    .join('\n')
    .trim();

  return { subject, html, text };
}
