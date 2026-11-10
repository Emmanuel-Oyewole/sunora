import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../identity/index.js';
import { ConversationsService } from './conversations.service.js';
import { GetConversationQuery, ListConversationsQuery, RenameConversationDto } from './dto/conversations.dto.js';

@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'List your conversations, newest first.' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListConversationsQuery) {
    return this.conversations.list(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a conversation with the messages of its active branch.' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GetConversationQuery,
  ) {
    return this.conversations.getBranch(user.id, id, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a conversation.' })
  rename(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameConversationDto,
  ) {
    return this.conversations.rename(user.id, id, dto.title);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a conversation.' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.conversations.remove(user.id, id);
  }
}
