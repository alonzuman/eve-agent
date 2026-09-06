# Connect the existing Linq number

The deployed channel is `/eve/v1/linq`. Builds and health checks work before Linq credentials exist; inbound Linq processing fails closed until configuration is complete.

Vercel SSO Deployment Protection was disabled with explicit user approval. The webhook is publicly reachable; unsigned requests and unauthenticated HTTP session requests still receive 401 responses.

Configure these encrypted Vercel environment variables with `vercel env add NAME production` (and the corresponding environment when testing a preview):

- `LINQ_API_KEY`: the existing Linq account's partner API token.
- `LINQ_WEBHOOK_SECRET`: the signing secret for this webhook subscription.
- `LINQ_PHONE_NUMBER`: the one existing Linq line assigned to this application, in E.164 format, such as `+12025550100`.
- `GLOBAL_CONFIG`: the connection string for the Vercel Global Config store holding the `linqResponses` flag and sender allowlist (see below).
- `BLOB_READ_WRITE_TOKEN` or the provisioned `BLOB_STORE_ID` with Vercel OIDC access: the **private** store used by eve and the immutable chat-owner records.

Redeploy after setting environment variables. After the line owner confirms which application should receive that number, create a subscription to `https://<production-domain>/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added` and `reaction.removed`. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format. Preserve any existing application's webhook until its owner approves changing routing. Do not place tokens or webhook secrets in messages, instructions, or source files.

The handler uses eve's Linq adapter and its built-in signature and timestamp checks. It accepts only explicit private inbound conversations whose signed `chat.owner_handle` matches the configured line. The signed sender identity must agree with the normalized message author. Groups, missing/ambiguous identities, messages from the agent itself, and other account lines are ignored.

## Response flag and sender allowlist

Create a [Vercel Global Config](https://vercel.com/docs/global-config/global-config-sdk) store (formerly Edge Config), connect it to the project, and set its connection string as `GLOBAL_CONFIG` for each environment that should receive messages. Add an item named `linqResponses` with this value:

```json
{
  "enabled": true,
  "allowedNumbers": ["+12025550101", "+12025550102"]
}
```

Replace the examples with allowed **sender** numbers. Deploy once after connecting the store. Edit this item in the Vercel dashboard to change access without another deployment; updates apply to subsequent messages after config propagation. Use separate stores if preview/development should have different allowed senders.

Both `enabled` (a boolean) and `allowedNumbers` (an array of exact E.164 strings) are required. `enabled: false` stops admitting messages from everyone. An empty list blocks everyone as well. Missing connection strings/items, invalid configuration (including any malformed number), and provider read errors all fail closed. Email identities are not admitted by the phone allowlist. The reader disables development caching and stale-on-error fallback and does not cache admission decisions.

Admission uses the verified signed sender handle, checks the flag before reading or creating a chat-owner record, then preserves the existing ownership checks. Rejected messages are acknowledged with HTTP 200 and produce no read receipt or conversational turn; only a fixed rejection reason is logged. Signature verification still runs and invalid signatures return 401. Reaction events remain ignored by eve's Linq channel and do not start turns. Changes apply to existing conversations on their next message, but do not cancel or suppress output from a turn already admitted.

**Rollout:** populate and connect the config before deploying this change to an existing installation. Without it, previously accepted senders will be ignored. Builds and health checks still work without the config.

`LINQ_PHONE_NUMBER` is the receiving **agent line**, not the user's personal sender number. Include the leading `+` and country code, with no spaces or punctuation. An incorrectly formatted value caused the initial live messages to be ignored; admission logs now expose a fixed reason such as `configured_line_invalid` without logging message contents, numbers, or credentials.

Every accepted sender gets a stable principal. eve owns durable sessions and default memory; application browser tools derive their scope from verified session auth, never a model-supplied user ID. A private, immutable Blob record pins each Linq conversation to its first sender and rejects later owner changes. The HTTP session API is restricted to internal project service/runtime access and local development because eve's generic route auth does not itself enforce session ownership.

## Verification

Run `npm run check`. The local checks cover distinct users, current/initiator mismatches, groups, wrong lines, missing identities, concurrent owner claims, storage failure, allowlist matching, disabled/invalid/unavailable config, and revocation in an existing conversation. Route tests exercise signed/unsigned/tampered/expired webhooks and verify that blocked messages and reactions return successfully without replies, read receipts, or session dispatch.

After credentials are connected, allowlist two separate real numbers and send a message from each. Teach each conversation a different fact, then ask each to recall it. Confirm replies go only to the correct sender and browser state stays separate. Send from an unlisted number, remove one previously allowed number, and disable the flag; each blocked message should get no response or read receipt. Restore the list and flag to verify responses resume. These rollout checks require a live deployment.

## Duplicate delivery limitation

eve 0.52.2's Linq adapter uses Chat SDK in-memory webhook deduplication. Duplicate turns across cold starts or separate Vercel instances are **not** guaranteed to be suppressed. The application deliberately does not create a permanent pre-dispatch event claim: a crash between claiming and dispatch would silently lose the user's message. Before enabling any payment capability, use durable purchase records and an atomic submission guard so repeated turns cannot place duplicate orders; do not treat messaging dedupe as purchase idempotency. Payments are currently outside the enabled capability set.

Sources: [eve Linq](https://eve.dev/docs/channels/linq), [eve authentication](https://eve.dev/docs/guides/auth-and-route-protection), [Linq webhook event format](https://docs.linqapp.com/channel/imessage/guides/webhooks/events/). The installed-version implementation under `node_modules/eve` was also checked.
