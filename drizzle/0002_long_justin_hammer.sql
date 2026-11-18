ALTER TABLE "pending_actions" ADD COLUMN "status" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "pending_actions_status_idx" ON "pending_actions" USING btree ("status");