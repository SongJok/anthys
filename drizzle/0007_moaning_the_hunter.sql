CREATE TABLE "testcase_workspace_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_revision" integer NOT NULL,
	"label" varchar(200),
	"document_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testcase_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(300) NOT NULL,
	"conversation_id" text NOT NULL,
	"conversation_type" varchar(1) NOT NULL,
	"owner_staff_id" text NOT NULL,
	"project_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"state_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testcase_workspace_versions" ADD CONSTRAINT "testcase_workspace_versions_workspace_id_testcase_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."testcase_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "testcase_workspace_versions_unique_idx" ON "testcase_workspace_versions" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE INDEX "testcase_workspace_versions_workspace_idx" ON "testcase_workspace_versions" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE INDEX "testcase_workspaces_conversation_updated_idx" ON "testcase_workspaces" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "testcase_workspaces_owner_updated_idx" ON "testcase_workspaces" USING btree ("owner_staff_id","updated_at");