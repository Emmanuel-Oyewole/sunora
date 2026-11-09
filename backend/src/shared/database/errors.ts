/** True for a unique-constraint violation, whichever unique index was hit (Prisma code P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}
