import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../identity/index.js';
import { SubmitGenerationDto, ListGenerationsQuery } from './dto/generation.dto.js';
import { IDEMPOTENCY_KEY_PATTERN } from './generation.constants.js';
import { idempotencyKeyInvalid } from './generation.errors.js';
import { GenerationService, type StreamItem } from './generation.service.js';
import { SSE_KEEP_ALIVE, formatSse } from './sse.js';

// Starting a generation costs money, so it gets a stricter rate limit than the rest of the API.
const EXPENSIVE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('generations')
@Controller('generations')
export class GenerationController {
  private readonly logger = new Logger(GenerationController.name);

  constructor(private readonly generations: GenerationService) {}

  @Post()
  @Throttle(EXPENSIVE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a message and start the answer. Repeating it with the same Idempotency-Key is safe.',
  })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: SubmitGenerationDto,
  ) {
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) throw idempotencyKeyInvalid();
    return this.generations.submit(user.id, key, dto);
  }

  @Get()
  @ApiOperation({ summary: 'The latest attempts in a conversation, newest first. Use it to recover after a refresh.' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListGenerationsQuery) {
    return this.generations.list(user.id, query.conversationId, query.limit ?? 5);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Status of a generation, with the partial output if it did not finish.' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.generations.get(user.id, id);
  }

  @Get(':id/stream')
  @ApiOperation({
    summary: 'Server-Sent Events: saved output first, then live. Reconnect with Last-Event-ID to resume.',
  })
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());

    // Checked before any headers go out, so a missing or foreign generation is a normal 404.
    const events = await this.generations.openStream(user.id, id, parseLastEventId(lastEventId), disconnected.signal);

    res.status(HttpStatus.OK).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    try {
      for await (const item of events) res.write(toSse(item));
    } catch {
      // Headers are already sent, so all we can do is end the stream. The browser reconnects and replays.
      this.logger.warn(`Stream for generation ${id} ended with an error`);
    } finally {
      res.end();
    }
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ask to stop an answer. The returned status says whether it has stopped yet.' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.generations.cancel(user.id, id);
  }

  @Post(':id/retry')
  @Throttle(EXPENSIVE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Try again after a failed, interrupted or stopped answer. Starts a new attempt.' })
  retry(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.generations.retry(user.id, id);
  }
}

/** A bad or missing header just means "from the start". */
function parseLastEventId(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function toSse(item: StreamItem): string {
  switch (item.type) {
    case 'keepalive':
      return SSE_KEEP_ALIVE;
    case 'chunk':
      return formatSse({ id: item.seq, event: item.kind === 'TEXT' ? 'text' : 'reasoning', data: { text: item.text } });
    case 'status':
      return formatSse({
        event: 'status',
        data: { status: item.status, errorCode: item.errorCode, assistantMessageId: item.assistantMessageId },
      });
  }
}
