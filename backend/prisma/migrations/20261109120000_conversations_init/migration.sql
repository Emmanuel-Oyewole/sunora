-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "conversations";

-- CreateEnum
CREATE TYPE "conversations"."TitleSource" AS ENUM ('DEFAULT', 'GENERATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "conversations"."MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "conversations"."conversations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT,
    "title_source" "conversations"."TitleSource" NOT NULL DEFAULT 'DEFAULT',
    "active_leaf_id" UUID,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations"."messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "parent_id" UUID,
    "role" "conversations"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "reasoning" TEXT,
    "depth" INTEGER NOT NULL,
    "generation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_history_idx" ON "conversations"."conversations"("owner_id", "last_message_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "messages_conversation_id_parent_id_idx" ON "conversations"."messages"("conversation_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_id_key" ON "conversations"."messages"("conversation_id", "id");

-- AddForeignKey
ALTER TABLE "conversations"."conversations" ADD CONSTRAINT "conversations_active_leaf_id_fkey" FOREIGN KEY ("active_leaf_id") REFERENCES "conversations"."messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations"."messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations"."messages" ADD CONSTRAINT "messages_conversation_id_parent_id_fkey" FOREIGN KEY ("conversation_id", "parent_id") REFERENCES "conversations"."messages"("conversation_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- =============================================================================
-- Hand-written section: constraints Prisma cannot express.
-- Rationale for each item: docs/database-design.md section 9.
-- The partial index "conversations_history_idx" above was also edited by hand
-- (WHERE clause). If this migration is ever regenerated, re-apply this section
-- and that edit.
-- =============================================================================

-- Titles are short. The API limits renames further (120); this is the backstop.
ALTER TABLE "conversations"."conversations"
  ADD CONSTRAINT "conversations_title_length_chk"
  CHECK ("title" IS NULL OR length("title") BETWEEN 1 AND 200);

-- A root has depth 0 and every other message has a parent. Sizes are backstops;
-- the API enforces the real limits.
ALTER TABLE "conversations"."messages"
  ADD CONSTRAINT "messages_depth_chk"
  CHECK ("depth" >= 0 AND (("parent_id" IS NULL) = ("depth" = 0))),
  ADD CONSTRAINT "messages_content_length_chk"
  CHECK (length("content") BETWEEN 1 AND 200000),
  ADD CONSTRAINT "messages_reasoning_chk"
  CHECK ("reasoning" IS NULL OR ("role" = 'ASSISTANT' AND length("reasoning") <= 400000));
