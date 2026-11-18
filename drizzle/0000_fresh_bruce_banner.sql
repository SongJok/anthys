CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_key" text NOT NULL,
	"conversation_type" varchar(1) NOT NULL,
	"title" text,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_conversation_key_unique" UNIQUE("conversation_key")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"reasoning" text,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bystander_policies" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"bystander_enabled" boolean DEFAULT true NOT NULL,
	"proactive_reply_enabled" boolean DEFAULT true NOT NULL,
	"silent_investigation_enabled" boolean DEFAULT true NOT NULL,
	"sliding_window_size" integer DEFAULT 20 NOT NULL,
	"cooldown_seconds" integer DEFAULT 180 NOT NULL,
	"confidence_threshold" real DEFAULT 0.82 NOT NULL,
	"trigger_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"covered_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(16) NOT NULL,
	"subject_key" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1536),
	"shareable_in_group" boolean DEFAULT false NOT NULL,
	"sensitivity" varchar(16) DEFAULT 'normal' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"source_conversation_id" text,
	"source_conversation_type" varchar(2),
	"source_message_id" text,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_staff_id" text NOT NULL,
	"admin_nick" text DEFAULT '' NOT NULL,
	"action_type" varchar(32) NOT NULL,
	"before_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "react_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"sender_staff_id" text DEFAULT '' NOT NULL,
	"sender_nick" text DEFAULT '' NOT NULL,
	"conversation_type" varchar(1) NOT NULL,
	"proactive" boolean DEFAULT false NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sys_configs" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text DEFAULT '' NOT NULL,
	"sender_staff_id" text DEFAULT '' NOT NULL,
	"sender_nick" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"conversation_type" varchar(1) DEFAULT '2' NOT NULL,
	"kind" varchar(20) DEFAULT 'prompt' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"prompt" text NOT NULL,
	"interval_seconds" integer,
	"cron" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dws_identities" (
	"staff_id" text PRIMARY KEY NOT NULL,
	"consent_version" integer NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"write_enabled" boolean DEFAULT false NOT NULL,
	"write_opt_out" boolean DEFAULT false NOT NULL,
	"home_dir" text NOT NULL,
	"corp_id" text,
	"dws_user_id" text,
	"profile" text,
	"user_name" text,
	"corp_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dws_write_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"staff_id" text NOT NULL,
	"message" jsonb NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"risk" text NOT NULL,
	"state" text DEFAULT 'waiting_auth' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dws_write_tasks_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
CREATE TABLE "person_identities" (
	"person_key" text PRIMARY KEY NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"merged_into" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_identity_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"person_key" text NOT NULL,
	"source" varchar(16) NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(16) NOT NULL,
	"subject_key" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role_prompt" text DEFAULT '' NOT NULL,
	"speaking_style" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_memory_consents" (
	"person_key" text PRIMARY KEY NOT NULL,
	"group_sharing" varchar(16) DEFAULT 'shareable' NOT NULL,
	"allowed_conversation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_preferences" (
	"person_key" text PRIMARY KEY NOT NULL,
	"reply_length" varchar(16) DEFAULT 'balanced' NOT NULL,
	"language" varchar(8) DEFAULT 'auto' NOT NULL,
	"address_as" text DEFAULT '' NOT NULL,
	"extra_instructions" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dingtalk_group_directory" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"bots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bot_count" integer DEFAULT 0 NOT NULL,
	"source" varchar(16) DEFAULT 'dws' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"owner_person_key" text,
	"owner_name" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_model_routes" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"provider" varchar(24) DEFAULT '' NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"api_key_env" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"temperature" real,
	"thinking" varchar(8) DEFAULT '' NOT NULL,
	"max_tokens" integer,
	"updated_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"goal_id" text,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'todo' NOT NULL,
	"assignee_person_key" text,
	"assignee_name" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_workspaces" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"responsibilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"conversation_type" varchar(1) DEFAULT '1' NOT NULL,
	"sender_staff_id" text DEFAULT '' NOT NULL,
	"sender_nick" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"priced" boolean DEFAULT false NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"proactive" boolean DEFAULT false NOT NULL,
	"job_id" text,
	"job_kind" varchar(24),
	"worker" varchar(24),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_shared_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"standard_name" text NOT NULL,
	"name_key" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"definition" text DEFAULT '' NOT NULL,
	"usage_scenarios" text DEFAULT '' NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"misconceptions" text DEFAULT '' NOT NULL,
	"department" text DEFAULT '' NOT NULL,
	"timeliness" varchar(16) DEFAULT 'long_term' NOT NULL,
	"sensitivity" varchar(16) DEFAULT 'team' NOT NULL,
	"doc_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inject_to_prompt" boolean DEFAULT true NOT NULL,
	"prompt_priority" integer DEFAULT 0 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"standard_name" text NOT NULL,
	"name_key" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"definition" text DEFAULT '' NOT NULL,
	"usage_scenarios" text DEFAULT '' NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"misconceptions" text DEFAULT '' NOT NULL,
	"department" text DEFAULT '' NOT NULL,
	"timeliness" varchar(16) DEFAULT 'long_term' NOT NULL,
	"sensitivity" varchar(16) DEFAULT 'team' NOT NULL,
	"doc_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inject_to_prompt" boolean DEFAULT true NOT NULL,
	"prompt_priority" integer DEFAULT 0 NOT NULL,
	"source_conversation_id" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"submitted_by" text DEFAULT '' NOT NULL,
	"reviewed_by" text DEFAULT '' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_note" text DEFAULT '' NOT NULL,
	"glossary_term_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" text NOT NULL,
	"conversation_id" text DEFAULT '' NOT NULL,
	"sender_staff_id" text DEFAULT '' NOT NULL,
	"action" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text DEFAULT '0.0.0' NOT NULL,
	"source" varchar(16) NOT NULL,
	"plugin_id" text,
	"path" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{"name":"","description":""}'::jsonb NOT NULL,
	"body_hash" text DEFAULT '' NOT NULL,
	"module" varchar(32) DEFAULT 'other' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"visibility" varchar(16) DEFAULT 'public' NOT NULL,
	"load_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_versions" (
	"plugin_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"dir" text NOT NULL,
	"checksum" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'installed' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active_version" text NOT NULL,
	"status" varchar(16) DEFAULT 'installed' NOT NULL,
	"manifest" jsonb NOT NULL,
	"installed_by" text DEFAULT '' NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"kind" varchar(16) DEFAULT 'code' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(path, '') || ' ' || coalesce(symbol, '') || ' ' || coalesce(content, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "project_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"language" varchar(32) DEFAULT 'other' NOT NULL,
	"kind" varchar(16) DEFAULT 'code' NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_handbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"commit_sha" text DEFAULT '' NOT NULL,
	"content" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by" varchar(16) DEFAULT 'manual' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_manual_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"section" varchar(32) NOT NULL,
	"title" text NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"visibility" varchar(16) DEFAULT 'team' NOT NULL,
	"sensitivity" varchar(16) DEFAULT 'team' NOT NULL,
	"inject_to_brief" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'building' NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" integer DEFAULT 0 NOT NULL,
	"symbol_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_symbols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(32) DEFAULT 'unknown' NOT NULL,
	"start_line" integer DEFAULT 0 NOT NULL,
	"end_line" integer DEFAULT 0 NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"parent" text DEFAULT '' NOT NULL,
	"exported" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"snapshot_id" uuid,
	"stats" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_type" varchar(16) NOT NULL,
	"source_config" jsonb DEFAULT '{"type":"manual"}'::jsonb NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"owner_staff_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" varchar(16) DEFAULT 'team' NOT NULL,
	"sensitivity" varchar(16) DEFAULT 'team' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_sync_minutes" integer DEFAULT 0 NOT NULL,
	"active_snapshot_id" uuid,
	"last_commit" text DEFAULT '' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"handbook_version" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_job_events" (
	"seq" serial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"type" varchar(32) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"conversation_type" varchar(1) DEFAULT '2' NOT NULL,
	"message_id" text DEFAULT '' NOT NULL,
	"sender_staff_id" text DEFAULT '' NOT NULL,
	"sender_nick" text DEFAULT '' NOT NULL,
	"kind" varchar(24) DEFAULT 'task' NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"prompt" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"conversation_type" varchar(1) DEFAULT '2' NOT NULL,
	"task_id" text,
	"sender_staff_id" text DEFAULT '' NOT NULL,
	"sender_nick" text DEFAULT '' NOT NULL,
	"kind" varchar(24) DEFAULT 'task' NOT NULL,
	"worker" text,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" varchar(16) DEFAULT 'other' NOT NULL,
	"ref" text NOT NULL,
	"label" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_task_subscriptions" (
	"task_id" uuid NOT NULL,
	"staff_id" text NOT NULL,
	"nick" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_task_subscriptions_task_id_staff_id_pk" PRIMARY KEY("task_id","staff_id")
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"conversation_type" varchar(1) DEFAULT '1' NOT NULL,
	"owner_staff_id" text DEFAULT '' NOT NULL,
	"owner_nick" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" varchar(16) NOT NULL,
	"requested_by" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "silent_investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"trigger_message_id" text NOT NULL,
	"sender_staff_id" text NOT NULL,
	"query" text NOT NULL,
	"status" text NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"evidence_score" real DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_whitelist" (
	"staff_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"dept_path" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"source" varchar(24) DEFAULT 'directory' NOT NULL,
	"open_ding_talk_id" text,
	"note" text DEFAULT '' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identity_aliases" ADD CONSTRAINT "person_identity_aliases_person_key_person_identities_person_key_fk" FOREIGN KEY ("person_key") REFERENCES "public"."person_identities"("person_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_job_events" ADD CONSTRAINT "agent_job_events_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_links" ADD CONSTRAINT "agent_task_links_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_subscriptions" ADD CONSTRAINT "agent_task_subscriptions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_updated_at_idx" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_summaries_conversation_created_idx" ON "conversation_summaries" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_memories_identity_idx" ON "semantic_memories" USING btree ("scope","subject_key","kind","content");--> statement-breakpoint
CREATE INDEX "semantic_memories_subject_idx" ON "semantic_memories" USING btree ("scope","subject_key");--> statement-breakpoint
CREATE INDEX "semantic_memories_embedding_idx" ON "semantic_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_idx" ON "admin_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "react_traces_created_idx" ON "react_traces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "react_traces_conversation_created_idx" ON "react_traces" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "user_feedback_created_idx" ON "user_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_next_run_idx" ON "scheduled_tasks" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "person_identity_aliases_person_idx" ON "person_identity_aliases" USING btree ("person_key");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_profiles_scope_subject_idx" ON "persona_profiles" USING btree ("scope","subject_key");--> statement-breakpoint
CREATE INDEX "persona_profiles_scope_idx" ON "persona_profiles" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "dingtalk_group_directory_name_idx" ON "dingtalk_group_directory" USING btree ("name");--> statement-breakpoint
CREATE INDEX "dingtalk_group_directory_bot_count_idx" ON "dingtalk_group_directory" USING btree ("bot_count");--> statement-breakpoint
CREATE INDEX "group_goals_conversation_idx" ON "group_goals" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "group_tasks_conversation_idx" ON "group_tasks" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "group_tasks_status_idx" ON "group_tasks" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "group_tasks_goal_idx" ON "group_tasks" USING btree ("conversation_id","goal_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_created_idx" ON "usage_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_user_created_idx" ON "usage_ledger" USING btree ("sender_staff_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_conversation_created_idx" ON "usage_ledger" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "cluster_shared_state_expires_idx" ON "cluster_shared_state" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_terms_name_key_idx" ON "glossary_terms" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "glossary_terms_status_idx" ON "glossary_terms" USING btree ("timeliness","sensitivity");--> statement-breakpoint
CREATE INDEX "glossary_terms_prompt_idx" ON "glossary_terms" USING btree ("inject_to_prompt","prompt_priority");--> statement-breakpoint
CREATE INDEX "glossary_terms_embedding_idx" ON "glossary_terms" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "glossary_candidates_status_idx" ON "glossary_candidates" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "glossary_candidates_name_idx" ON "glossary_candidates" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "skill_usage_skill_created_idx" ON "skill_usage" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_source_idx" ON "skills" USING btree ("source","name");--> statement-breakpoint
CREATE INDEX "skills_enabled_idx" ON "skills" USING btree ("enabled","visibility");--> statement-breakpoint
CREATE INDEX "skills_module_idx" ON "skills" USING btree ("module","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_versions_pk_idx" ON "plugin_versions" USING btree ("plugin_id","version");--> statement-breakpoint
CREATE INDEX "plugin_versions_status_idx" ON "plugin_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "project_chunks_snapshot_path_idx" ON "project_chunks" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "project_chunks_symbol_idx" ON "project_chunks" USING btree ("snapshot_id","symbol");--> statement-breakpoint
CREATE INDEX "project_chunks_tsv_idx" ON "project_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "project_chunks_trgm_idx" ON "project_chunks" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "project_chunks_embedding_idx" ON "project_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "project_documents_path_idx" ON "project_documents" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "project_documents_language_idx" ON "project_documents" USING btree ("snapshot_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX "project_handbooks_version_idx" ON "project_handbooks" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "project_handbooks_status_idx" ON "project_handbooks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_manual_project_section_idx" ON "project_manual_entries" USING btree ("project_id","section");--> statement-breakpoint
CREATE UNIQUE INDEX "project_snapshots_commit_idx" ON "project_snapshots" USING btree ("project_id","commit_sha");--> statement-breakpoint
CREATE INDEX "project_snapshots_status_idx" ON "project_snapshots" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_symbols_name_idx" ON "project_symbols" USING btree ("snapshot_id","name");--> statement-breakpoint
CREATE INDEX "project_symbols_path_idx" ON "project_symbols" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "project_sync_jobs_project_created_idx" ON "project_sync_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_sync_jobs_status_idx" ON "project_sync_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_job_events_job_seq_idx" ON "agent_job_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "agent_jobs_claim_idx" ON "agent_jobs" USING btree ("status","available_at","priority","created_at");--> statement-breakpoint
CREATE INDEX "agent_jobs_conversation_created_idx" ON "agent_jobs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_results_job_idx" ON "task_results" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "task_results_conversation_completed_idx" ON "task_results" USING btree ("conversation_id","completed_at");--> statement-breakpoint
CREATE INDEX "task_results_sender_completed_idx" ON "task_results" USING btree ("sender_staff_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_links_unique_idx" ON "agent_task_links" USING btree ("task_id","kind","ref");--> statement-breakpoint
CREATE INDEX "agent_task_links_task_idx" ON "agent_task_links" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_task_links_ref_idx" ON "agent_task_links" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "agent_task_subscriptions_staff_idx" ON "agent_task_subscriptions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_conversation_updated_idx" ON "agent_tasks" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_owner_updated_idx" ON "agent_tasks" USING btree ("owner_staff_id","updated_at");--> statement-breakpoint
CREATE INDEX "pending_actions_conv_idx" ON "pending_actions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "pending_actions_expires_idx" ON "pending_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "silent_investigations_conversation_idx" ON "silent_investigations" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "silent_investigations_status_idx" ON "silent_investigations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "user_whitelist_status_idx" ON "user_whitelist" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_whitelist_open_id_idx" ON "user_whitelist" USING btree ("open_ding_talk_id");--> statement-breakpoint
CREATE INDEX "user_whitelist_name_idx" ON "user_whitelist" USING btree ("name");