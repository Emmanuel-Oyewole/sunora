import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DbIndicator } from './indicators/db.indicator.js';
import { AppService } from './app.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly DbInicator: DbIndicator,
    private readonly appService: AppService,
  ) {}
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.DbInicator.isHealthy('database')]);
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
