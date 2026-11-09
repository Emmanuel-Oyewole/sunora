import { Injectable } from '@nestjs/common';
import type { AuthEventType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/database/prisma.service.js';

@Injectable()
export class AuthEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Never put tokens, passwords or other secrets in `metadata`. */
  async record(event: {
    type: AuthEventType;
    userId?: string;
    sessionId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void> {
    await this.prisma.authEvent.create({ data: event });
  }
}
