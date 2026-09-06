# Link payment integration — deferred

The current deliverable is an eve assistant reachable through the user's Linq
number. Wallet connection, purchase tools and live spending are not enabled.
No wallet credentials are required to deploy or use the messaging assistant.

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

## Required boundaries before enabling payments

- Derive the wallet owner from verified session identity. Model tool inputs
  must not accept an arbitrary user ID, auth path, executable or CLI arguments.
- Keep per-user Link authentication encrypted in backend storage, outside
  eve's file memory and sandbox. Invoke a pinned CLI with an argument array,
  an allowlisted environment, bounded execution and private temporary files.
  Do not log subprocess errors or return raw CLI JSON; both can contain secrets.
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
