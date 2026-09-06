# Message database

Neon Postgres is the durable source for message references and reaction/reply receipts. Drizzle defines the schema in `src/database/schema.ts`, runs typed queries in `src/messaging/message-store.ts`, and tracks versioned SQL under `drizzle/`. Eve still owns sessions, compaction, private file memory, and tool execution. Existing Blob account and ownership records remain in use.

## Connections and migrations

Use Node.js 24. The Vercel Neon integration supplies `DATABASE_URL` for the runtime pool and `DATABASE_URL_UNPOOLED` for migrations. Runtime connections are lazy, with at most three connections per application instance, bounded query/connect timeouts, and Vercel's pool lifecycle integration. Builds and health checks do not connect to Postgres; Linq message processing requires the migrated database.

For local development, connect a development database and pull its environment:

```sh
vercel env pull .env.local --yes
npm ci
npm run db:migrate
```

The integration was initially connected to Production and Preview only. Enable a development database for Development, or put local Postgres credentials in the ignored `.env.local`. A database without a connection pooler may use the same direct URL for both variables. Never commit connection strings.

For schema changes:

```sh
# Edit src/database/schema.ts, then generate and review the SQL.
npm run db:generate -- --name=describe_the_change
npm run db:check
npm run db:migrate
```

Commit the schema, SQL, and Drizzle metadata together. `db:check` checks migration history consistency; it does not compare a live database to the TypeScript schema. Do not edit migrations already applied to a shared database. Generate a subsequent migration for corrections; review destructive changes and data backfills separately. Use migrations rather than `drizzle-kit push` for shared databases.

Apply migrations explicitly before deploying code that requires them. They do not run automatically during a build, on every request, or during startup. For the linked production database:

```sh
vercel env pull .env.production.local --environment=production --yes
node --env-file=.env.production.local --import tsx scripts/migrate.ts
```

The runner prefers `DATABASE_URL_UNPOOLED`, falling back to `DATABASE_URL` for direct local connections. Use a direct connection for migrations: a session advisory lock serializes migration runners on that database, and Drizzle applies outstanding migrations transactionally and records them in `drizzle.__drizzle_migrations`. Re-running the command is safe. Apply the same migration history separately to any distinct preview/development database. Sharing one database across environments shares its schema, so changes must remain compatible with deployed versions.

## Stored records and scope

`linq_messages` has one row per addressable message part. It stores the Linq message ID, part index, sender, text or attachment placeholder, reply parent, and recording time. Text is retained in full; attachment bytes and temporary download URLs are not copied to this table. Multipart messages share their provider ID but get separate references. The identity primary key supplies the stable `m123` reference; duplicate provider deliveries return the original row and content.

Every lookup includes the project/environment/preview-branch namespace, verified account principal, and private chat ID. The principal changes on `!reset`, so prior rows remain stored but become inaccessible to the new account. References are identifiers, not credentials; the model cannot supply a recipient or bypass scope by guessing an ID.

`linq_message_actions` stores the target row, reaction/reply request, deterministic action key, state, and optional accepted receipt. The key includes session, turn, provider target/part, action kind, and content. A unique constraint allows only one concurrent claimant. Accepting a reply and recording its new message happen in one transaction.

The model receives the latest 40 message parts plus available direct reply parents. This is a context window, not a storage limit: older known references can still resolve in the same scope. Existing chat history is not backfilled. Fixed operational notices such as reset confirmations are not indexed. No automatic deletion or retention job is configured; these tables contain conversation text and must be included in future account-erasure/retention work.

## Delivery and recovery limits

- `accepted` means Linq accepted the request, not that the phone received it.
- A pending claim survives process failure. A timeout, cancellation, rejected response, or receipt-write failure is treated as `unconfirmed`. Repeating that same action in the same turn does not call Linq again. A crash after claiming but before sending can therefore leave an action unsent. Recovery needs inspection or an explicit new user request; there is no automatic resend job.
- Threaded replies also send the deterministic key to Linq as `idempotency_key`. Reactions use the database claim. These guards do not deduplicate separate turns generated from duplicate incoming webhooks.
- Ordinary streamed bubbles still use Eve's send behavior. If recording an accepted bubble fails, later bubbles stop, and the accepted bubble may lack a stored reference. Visual-card event replay can repair a missing message record from a saved receipt without resending the images.
- Inbound reaction events remain ignored. Reply targets must be messages observed by this version, and the transport is limited to the authenticated private iMessage chat.

## Verification

Use an isolated local/test database, never the live conversation database:

```sh
TEST_DATABASE_URL=postgresql://localhost/eve_messages_test npm run check
npm run build
```

The integration suite applies the migrations twice, exercises real PostgreSQL uniqueness/transactions with concurrent connections, and removes its own test rows. It tests multipart targets, cross-user/chat/environment/reset isolation, parent context, duplicate claims, actual tool requests with mocked Linq HTTP, ambiguous delivery, receipt-write failure, cancellation, and atomic reply recording. Without `TEST_DATABASE_URL`, that suite is explicitly skipped; the remaining tests do not need Postgres. `npm run build` compiles the agent without sending messages.

After deployment, verify a real reaction-only response and a threaded reply to both a text message and an attachment on the phone. Automated checks do not verify handset delivery.
