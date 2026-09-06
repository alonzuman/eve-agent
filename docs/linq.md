# Connect the existing Linq number

The deployed channel is `/eve/v1/linq`. Builds and health checks work before Linq credentials exist; inbound Linq processing fails closed until configuration is complete.

Vercel SSO Deployment Protection is currently enabled. Public direct Linq delivery needs a reachability change when connecting the number. Automatic approval review rejected disabling SSO without explicit user approval; no protection setting was changed. Operator checks can use `vercel curl`.

Configure these encrypted Vercel environment variables with `vercel env add NAME production` (and the corresponding environment when testing a preview):

- `LINQ_API_KEY`: the existing Linq account's partner API token.
- `LINQ_WEBHOOK_SECRET`: the signing secret for this webhook subscription.
- `LINQ_PHONE_NUMBER`: the one existing Linq line assigned to this application, in E.164 format, such as `+12025550100`.
- `BLOB_READ_WRITE_TOKEN` or the provisioned `BLOB_STORE_ID` with Vercel OIDC access: the **private** store used by eve and the immutable chat-owner records.

Redeploy after setting environment variables. After the line owner confirms which application should receive that number, create a subscription to `https://<production-domain>/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added` and `reaction.removed`. Preserve any existing application's webhook until its owner approves changing routing. Do not place tokens or webhook secrets in messages, instructions, or source files.

The handler uses eve's Linq adapter and its built-in signature and timestamp checks. It accepts only explicit private inbound conversations whose signed `chat.owner_handle` matches the configured line. The signed sender identity must agree with the normalized message author. Groups, missing/ambiguous identities, messages from the agent itself, and other account lines are ignored.

Every accepted sender gets a stable principal. eve owns durable sessions and default memory; application browser tools derive their scope from verified session auth, never a model-supplied user ID. A private, immutable Blob record pins each Linq conversation to its first sender and rejects later owner changes. The HTTP session API is restricted to internal project service/runtime access and local development because eve's generic route auth does not itself enforce session ownership.

## Verification

Run `node --import tsx --test tests/identity.test.ts`. These local checks cover distinct users, current/initiator mismatches, groups, wrong lines, missing identities, concurrent owner claims, storage failure, and the real eve Linq route's signed/unsigned/tampered/expired webhook handling.

After credentials are connected, send a message from two separate real numbers. Teach each conversation a different fact, then ask each to recall it. Confirm replies go only to the correct sender and browser state stays separate. A real Linq send/receive remains unverified until that live test runs.

## Duplicate delivery limitation

eve 0.52.2's Linq adapter uses Chat SDK in-memory webhook deduplication. Duplicate turns across cold starts or separate Vercel instances are **not** guaranteed to be suppressed. The application deliberately does not create a permanent pre-dispatch event claim: a crash between claiming and dispatch would silently lose the user's message. Before enabling any payment capability, use durable purchase records and an atomic submission guard so repeated turns cannot place duplicate orders; do not treat messaging dedupe as purchase idempotency. Payments are currently outside the enabled capability set.

Sources: [eve Linq](https://eve.dev/docs/channels/linq), [eve authentication](https://eve.dev/docs/guides/auth-and-route-protection), [Linq webhook event format](https://docs.linqapp.com/channel/imessage/guides/webhooks/events/). The installed-version implementation under `node_modules/eve` was also checked.
