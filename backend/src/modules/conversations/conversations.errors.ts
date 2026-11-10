import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../shared/http/app.exception.js';

/** Same error for a missing, deleted or someone else's conversation, so ids can't be probed. */
export const conversationNotFound = () =>
  new AppException('CONVERSATION_NOT_FOUND', HttpStatus.NOT_FOUND, 'Conversation not found.');

export const messageNotFound = () =>
  new AppException('MESSAGE_NOT_FOUND', HttpStatus.NOT_FOUND, 'Message not found.');

/** A user message must follow an assistant message, and the other way round. */
export const invalidMessageParent = () =>
  new AppException('INVALID_MESSAGE_PARENT', HttpStatus.UNPROCESSABLE_ENTITY, 'This message cannot follow that message.');

export const invalidMessage = (reason: string) =>
  new AppException('INVALID_MESSAGE', HttpStatus.UNPROCESSABLE_ENTITY, reason);

export const invalidCursor = () =>
  new AppException('INVALID_CURSOR', HttpStatus.BAD_REQUEST, 'The cursor is not valid.');
