# Verification — September 6, 2026

Verified against eve 0.52.2, AI SDK 7.0.93, Vercel CLI 59.11.7, and a real newly provisioned Vercel project.

## Personality and streaming delivery update — local verification

- Node.js 24.20.0: typecheck and all 43 automated tests pass, including identity, sender allowlist, Kernel browser isolation, screenshot attachments, and 14 delivery/instruction checks.
- `npm run build` succeeds with the new composed instructions and Linq event handlers.
- The pinned Eve stream emitter delivers the first test bubble while generation is held open; private reasoning is not delivered. No real Linq messages are sent by these tests.
- The registered Linq handlers deliver streamed text before and after a screenshot attachment in the same conversation, with a successful receipt and no duplicate sends on replay.
- `npm run eval:conversation -- --list` discovers all six synthetic conversation cases. Model-backed evals have not run: this checkout has no Gateway/OIDC or Blob credentials, and the current Vercel login cannot access the `undefined-software` team named in this repo.
- This update has not been checked on a real phone. The live results below describe the earlier deployment, not the new streaming behavior. See [conversation verification](conversation.md#verification) for the remaining checks.

## Passed

- TypeScript check and all 10 automated tests, including non-sensitive rejection diagnostics.
- Actual eve Linq adapter accepts a valid signed event and rejects unsigned, tampered, or expired webhook bodies.
- Identity policy separates senders and rejects groups, wrong lines, contradictory authors, and principal changes. Concurrent first-owner claims cannot bind one conversation to two users.
- Real eve invocation through `anthropic/claude-sonnet-5` on AI Gateway completed successfully.
- The agent executed a Node.js calculation through eve's built-in `bash` tool in Vercel Sandbox and returned the correct result (17 × 23 = 391).
- Chromium image creation, launch, and page navigation in Vercel Sandbox.
- Live two-user browser test: separate pages, page reading, screenshots, repeat-operation receipts, controller authentication, and absence of application credential environment variables. Temporary sandboxes were deleted.
- Real eve private Blob backend: distinct test memories, optimistic write conflict, and rejected anonymous reads. Temporary objects were deleted.
- Deployed `/eve/v1/health` reports ready via authenticated Vercel CLI access. The application rejects session creation without application authentication even after the platform protection check is satisfied.
- With explicit approval, Vercel SSO was disabled. Public health returns 200; unsigned webhooks and unauthenticated sessions return 401.
- Real Linq webhooks reach the deployed endpoint. Initial messages were ignored because `LINQ_PHONE_NUMBER` was not valid E.164; the production setting was corrected to the receiving agent line.
- Live iMessage send/receive succeeds after the configuration correction. Production logs show `inbound accepted` and successful Workflow requests; the user confirmed receiving the agent's reply.

The first model invocation identified a top-level union schema incompatible with the selected provider. The browser tool now exposes a top-level object, and a regression test covers it.

## Pending by request

- Two real phone senders exercising deployed memory and browser isolation together.
- Link account connection, approval/cancellation workflows, durable purchase records, merchant checkout, and the live flower-order evaluation.

No purchase was attempted. Framework webhook deduplication remains in-process; do not enable purchasing before separate durable purchase idempotency exists.
