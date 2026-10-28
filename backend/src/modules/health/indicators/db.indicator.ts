import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../../../config/database/prisma.service.js';

@Injectable()
export class DbIndicator {
  constructor(
    private readonly healthIndicator: HealthIndicatorService,
    private readonly prismaService: PrismaService,
  ) {}

  async isHealthy(key: string, timeout: number = 2000): Promise<any> {
    const check = await this.healthIndicator.check(key);
    let timer: NodeJS.Timeout | undefined = undefined;
    try {
      await Promise.race([
        this.prismaService.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Database ping timeout')),
            timeout,
          );
        }),
      ]);
      return check.up();
    } catch (error) {
      return check.down({ message: (error as Error).message });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
