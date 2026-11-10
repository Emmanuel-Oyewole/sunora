// Public API of the conversations module. Other modules import only from here.
export { ConversationsModule } from './conversations.module.js';
export {
  ConversationsFacade,
  type AppendAssistantMessageRequest,
  type AppendUserMessageRequest,
  type AppendedMessage,
  type ConversationMessage,
  type MessageRole,
} from './contracts/conversations.facade.js';
