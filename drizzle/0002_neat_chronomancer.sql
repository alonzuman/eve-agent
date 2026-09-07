CREATE TABLE "link_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"principal_id" text NOT NULL,
	"call_key" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_purchase_call" UNIQUE("namespace","principal_id","call_key"),
	CONSTRAINT "link_purchase_namespace" CHECK ("link_purchases"."namespace" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "link_purchase_principal" CHECK ("link_purchases"."principal_id" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "link_purchase_owner" ON "link_purchases" USING btree ("namespace","principal_id");