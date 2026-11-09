CREATE TABLE "threads_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"threads_user_id" text NOT NULL,
	"username" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"token_refreshed_at" timestamp with time zone NOT NULL,
	"scopes" text[] NOT NULL,
	"connected_by_user_id" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads_connect_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads_accounts" ADD CONSTRAINT "threads_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads_accounts" ADD CONSTRAINT "threads_accounts_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads_connect_attempts" ADD CONSTRAINT "threads_connect_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads_connect_attempts" ADD CONSTRAINT "threads_connect_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "threads_accounts_workspace_key" ON "threads_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "threads_accounts_threads_user_idx" ON "threads_accounts" USING btree ("threads_user_id");