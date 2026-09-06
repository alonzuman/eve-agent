CREATE TABLE "linq_message_actions" (
	"namespace" text NOT NULL,
	"action_key" text NOT NULL,
	"principal_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"target_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_message_actions_namespace_action_key_pk" PRIMARY KEY("namespace","action_key"),
	CONSTRAINT "linq_actions_key" CHECK ("linq_message_actions"."action_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "linq_actions_namespace" CHECK ("linq_message_actions"."namespace" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "linq_actions_principal" CHECK ("linq_message_actions"."principal_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "linq_actions_kind" CHECK ("linq_message_actions"."kind" in ('reaction', 'reply')),
	CONSTRAINT "linq_actions_status" CHECK ("linq_message_actions"."status" in ('pending', 'accepted', 'unconfirmed')),
	CONSTRAINT "linq_actions_receipt" CHECK (("linq_message_actions"."status" = 'accepted') = ("linq_message_actions"."receipt" is not null))
);
--> statement-breakpoint
CREATE TABLE "linq_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "linq_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"namespace" text NOT NULL,
	"principal_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"part_index" integer NOT NULL,
	"sender" text NOT NULL,
	"content" text NOT NULL,
	"part_type" text NOT NULL,
	"reply_to_message_id" text,
	"reply_to_part_index" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linq_messages_provider_part" UNIQUE("namespace","principal_id","chat_id","message_id","part_index"),
	CONSTRAINT "linq_messages_namespace" CHECK ("linq_messages"."namespace" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "linq_messages_principal" CHECK ("linq_messages"."principal_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "linq_messages_chat" CHECK (length("linq_messages"."chat_id") between 1 and 256),
	CONSTRAINT "linq_messages_message" CHECK (length("linq_messages"."message_id") between 1 and 256),
	CONSTRAINT "linq_messages_part" CHECK ("linq_messages"."part_index" between 0 and 99),
	CONSTRAINT "linq_messages_sender" CHECK ("linq_messages"."sender" in ('user', 'agent')),
	CONSTRAINT "linq_messages_reply" CHECK (("linq_messages"."reply_to_message_id" is null) = ("linq_messages"."reply_to_part_index" is null)
    and ("linq_messages"."reply_to_part_index" is null or "linq_messages"."reply_to_part_index" between 0 and 99))
);
--> statement-breakpoint
ALTER TABLE "linq_message_actions" ADD CONSTRAINT "linq_message_actions_target_id_linq_messages_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."linq_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linq_messages_recent" ON "linq_messages" USING btree ("namespace","principal_id","chat_id","id" DESC NULLS LAST);