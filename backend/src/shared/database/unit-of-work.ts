import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** An open database transaction. Repositories accept one optionally. */
export type DbTransaction = Prisma.TransactionClient;

/**
 * Runs repository calls atomically. Repositories take an optional transaction,
 * so services can group writes without touching Prisma.
 */
@Injectable()
export class UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }
}
