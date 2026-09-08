---
name: link-wallet
description: Connect the current user's Link wallet and run an approved $5 no-charge sandbox purchase test.
---

Use only the app's wallet and sandbox purchase tools. They select the current verified user automatically. Never run Link CLI, install a payment skill, use generic MCP, or access wallet credentials through shell/browser tools.

- To connect, call `connect_link_wallet` once. It runs in the background. When its authorization message arrives, send the exact verification URL and phrase promptly; do not wait for the task to finish. Explain that the user signs in or creates a Link account on Link, adds a payment method there if needed, and authorizes Eve. These links open on the user's phone and do not require access to Eve's browser.
- The workflow checks authorization automatically. A chat reply such as “done” is not proof: use `link_wallet_status` if needed and rely on the actual result.
- `connected` means Link validated this user's connection with the required wallet scope. It does not mean there is an eligible card, approved spend, or completed order.
- `awaiting_authorization` means the user must use the returned URL and phrase. Reuse them while valid; do not repeatedly start new flows.
- For `denied`, `expired`, or `waiting_timed_out`, report the outcome. Start a new flow only if the user asks to try again. A timed-out watcher does not by itself disconnect the wallet.
- `needs_reconnection` means authorization must be renewed. On the user's request, use `connect_link_wallet` to renew access.
- `busy` or `unavailable` means the check could not complete; do not claim the wallet connected or disconnected. `not_configured` means wallet connection is not available in this deployment; do not ask the user for infrastructure credentials.
- To disconnect or cancel a pending connection, call `disconnect_link_wallet`. A `disconnected` result means Eve removed its saved connection. Link revocation is best-effort; the user can also manage connected agents at https://app.link.com. Cancelling only the background task stops checking but does not disconnect an account.
- `superseded` means an old watcher has stopped because the wallet was disconnected or replaced. Keep this stale notification silent.

For an explicitly requested $5 no-charge payment test, call `test_link_purchase` once. If the request might mean spending real money, clarify test versus real purchase first. This background tool connects the wallet if needed, prepares a real Stripe sandbox checkout, sends a separate Link spend-approval URL, and executes the test after Link confirms approval. Relay the exact URL immediately and clearly say $5 USD, sandbox, no real charge, no product delivered. A user reply such as “approved” never authorizes execution by itself.

Use `link_purchase_status` with the returned purchase reference to check/resume the same test. `succeeded` confirms Stripe reported the sandbox checkout paid; pending approval or a connected wallet does not. `unknown` or `too_late_or_unknown` means an external action may have happened: do not retry or promise cancellation. `requires_action` means Link needs additional action; stop and report it without inventing a URL. `wallet_changed` means the original connection was removed or replaced; do not use a new wallet for that purchase. `unavailable` is a transient inability to check, not success. Keep the purchase reference so the same test can be checked again.

For cancellation call `cancel_link_purchase`. Cancelling just the background task does not revoke a Link approval. A `canceled` result confirms cancellation. `canceled_locally` means Eve stopped the purchase but could not revoke the old Link request after a wallet disconnect/replacement; explain that the user can manage it in Link. A `busy` or `cancel_pending` result needs another check of the same reference. An unresolved test blocks replacement tests to prevent duplicate submissions.

Real merchant purchases are not enabled yet. Card details, tokens, device codes and account credentials must never go into chat, memory, sandbox files or general browser tools. The trusted test checkout handles payment credentials privately.
