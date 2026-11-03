import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './indicators/database.indicator.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness: the process is running and serving requests',
  })
  live() {
    // No dependencies on purpose: a database outage must not make an
    // orchestrator restart a process that cannot fix it.
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: the app can serve traffic (database reachable)',
  })
  ready() {
    return this.health.check([() => this.database.isHealthy('database')]);
  }
}
