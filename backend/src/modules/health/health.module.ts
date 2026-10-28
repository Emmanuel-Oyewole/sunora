import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { DbIndicator} from './indicators/db.indicator.js'
import { AppService } from './app.service.js';
@Module({
  imports: [ TerminusModule],
  controllers: [ HealthController ],
  providers: [ DbIndicator, AppService ],
})
export class HealthModule {}
