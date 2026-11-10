import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_PROMPT_LENGTH } from '../generation.constants.js';

export class SubmitGenerationDto {
  /** Leave out to start a new conversation. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** The assistant message this follows. Leave out for a first message. */
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PROMPT_LENGTH)
  content!: string;

  /** Let the model reason before answering. Slower and costlier; off by default. */
  @IsOptional()
  @IsBoolean()
  thinking?: boolean;
}

export class ListGenerationsQuery {
  @IsUUID()
  conversationId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
