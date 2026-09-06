# Verification — September 6, 2026

Verified against eve 0.52.2, AI SDK 7.0.93, Vercel CLI 59.11.7, and a real newly provisioned Vercel project.

## Passed

- TypeScript check and all 9 automated tests.
- Actual eve Linq adapter accepts a valid signed event and rejects unsigned, tampered, or expired webhook bodies.
- Identity policy separates senders and rejects groups, wrong lines, contradictory authors, and principal changes. Concurrent first-owner claims cannot bind one conversation to two users.
- Real eve invocation through `anthropic/claude-sonnet-5` on AI Gateway completed successfully.
- Chromium image creation, launch, and page navigation in Vercel Sandbox.
- Live two-user browser test: separate pages, page reading, screenshots, repeat-operation receipts, controller authentication, and absence of application credential environment variables. Temporary sandboxes were deleted.
- Real eve private Blob backend: distinct test memories, optimistic write conflict, and rejected anonymous reads. Temporary objects were deleted.
- Deployed `/eve/v1/health` reports ready via authenticated Vercel CLI access. The application rejects session creation without application authentication even after the platform protection check is satisfied.

The first model invocation identified a top-level union schema incompatible with the selected provider. The browser tool now exposes a top-level object, and a regression test covers it.

## Pending by request

- Linq account credentials, number ownership/routing confirmation, and real iMessage send/receive.
- Two real phone senders exercising deployed memory and browser isolation together.
- Public webhook reachability: deployment protection remains enabled. Automatic approval review rejected disabling Vercel SSO without explicit authorization.
- Link account connection, approval/cancellation workflows, durable purchase records, merchant checkout, and the live flower-order evaluation.

No purchase was attempted. Framework webhook deduplication remains in-process; do not enable purchasing before separate durable purchase idempotency exists.
