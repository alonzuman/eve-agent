# Per-user Link wallets and sandbox purchases

Eve connects each verified Linq sender to their own Link wallet. The
`test_link_purchase` workflow now completes a fixed **$5 USD, no-charge Stripe
sandbox checkout** after a separate approval on Link. Real merchant purchases
remain disabled. Wallet connection by itself does not approve spending.

## Deployment

1. Run `npm run db:migrate` against the intended database. `0001` adds encrypted
   wallets; `0002` adds encrypted purchase records. Existing messaging is unchanged.
2. Configure a stable 32-byte random key encoded as 64 hex characters in
   `LINK_WALLET_ENCRYPTION_KEY`. Never rotate it without re-encrypting existing rows.
3. Provision Stripe through Vercel Marketplace and connect its sandbox. Configure
   `STRIPE_SECRET_KEY` with the resulting **test** key in each target environment.
   The checkout adapter rejects live keys and live Checkout Sessions.
4. Keep the existing `DATABASE_URL` and `KERNEL_API_KEY`. Kernel projects must be
   enabled. Deploy with pinned Link CLI and Playwright runtime packages preserved.

Production may run the sandbox test: deployment environment and Stripe payment
mode are independent. This does not enable real spending. Wallet-only tools work
without Stripe configured. Never configure a shared personal `LINK_ACCESS_TOKEN`.

## Phone acceptance test

From an allowlisted private Linq sender, send:

> Run a $5 no-charge Link payment test.

Eve connects the wallet if needed, sends the verification URL and phrase promptly,
and checks automatically. The user signs into Link on their own device. After
connection, Eve prepares and inspects the real Stripe sandbox checkout, creates a
Link spend request with `--test --no-request-approval`, requests approval, and sends
a separate Link approval URL. The user approves **that test request** in Link.
Eve checks Link's actual status and uses the resulting test credential privately.
Only Stripe's `status=complete` and `payment_status=paid` produce `succeeded`.
No product is delivered and no real money is charged.

A message saying “done” or “approved” is not proof. Use `link_purchase_status` with
the same purchase reference to check/resume a timed-out workflow. Cancelling the
background task only stops checking; `cancel_link_purchase` records cancellation
and revokes the pending spend request. `busy`/`cancel_pending` do not confirm
cancellation. Denial and expiry stop the workflow without restarting it.
After wallet removal/replacement, `canceled_locally` stops Eve's purchase but
cannot promise remote Link revocation; the user can manage that request in Link.

Link currently supports US accounts. Actual account eligibility, step-up
requirements, and merchant acceptance must be verified in this phone test.
`requires_action` stops the pilot; it does not guess a challenge URL or create a
replacement spend request. `wallet_changed` fences a disconnected/replaced wallet.

## Boundaries and retries

- The verified current/initiating Linq identities select the wallet automatically.
  No tool accepts a user/account selector, credentials, arbitrary browser code or
  a payment endpoint. Anonymous and local-dev identities cannot spend.
- Wallets and purchases are AES-256-GCM encrypted in Postgres, bound to user and
  deployment namespace. Purchase ciphertext also binds the reference and revision.
  `!reset` creates a new identity generation and requires a fresh Link connection.
- Spending, refresh and disconnect share the wallet advisory lock. OAuth rotation
  is persisted even after a downstream failure. Durable sleeps hold no DB lock.
- A purchase pins the wallet connection, fixed USD 500-cent quote and test mode.
  Its Stripe session is created with an idempotency key. Repeated tool calls reuse
  an unresolved purchase; replay of a completed call returns the original result.
- Compare-and-set transitions commit `creating`, `requesting_approval` and
  `submitting` **before** the corresponding external effects. A crash cannot
  automatically submit checkout twice. A concurrent cancellation changes the
  revision and prevents an unclaimed submission. Cancellation after submission
  cannot promise an undo.
- A lost checkout response becomes `unknown`; later checks reconcile with Stripe's
  merchant API and never click Pay again. An ambiguous Link create/approval also
  stays `unknown` and blocks replacement tests. This pilot deliberately needs
  operator reconciliation for such requests; it does not infer failure from an
  unpaid/open checkout or silently clear the record.
- Link CLI runs a fixed executable with argument arrays, a minimal environment,
  private 0700 directories and 0600 files. Raw stdout, diagnostics, auth and card
  files never reach the model, chat, workflow results or sandbox. Files are
  removed in `finally`. No delegated approval or `--approve` is used.
- The trusted backend opens a headless Kernel browser in `eve-checkout-<owner hash>`,
  separate from the general `eve-<user hash>` browser project. The model cannot
  select that project or obtain its browser/CDP URL. No profiles, recordings or
  screenshots are created. The card goes directly over CDP from backend memory.
- Before requesting a credential and again before entering it, the adapter checks
  the fixed sandbox session, amount, currency, purchase metadata, merchant origin,
  product, card form and observed Stripe agent steering block. A newly introduced
  Link Pay Token surface fails closed until a matching adapter is implemented.

## Verification

`TEST_DATABASE_URL=... npm run check` runs the complete suite. Tests use the actual
pinned CLI against a local HTTP protocol fixture and real Postgres to cover user
isolation, cancellation, refresh serialization, concurrent submissions, lost
responses and restart/replay behavior. CI provisions Postgres and verifies both
runtime packages after building.

For an opt-in **real Stripe sandbox + real Kernel** checkout with a synthetic
Stripe test card:

```
node --env-file=<private-sandbox-env> --import tsx scripts/check-link-checkout.ts
```

This verifies the merchant adapter; it does **not** verify a user's Link approval.
Complete the phone acceptance test separately. Never use live card data for this
smoke script. Neither automated suite makes a live purchase.

## Real purchase follow-up

The next merchant adapter needs the user's actual product URL, variant, recipient
and maximum total including shipping/tax/fees. Inspect that merchant's supported
credential flow, capture its immutable final cart, and implement trusted execution
and merchant order reconciliation before enabling it. A real Link approval and
merchant receipt are required for the first live purchase. Do not test by charging
a real card through this sandbox merchant. Merchant-owned fulfillment integrations
also require verified webhooks before launch; this sandbox does not fulfill orders,
provision products, send receipts or support asynchronous payment methods.

Sources: [Link CLI](https://github.com/stripe/link-cli),
[Stripe Checkout](https://docs.stripe.com/api/checkout/sessions),
[Stripe testing](https://docs.stripe.com/testing), and installed Eve 0.52.2 workflow
and packaging docs under `node_modules/eve/docs`.
