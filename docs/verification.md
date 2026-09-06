# Verification — September 6, 2026

Verified against eve 0.52.2, AI SDK 7.0.93, Vercel CLI 59.11.7, and a real newly provisioned Vercel project.

## Personality PR integration

- Rebased the personality changes onto `947dea3`, retaining the newer Linq typing-pacing implementation and its tests.
- Node.js 24.20.0: typecheck, all 60 automated tests, and the application build pass on the combined code.
- GitHub Actions now runs `npm run build` after `npm run check`. Model-backed evals remain explicit credentialed checks through the documented npm scripts.

## Personality regression fix — local verification

- Node.js 24.20.0: typecheck, all 55 automated tests, and the final application build pass.
- Outgoing Gateway requests in a baseline reproduction contain the standing voice rules on every turn. The original six evals passed while the reported small-talk conversation failed repeatedly. Changing only the model to Luna still failed four of five fresh sessions.
- The revised writer framing, compact voice examples, per-turn composition request, and `openai/gpt-5.6-luna` passed all 16 cases in `.eve/evals/2026-09-06T23-09-28/`: eleven conversation cases plus five fresh small-talk repetitions, with 85 deterministic gates and 38 contextual judgments passing. The independent judge remains `anthropic/claude-sonnet-5`.
- Five more unchanged HTTP repetitions and five with the Linq delivery prompt enabled in a local fixture also passed: 26 cases total, 175 deterministic gates, and 78 contextual judgments. The fixture changes only the delivery-instruction channel condition; it does not exercise phone transport.
- Coverage includes formal tone, exact case-sensitive text and literal markup, held-out social conversation, and actual `bash` execution in Vercel Sandbox with a verified SHA-256 result. Tests do not send real iMessages or deploy the candidate.
- See [the investigation](personality-debugging.md) for comparisons and limitations. Earlier sections below describe their respective changes at the time they were tested.

## Shopping and Exa update — branch verification

- Exa Search API provisioned and connected to the existing Vercel project; a real query returned Upper East Side florist URLs and excerpts.
- Typecheck and all 56 automated tests pass after removing the screenshot-delivery tool, attachment pipeline, state, and their eight obsolete tests. Search tests cover verified identity, input bounds, safe result URLs, output limits, provider errors, and cancellation. Kernel screenshots remain available for internal page inspection.
- Production build succeeds. The compiled manifest resolves `kernel__browse` to the app's private-browser override, with the upstream takeover instructions absent from the active skill.
- All five model-backed shopping evals pass, including missing constraints, private-browser expectations, unavailable payments, sold-out/over-budget alternatives, and selection changes/cancellation.
- The configured model and a real Kernel browser completed the controlled flower-shop cart: the second displayed option (White Roses, medium, no vase), exact gift note, delivery details, and $103.43 final total. Browser state confirmed no submission, including after a request to use the saved card. The harness also ran real Exa discovery and read a public merchant page.
- Checkout used an isolated fixture, not a real merchant order. No Linq messages or payments were sent. A deployed real-phone acceptance check remains pending; see [shopping checks](shopping.md).

## Personality and streaming delivery update — historical verification

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
