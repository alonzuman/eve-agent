# Connect the existing Linq number

The deployed channel is `/eve/v1/linq`. Builds and health checks work before Linq credentials exist; inbound Linq processing fails closed until configuration is complete.

Vercel SSO Deployment Protection was disabled with explicit user approval. The webhook is publicly reachable; unsigned requests and unauthenticated HTTP session requests still receive 401 responses.

Configure these encrypted Vercel environment variables with `vercel env add NAME production` (and the corresponding environment when testing a preview):

- `LINQ_API_KEY`: the existing Linq account's partner API token.
- `LINQ_WEBHOOK_SECRET`: the signing secret for this webhook subscription.
- `LINQ_PHONE_NUMBER`: the one existing Linq line assigned to this application, in E.164 format, such as `+12025550100`.
- `FLAGS`: the Vercel Flags server SDK key for the deployment environment (see below).
- `BLOB_READ_WRITE_TOKEN` or the provisioned `BLOB_STORE_ID` with Vercel OIDC access: the **private** store used by eve and the immutable chat-owner records.

Redeploy after setting environment variables. After the line owner confirms which application should receive that number, create a subscription to `https://<production-domain>/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added` and `reaction.removed`. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format. Preserve any existing application's webhook until its owner approves changing routing. Do not place tokens or webhook secrets in messages, instructions, or source files.

The handler uses eve's Linq adapter and its built-in signature and timestamp checks. It accepts only explicit private inbound conversations whose signed `chat.owner_handle` matches the configured line. The signed sender identity must agree with the normalized message author. Groups, missing/ambiguous identities, messages from the agent itself, and other account lines are ignored.

## Response flag and sender allowlist

Use the project's [Vercel Flags dashboard](https://vercel.com/docs/flags/vercel-flags/dashboard):

1. Create a **boolean** flag with key `linq-responses` and options `false` and `true`.
2. In each intended environment, set the fallback outcome and paused outcome to `false`.
3. Under **Targets**, add each allowed **User ID** to the `true` option. Use exact E.164 **sender** numbers, such as `+12025550101` and `+12025550102`, with no spaces or punctuation. The application passes `{ user: { id: verifiedSenderNumber } }` as the evaluation context. The default User entity supports the `id` attribute.
4. Enable the flag for that environment. Vercel automatically provisions the environment-specific `FLAGS` SDK key when you create the first flag; verify it is available to the deployment and redeploy once. For local development, pull it with `vercel env pull .env.local --yes`.

Edit targets in the dashboard to grant or revoke access without another deployment. Production, preview, and development have separate targeting configurations selected by their SDK keys. See [SDK keys](https://vercel.com/docs/flags/vercel-flags/dashboard/sdk-keys) and [direct targeting](https://vercel.com/kb/guide/how-vercel-flags-are-evaluated).

Only a boolean `true` result from an explicit target match admits a sender. Rules, rollouts, and a `true` fallback cannot expand the allowlist. Pause the flag to block everyone, regardless of its configured paused outcome. Empty targets, missing SDK keys/flags, malformed values, and evaluation errors fail closed. Email identities are not admitted even if targeted.

The reader uses `@vercel/flags-core` and refreshes definitions for each webhook. Each evaluation starts with an empty fallback instead of a previously cached or embedded allowlist, waits up to two seconds for the initial refresh, then shuts down the client and cancels outstanding reads. Provider failures/timeouts therefore block the message. Numbers are matched locally against the fetched definitions and are not sent as request parameters to the Flags service. Updates apply after Vercel propagates the flag configuration.

Admission uses the verified signed sender handle, checks the flag before reading or creating a chat-owner record, then preserves the existing ownership checks. Rejected messages are acknowledged with HTTP 200 and produce no read receipt or conversational turn; only a fixed rejection reason is logged. Signature verification still runs and invalid signatures return 401. Reaction events remain ignored by eve's Linq channel and do not start turns. Changes apply to existing conversations on their next message, but do not cancel or suppress output from a turn already admitted.

**Rollout:** create the flag, populate its targets, and configure `FLAGS` before deploying this change to an existing installation. Without them, previously accepted senders will be ignored. Builds and health checks still work without Flags credentials.

`LINQ_PHONE_NUMBER` is the receiving **agent line**, not the user's personal sender number. Include the leading `+` and country code, with no spaces or punctuation. An incorrectly formatted value caused the initial live messages to be ignored; admission logs now expose a fixed reason such as `configured_line_invalid` without logging message contents, numbers, or credentials.

Every accepted sender gets a stable principal. eve owns durable sessions and default memory; application browser tools derive their scope from verified session auth, never a model-supplied user ID. A private, immutable Blob record pins each Linq conversation to its first sender and rejects later owner changes. The HTTP session API is restricted to internal project service/runtime access and local development because eve's generic route auth does not itself enforce session ownership.

## Verification

Run `npm run check`. The local checks cover distinct users, current/initiator mismatches, groups, wrong lines, missing identities, concurrent owner claims, storage failure, Vercel Flags targeting, paused/invalid/unavailable flags, and revocation in an existing conversation. Route tests exercise signed/unsigned/tampered/expired webhooks and verify that blocked messages and reactions return successfully without replies, read receipts, or session dispatch.

After credentials are connected, target two separate real numbers with `true` and send a message from each. Teach each conversation a different fact, then ask each to recall it. Confirm replies go only to the correct sender and browser state stays separate. Send from an unlisted number, remove one previously allowed target, and pause the flag; each blocked message should get no response or read receipt. Restore the targets and enable the flag to verify responses resume. These rollout checks require a live deployment.

## Duplicate delivery limitation

eve 0.52.2's Linq adapter uses Chat SDK in-memory webhook deduplication. Duplicate turns across cold starts or separate Vercel instances are **not** guaranteed to be suppressed. The application deliberately does not create a permanent pre-dispatch event claim: a crash between claiming and dispatch would silently lose the user's message. Before enabling any payment capability, use durable purchase records and an atomic submission guard so repeated turns cannot place duplicate orders; do not treat messaging dedupe as purchase idempotency. Payments are currently outside the enabled capability set.

Sources: [eve Linq](https://eve.dev/docs/channels/linq), [eve authentication](https://eve.dev/docs/guides/auth-and-route-protection), [Linq webhook event format](https://docs.linqapp.com/channel/imessage/guides/webhooks/events/). The installed-version implementation under `node_modules/eve` was also checked.
