import { Module } from '@nestjs/common';
import { ConversationsFacade } from './contracts/conversations.facade.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  controllers: [ConversationsController],
  providers: [
    ConversationsRepository,
    ConversationsService,
    { provide: ConversationsFacade, useExisting: ConversationsService },
  ],
  exports: [ConversationsFacade],
})
export class ConversationsModule {}
