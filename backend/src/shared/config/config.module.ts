import { Global, Module } from '@nestjs/common';
import { APP_ENV, loadEnv } from './env.js';

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: () => loadEnv() }],
  exports: [APP_ENV],
})
export class AppConfigModule {}
