CREATE TABLE "tool_execution_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_id" uuid,
	"action_id" uuid,
	"tool_name" text NOT NULL,
	"args_hash" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'executing' NOT NULL,
	"result" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "tool_execution_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "fencing_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_execution_ledger_job_idx" ON "tool_execution_ledger" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "tool_execution_ledger_settled_idx" ON "tool_execution_ledger" USING btree ("settled_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_jobs"
    WHERE "message_id" <> ''
    GROUP BY "conversation_id", "message_id", "kind"
    HAVING count(*) > 1
  ) THEN
    DELETE FROM "agent_jobs" a
    USING "agent_jobs" b
    WHERE a."message_id" <> ''
      AND a."conversation_id" = b."conversation_id"
      AND a."message_id" = b."message_id"
      AND a."kind" = b."kind"
      AND a."id" <> b."id"
      AND (
        (CASE b."status" WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END)
          < (CASE a."status" WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END)
        OR (
          (CASE b."status" WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END)
            = (CASE a."status" WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END)
          AND (b."created_at", b."id") < (a."created_at", a."id")
        )
      );
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_message_dedupe_idx" ON "agent_jobs" USING btree ("conversation_id","message_id","kind") WHERE "agent_jobs"."message_id" <> '';