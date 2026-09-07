# Per-user Link wallet connections

Eve can connect, check, and disconnect the current verified Linq user's Link
wallet. Purchase approval and checkout execution are not enabled by this change.
The messaging assistant still works without wallet configuration.

## Enable in a deployment

1. Run `npm run db:migrate` against the intended database. Migration `0001` adds
   only the `link_wallets` table. Runtime uses the existing pooled Postgres connection.
2. Generate a 32-byte cryptographically random key encoded as 64 hex characters;
   store it as `LINK_WALLET_ENCRYPTION_KEY` using `vercel env add` for the intended
   environment. Do not print or paste it into chat, source control, or build logs.
3. Deploy the build. The pinned `@stripe/link-cli` 0.17.1 and its runtime assets are
   included in the server bundle. No global CLI installation, merchant Stripe secret
   key, or shared personal Link login is needed.
4. From an allowed private Linq sender, ask Eve to connect Link. Open the returned
   verification URL on your device, check the phrase, sign into Link and authorize
   Eve. The background workflow checks completion and reports the actual result.

Keep the encryption key stable and backed up with other application secrets.
Changing it without re-encrypting existing records makes those records unreadable;
the app fails closed instead of overwriting them. Namespace separation covers
project, production/preview/development and preview branch, even on a shared DB.

## Identity and lifecycle

All tools have an empty, strict input schema. The trusted runtime's current and
initiating Linq identities must match; anonymous, service and local-dev identities
cannot use wallets. A user ID, account selector, auth path or token supplied in
chat cannot select credentials. The store key is the deployment namespace plus
`requireUserScope(ctx)`, which includes Eve's account-reset generation. Connections
survive new conversations for the same account; after `!reset` the new account must
connect again. The old generation's connection is inaccessible; disconnect before
reset, or remove the old Eve connection in Link's connected-agent settings.

The first connect creates a device authorization flow and saves its pending state
under that owner. Repeated calls reuse the pending flow or valid connection. The
user enters all payment information on Link. Authorization grants only
`userinfo:read payment_methods.agentic`; it does not request financial transaction
history or permission to approve purchases programmatically.

`connect_link_wallet` sends its verification URL/phrase through a background task
message and uses durable sleeps between bounded checks. The workflow's steps
return only public status, connection ID, and the user-facing verification data.
On successful device authorization, the backend checks user info with Link to
validate the grant (and refresh expired tokens), then verifies the reported scopes.
Status can be cached for 60 seconds after validation. Unknown scopes require a new
authorization; no payment-method eligibility or spending limit is inferred.

Denial and expiry stop automatic checking without restarting authorization.
Disconnect deletes Eve's saved tokens and pending device code and rotates the
connection ID so stale watchers cannot reconnect it. The CLI attempts remote
revocation but suppresses revocation failures; Eve promises only local deletion.
Users can revoke connected agents at https://app.link.com. Cancelling a background
task stops checking; use disconnect to remove the connection itself.

## Credential boundary and recovery

- AES-256-GCM encrypts the complete record; authenticated associated data binds it
  to the exact user and environment. Copying ciphertext into another user's row
  cannot transfer wallet access.
- A Postgres transaction/advisory lock serializes initial connection, polling,
  refresh and disconnect across server instances. Competing operations report
  busy rather than racing token writes. No database connection is held during
  durable sleeps.
- CLI commands use an absolute, pinned executable, argument arrays and a minimal
  environment. They cannot inherit a global Link login, API/proxy override,
  `NODE_OPTIONS` or app secrets. Auth uses a per-call 0700 temporary directory and
  0600 file, deleted in `finally`; the directory is never in the Eve sandbox.
- CLI output, user info, token previews, auth files and provider errors never
  become tool results or logs. Only HTTPS `app.link.com` verification URLs are
  returned. Updated auth files are encrypted even after a later provider error.
- A crash or DB commit failure during OAuth token exchange/rotation can require
  reauthorization: Link and Postgres do not share a transaction. The app reports
  unavailable/needs-reconnection and never falls back to another wallet.

## Validation

`npm run check` covers credential filtering, expiry/denial, renewal, user/namespace
isolation, stale-watcher fencing and encryption tamper detection. A local HTTP
fixture exercises the actual pinned CLI's authorization, refresh, verification,
denial and logout contracts with synthetic credentials. Set `TEST_DATABASE_URL` to
a disposable Postgres DB to run the concurrent-wallet and message-store tests;
CI provisions Postgres 17 and runs them. No test makes a live purchase or uses a
personal Link account. After `npm run build`, run
`node --import tsx scripts/check-link-bundle.ts` to verify the packaged CLI.

A real phone/Link authorization check remains a deployment acceptance step and
requires the user's Link approval. Model-backed evals are run only on request.

## Verified implementation inputs

Sources checked on 2026-09-06:

- [Official Link CLI](https://github.com/stripe/link-cli)
- [Link CLI authentication](https://github.com/stripe/link-cli#authentication)
- [Spend request lifecycle](https://github.com/stripe/link-cli#spend-request-lifecycle)
- [Consumer integration guidance](https://github.com/stripe/link-cli#integrating-into-agents)
- Installed eve 0.52.2: `node_modules/eve/docs/tools/workflows.mdx`

Link supports US accounts. Its default virtual card can be entered into an
ordinary card checkout; the merchant does not need a Link button. Actual account
eligibility, account-specific limits and merchant acceptance remain unverified.
The README and current source disagree on the maximum amount accepted by the
CLI schema; inspect the installed version and actual account limits before
choosing a spending ceiling. Consumer integrations are invited to contact
`danhill at stripe.com` for embedded approval flows and higher limits.

The official CLI's noninteractive primitives are:

1. `auth login --client-name <name> --auth <private-file> --format json` returns
   a verification URL and phrase and persists pending device authorization.
2. `auth status --auth <private-file> --format json` makes a bounded check and
   saves tokens when device authorization succeeds. Its output includes a
   token preview: never forward the raw output to the model or logs.
3. `user-info retrieve` reports account-specific limits and required step-ups.
4. `spend-request create --no-request-approval` creates a request without
   blocking. Include merchant identity, exact amount and currency, and a
   context of at least 100 characters explaining the reviewed purchase.
5. `spend-request request-approval <id> --format json` starts user approval and
   returns immediately in noninteractive mode. Return only an allowlisted
   approval URL and status to the conversation.
6. `spend-request retrieve <id> --format json` performs a bounded status check.
   Use durable workflow sleeps between checks, never a long CLI polling loop.
7. Only after approval, `spend-request retrieve <id> --include card
   --output-file <private-file> --format json` writes payment credentials to a
   mode-0600 file. Consume and delete that file inside trusted code; do not
   return it from a workflow step or give the agent a path to it.
8. `spend-request cancel <id>` cancels a created, pending or approved request.

Never supply `--approve` or delegated approval metadata for this pilot. The user
must approve the actual request through Link. Use Link test mode against a
controlled test checkout before enabling real purchases.

## Remaining boundaries before enabling purchases

- Reuse the verified wallet owner, encrypted store and serialized token handling
  above. Add no model-visible credential retrieval or arbitrary CLI command tool.
- Keep purchase records in an atomic store separate from conversational memory.
  Persist the user, immutable reviewed cart, Link request, approval status and
  merchant outcome. Use compare-and-set transitions and durable idempotency keys.
- Create a background `defineWorkflowTool` with durable `sleep` waits so status
  messages can continue while approval is pending. Workflow steps contain side
  effects; their recorded results must contain no credentials.
- Restore the cart into a separate trusted checkout sandbox that is inaccessible
  to model-visible shell/browser tools. Never inject cards into the general
  browser sandbox. Recheck exact cart details, amount, origin and cancellation
  immediately before the final submission.
- Atomically mark submission as started before clicking. An interrupted or
  ambiguous submission becomes `unknown` and requires reconciliation against
  merchant confirmation/history. Never automatically click again. Approval
  alone is not an order confirmation.

The later purchase evaluation needs a user-owned US Link account, a real
recipient/address/date/note/budget, actual Link approval and a merchant order
confirmation. It must also verify two-user isolation, denied approval,
cancellation, replay protection and recovery from an interrupted submission.
