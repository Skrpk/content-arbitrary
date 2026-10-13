CREATE TABLE "assistant_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"processed_post_id" integer,
	"user_id" integer,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_requests_status_check" CHECK ("assistant_requests"."status" IN ('ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_requests_user_created_idx" ON "assistant_requests" USING btree ("user_id","created_at");