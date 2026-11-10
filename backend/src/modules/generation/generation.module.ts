import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../shared/config/env.js';
import { ConversationsModule } from '../conversations/index.js';
import { DEFAULT_RUNNER_OPTIONS, INSTANCE_ID, RUNNER_OPTIONS } from './generation.constants.js';
import { GenerationController } from './generation.controller.js';
import { GenerationRepository } from './generation.repository.js';
import { GenerationService } from './generation.service.js';
import { GenerationRunner } from './generation-runner.js';
import { GenerationLiveFeed } from './live-feed.js';
import { AiProvider } from './providers/ai-provider.port.js';
import { DeepSeekProvider } from './providers/deepseek.provider.js';

export function createAiProvider(env: AppEnv): AiProvider {
  return new DeepSeekProvider(env.ai.deepseek);
}

@Module({
  imports: [ConversationsModule],
  controllers: [GenerationController],
  providers: [
    { provide: AiProvider, inject: [APP_ENV], useFactory: createAiProvider },
    { provide: INSTANCE_ID, useFactory: () => randomUUID() },
    { provide: RUNNER_OPTIONS, useValue: DEFAULT_RUNNER_OPTIONS },
    GenerationRepository,
    GenerationLiveFeed,
    GenerationRunner,
    GenerationService,
  ],
})
export class GenerationModule {}
