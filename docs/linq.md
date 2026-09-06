# Connect the existing Linq number

The deployed channel is `/eve/v1/linq`. Builds and health checks work before Linq credentials exist; inbound Linq processing fails closed until configuration is complete.

Vercel SSO Deployment Protection was disabled with explicit user approval. The webhook is publicly reachable; unsigned requests and unauthenticated HTTP session requests still receive 401 responses.

Configure these encrypted Vercel environment variables with `vercel env add NAME production` (and the corresponding environment when testing a preview):

- `LINQ_API_KEY`: the existing Linq account's partner API token.
- `LINQ_WEBHOOK_SECRET`: the signing secret for this webhook subscription.
- `LINQ_PHONE_NUMBER`: the one existing Linq line assigned to this application, in E.164 format, such as `+12025550100`.
- `LINQ_ALLOWED_NUMBERS`: comma-separated E.164 sender numbers allowed to receive responses (see below).
- `BLOB_READ_WRITE_TOKEN` or the provisioned `BLOB_STORE_ID` with Vercel OIDC access: the **private** store used by eve and the immutable chat-owner records.
- `DATABASE_URL`: the pooled Neon Postgres connection used for message references and action receipts. Apply [Drizzle migrations](database.md) with `DATABASE_URL_UNPOOLED` before deploying.

Redeploy after setting environment variables. After the line owner confirms which application should receive that number, create a subscription to `https://<production-domain>/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added` and `reaction.removed`. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format. Preserve any existing application's webhook until its owner approves changing routing. Do not place tokens or webhook secrets in messages, instructions, or source files.

The handler uses eve's Linq adapter and its built-in signature and timestamp checks. It accepts only explicit private inbound conversations whose signed `chat.owner_handle` matches the configured line. The signed sender identity must agree with the normalized message author. Groups, missing/ambiguous identities, messages from the agent itself, and other account lines are ignored.

## Sender allowlist

Set `LINQ_ALLOWED_NUMBERS` in the project's Vercel environment settings. For example:

```dotenv
LINQ_ALLOWED_NUMBERS=+12025550101,+12025550102
```

Use exact E.164 **sender** numbers, including the leading `+` and country code. Whitespace around comma-separated entries is ignored. Missing, empty, or whitespace-only configuration blocks everyone. Any malformed entry, including a wildcard, email address, formatted local number, or empty entry from an extra comma, blocks everyone as well. Duplicate numbers are harmless.

Set the variable separately for production, preview, and development as needed. **Redeploy after adding, removing, or changing it.** To stop admitting all messages, clear the value and redeploy. For local development, pull values with `vercel env pull .env.local --yes` and restart the development process.

Admission checks the verified signed sender against the environment variable synchronously, with no network request. It runs before reading or creating a chat-owner record, then preserves the existing ownership checks. Rejected messages are acknowledged with HTTP 200 and produce no read receipt or conversational turn; only a fixed rejection reason is logged. Signature verification still runs and invalid signatures return 401. Reaction events remain ignored by eve's Linq channel and do not start turns. After deployment, the new configuration applies to existing conversations on their next message, but does not cancel or suppress output from a turn already admitted.

**Migration from Vercel Flags:** copy the currently allowed sender numbers into `LINQ_ALLOWED_NUMBERS` before deploying this version. Otherwise, previously accepted senders will be ignored. The `FLAGS` SDK key and `linq-responses` dashboard flag are no longer read by the application. Builds and health checks still work without an allowlist.

`LINQ_PHONE_NUMBER` is the receiving **agent line**, not the user's personal sender number. Include the leading `+` and country code, with no spaces or punctuation. An incorrectly formatted value caused the initial live messages to be ignored; admission logs now expose a fixed reason such as `configured_line_invalid` without logging message contents, numbers, or credentials.

Every accepted sender gets a stable ownership identity and an account principal that changes on reset. eve owns durable sessions and default memory; application browser tools derive their scope from verified session auth, never a model-supplied user ID. A private, immutable Blob record pins each Linq conversation to its first sender and rejects later owner changes. The HTTP session API is restricted to internal project service/runtime access and local development because eve's generic route auth does not itself enforce session ownership.

## Start fresh with `!reset`

Send exactly `!reset` in a private text message (surrounding whitespace is allowed). The command is case-sensitive and must have no attachments. A sentence mentioning `!reset` remains an ordinary message. Signature, sender allowlist, private-chat verification, and immutable ownership checks all run before account access or reset.

The application consumes the command before model dispatch, retires the sender's registered Eve sessions, and sends a fixed confirmation. The next ordinary message starts a fresh session, including history, compaction, sandbox files, and screenshot state. A new account principal selects empty file memory and a separate Kernel project, so remembered facts, browser profiles, cookies, and logged-in browser sessions from the previous account are no longer available. The same new account scope applies across that sender's private chats. Other senders, the response allowlist, and immutable chat ownership remain intact. Accounts retain their existing scopes until their first reset.

Private `app-private/linq/accounts/` Blob records hold the current generation, registered chats, hashed reset-message IDs, and any pending session retirement. Conditional writes prevent racing requests from overwriting each other. Replayed reset messages, including older commands, do not reset a newer account again. Cleanup is recorded before sessions are retired; if it fails, the user receives a failure notice and subsequent admitted messages retry cleanup before starting a turn. No success notice is sent on a storage or retirement failure.

Reset disconnects old account data from future conversations; it is not a provider-wide data-erasure operation. Prior Eve run records, Blob memory documents, sandbox artifacts, Kernel projects, and Postgres message/action rows may remain under their providers' retention policies. Old message references cannot be resolved through the new account principal. Existing messages remain visible on the phone. Session retirement is cooperative, so an already-running action or in-flight reply may finish. Chats register when they receive a message with this version; older, unregistered sessions in other chats cannot be proactively retired, but the next inbound message in those chats uses the new account generation and cannot resume their history.

The route wrapper uses Eve's public `from(address).reset()` operation because the pinned Linq `onMessage` context only exposes its Chat SDK thread. Request-local address mapping keeps Eve's signed adapter, streaming, and session dispatch intact, while selecting a new continuation address after reset.

## Verification

Run `npm run check`. The local checks cover distinct users, current/initiator mismatches, groups, wrong lines, missing identities, concurrent owner claims, storage failure, exact allowlist matching without network requests, missing/empty/malformed environment configuration, and revocation in an existing conversation. Route tests exercise signed/unsigned/tampered/expired webhooks and verify that blocked messages and reactions return successfully without replies, read receipts, or session dispatch.

Reset tests cover first-message resets, exact command matching, cross-chat account rotation, concurrent requests, old webhook replays, partial failure recovery, and signed route dispatch. For live acceptance, teach two users different harmless facts, create browser state for each, then send `!reset` from one user. Verify the confirmation arrives, their next message has no prior history or saved facts, their browser uses a fresh Kernel project, and the second user's conversation is unchanged.

After credentials are connected, add two separate real numbers to `LINQ_ALLOWED_NUMBERS`, redeploy, and send a message from each. Teach each conversation a different fact, then ask each to recall it. Confirm replies go only to the correct sender and browser state stays separate. Send from an unlisted number, remove one previously allowed number and redeploy, then clear the variable and redeploy; each blocked message should get no response or read receipt. Restore the numbers and redeploy to verify responses resume. These rollout checks require a live deployment.

## Duplicate delivery limitation

eve 0.52.2's Linq adapter uses Chat SDK in-memory webhook deduplication. Duplicate turns across cold starts or separate Vercel instances are **not** guaranteed to be suppressed. The application deliberately does not create a permanent pre-dispatch event claim: a crash between claiming and dispatch would silently lose the user's message. Before enabling any payment capability, use durable purchase records and an atomic submission guard so repeated turns cannot place duplicate orders; do not treat messaging dedupe as purchase idempotency. Payments are currently outside the enabled capability set.

Postgres deduplicates stored provider message parts and atomically claims reaction/reply actions within a turn. It does not claim inbound dispatch or deduplicate independently created turns. If storing an admitted incoming message fails, the channel sends a fixed temporary-unavailability notice and does not dispatch model work or mark it read. Inbound reaction webhooks still do not start turns; the new reaction tool adds outbound reactions. See [database behavior](database.md).

Sources: [eve Linq](https://eve.dev/docs/channels/linq), [eve authentication](https://eve.dev/docs/guides/auth-and-route-protection), [Linq webhook event format](https://docs.linqapp.com/channel/imessage/guides/webhooks/events/). The installed-version implementation under `node_modules/eve` was also checked.
