-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateEnum
CREATE TYPE "identity"."Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "identity"."SessionRevokedReason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'PASSWORD_RESET', 'PASSWORD_CHANGED', 'ADMIN');

-- CreateEnum
CREATE TYPE "identity"."UserTokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "identity"."AuthEventType" AS ENUM ('REGISTER', 'REGISTRATION_EXISTING_EMAIL', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'TOKEN_REFRESH', 'REFRESH_REUSE_DETECTED', 'SESSION_REVOKED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFIED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED');

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "identity"."Role" NOT NULL DEFAULT 'USER',
    "email_verified_at" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" "identity"."SessionRevokedReason",
    "user_agent" TEXT,
    "ip" INET,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "parent_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."user_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "identity"."UserTokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "requested_ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."auth_events" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "session_id" UUID,
    "type" "identity"."AuthEventType" NOT NULL,
    "ip" INET,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "identity"."users"("email");

-- CreateIndex
CREATE INDEX "sessions_active_user_idx" ON "identity"."sessions"("user_id")
  WHERE "revoked_at" IS NULL;

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "identity"."sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "identity"."refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "identity"."refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_parent_id_idx" ON "identity"."refresh_tokens"("parent_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "identity"."refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "identity"."user_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_tokens_user_id_purpose_created_at_idx" ON "identity"."user_tokens"("user_id", "purpose", "created_at" DESC);

-- CreateIndex
CREATE INDEX "user_tokens_expires_at_idx" ON "identity"."user_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_one_active_key" ON "identity"."user_tokens"("user_id", "purpose")
  WHERE "used_at" IS NULL AND "revoked_at" IS NULL;

-- CreateIndex
CREATE INDEX "auth_events_user_id_created_at_idx" ON "identity"."auth_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "auth_events_type_created_at_idx" ON "identity"."auth_events"("type", "created_at");

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "identity"."sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "identity"."refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."auth_events" ADD CONSTRAINT "auth_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- Hand-written section: constraints Prisma cannot express.
-- Rationale for each item: .resource/database-design.md section 9.
-- The two partial indexes above ("sessions_active_user_idx" and
-- "user_tokens_one_active_key") were also edited by hand (WHERE clauses).
-- If this migration is ever regenerated, re-apply this section and those edits.
-- =============================================================================

-- Emails are unique case-insensitively, enforced by the database (the
-- application also lowercases them).
CREATE UNIQUE INDEX "users_email_lower_key" ON "identity"."users" (lower("email"));

-- A session ends after it starts, and "revoked" and "reason" always go together.
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_expires_after_created_chk"
  CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "sessions_revoked_reason_chk"
  CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));

-- A refresh token expires after it is issued and cannot be used before it exists.
ALTER TABLE "identity"."refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_expires_after_created_chk"
  CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "refresh_tokens_used_after_created_chk"
  CHECK ("used_at" IS NULL OR "used_at" >= "created_at");

-- A one-time token expires after it is issued, and cannot be both used and
-- revoked (it is either consumed or superseded).
ALTER TABLE "identity"."user_tokens"
  ADD CONSTRAINT "user_tokens_expires_after_created_chk"
  CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "user_tokens_used_xor_revoked_chk"
  CHECK ("used_at" IS NULL OR "revoked_at" IS NULL);
