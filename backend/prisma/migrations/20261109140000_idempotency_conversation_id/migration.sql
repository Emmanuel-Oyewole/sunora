-- AlterTable
-- Lets a retried submit finish when the first attempt stopped after saving the
-- message but before creating the generation: the key row now remembers both ids.
ALTER TABLE "generation"."idempotency_keys" ADD COLUMN "conversation_id" UUID;
