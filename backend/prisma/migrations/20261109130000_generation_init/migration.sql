-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "generation";

-- CreateEnum
CREATE TYPE "generation"."GenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED');

-- CreateEnum
CREATE TYPE "generation"."GenerationTrigger" AS ENUM ('INITIAL', 'RETRY', 'REGENERATE');

-- CreateEnum
CREATE TYPE "generation"."ChunkKind" AS ENUM ('TEXT', 'REASONING');

-- CreateTable
CREATE TABLE "generation"."generations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_message_id" UUID NOT NULL,
    "assistant_message_id" UUID,
    "attempt_number" INTEGER NOT NULL,
    "trigger" "generation"."GenerationTrigger" NOT NULL,
    "status" "generation"."GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "thinking" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "finish_reason" TEXT,
    "owner_instance_id" TEXT,
    "heartbeat_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation"."generation_chunks" (
    "generation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "generation"."ChunkKind" NOT NULL DEFAULT 'TEXT',
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_chunks_pkey" PRIMARY KEY ("generation_id","seq")
);

-- CreateTable
CREATE TABLE "generation"."idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "message_id" UUID,
    "generation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generations_user_id_conversation_id_created_at_idx" ON "generation"."generations"("user_id", "conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "generations_active_sweep_idx" ON "generation"."generations"("status", "heartbeat_at")
  WHERE "status" IN ('PENDING', 'RUNNING');

-- CreateIndex
CREATE INDEX "generations_active_user_idx" ON "generation"."generations"("user_id")
  WHERE "status" IN ('PENDING', 'RUNNING');

-- CreateIndex
CREATE UNIQUE INDEX "generations_user_message_id_attempt_number_key" ON "generation"."generations"("user_message_id", "attempt_number");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "generation"."idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "generation"."idempotency_keys"("user_id", "key");

-- AddForeignKey
ALTER TABLE "generation"."generation_chunks" ADD CONSTRAINT "generation_chunks_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generation"."generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generation"."generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written section: constraints Prisma cannot express.
-- Rationale for each item: docs/database-design.md section 9.
-- The partial indexes "generations_active_sweep_idx" and
-- "generations_active_user_idx" above were also edited by hand (WHERE clauses).
-- If this migration is ever regenerated, re-apply this section and those edits.
-- =============================================================================

-- Attempts count from 1. A finished generation has a finish time and an active
-- one does not. Only a completed generation points at its answer.
ALTER TABLE "generation"."generations"
  ADD CONSTRAINT "generations_attempt_number_chk"
  CHECK ("attempt_number" >= 1),
  ADD CONSTRAINT "generations_finished_at_chk"
  CHECK (("status" IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')) = ("finished_at" IS NOT NULL)),
  ADD CONSTRAINT "generations_assistant_message_chk"
  CHECK ("assistant_message_id" IS NULL OR "status" = 'COMPLETED');

-- Chunks are numbered from 1 and each one is small (they are written in batches).
ALTER TABLE "generation"."generation_chunks"
  ADD CONSTRAINT "generation_chunks_seq_chk"
  CHECK ("seq" >= 1),
  ADD CONSTRAINT "generation_chunks_text_length_chk"
  CHECK (length("text") <= 20000);

-- Idempotency keys come from the client, so they are bounded.
ALTER TABLE "generation"."idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_key_length_chk"
  CHECK (length("key") BETWEEN 1 AND 128);
