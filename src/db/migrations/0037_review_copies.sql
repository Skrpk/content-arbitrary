CREATE TABLE "review_copies" (
	"processed_post_id" integer NOT NULL,
	"chat_id" text NOT NULL,
	"control_message_id" bigint NOT NULL,
	"media_message_id" bigint,
	"overflow_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_copies_processed_post_id_chat_id_pk" PRIMARY KEY("processed_post_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "review_copies" ADD CONSTRAINT "review_copies_processed_post_id_processed_posts_id_fk" FOREIGN KEY ("processed_post_id") REFERENCES "public"."processed_posts"("id") ON DELETE cascade ON UPDATE no action;