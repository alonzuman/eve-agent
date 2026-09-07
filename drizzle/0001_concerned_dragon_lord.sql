CREATE TABLE "link_wallets" (
	"namespace" text NOT NULL,
	"principal_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_wallets_namespace_principal_id_pk" PRIMARY KEY("namespace","principal_id"),
	CONSTRAINT "link_wallets_namespace" CHECK ("link_wallets"."namespace" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "link_wallets_principal" CHECK ("link_wallets"."principal_id" ~ '^[a-f0-9]{64}$')
);
