CREATE TABLE "bot_pending_inputs" (
	"telegram_user_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_pending_inputs_kind_check" CHECK ("bot_pending_inputs"."kind" IN ('profile_replace', 'profile_refine', 'language_custom'))
);
--> statement-breakpoint
ALTER TABLE "bot_pending_inputs" ADD CONSTRAINT "bot_pending_inputs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;