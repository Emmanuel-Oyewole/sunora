/** "john@example.com" -> "j***@example.com". For logs: full addresses are personal data. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
