/** Formats one Server-Sent Event. `id` is the chunk number, so a reconnecting browser can resume. */
export function formatSse(event: { id?: number; event: string; data: unknown }): string {
  const lines = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.event}`, `data: ${JSON.stringify(event.data)}`);
  return `${lines.join('\n')}\n\n`;
}

export const SSE_KEEP_ALIVE = ': keep-alive\n\n';
