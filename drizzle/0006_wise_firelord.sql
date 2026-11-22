CREATE TABLE "agent_job_checkpoints" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"step_index" integer NOT NULL,
	"messages_json" jsonb NOT NULL,
	"accumulated_tokens" integer DEFAULT 0 NOT NULL,
	"accumulated_input_tokens" integer DEFAULT 0 NOT NULL,
	"accumulated_output_tokens" integer DEFAULT 0 NOT NULL,
	"accumulated_cached_tokens" integer DEFAULT 0 NOT NULL,
	"accumulated_wall_ms" integer DEFAULT 0 NOT NULL,
	"activated_suites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "semantic_memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "semantic_memories" ADD COLUMN "reinforcement_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_job_checkpoints" ADD CONSTRAINT "agent_job_checkpoints_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;