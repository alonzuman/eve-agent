---
name: link-wallet
description: Connect, check, or disconnect the current user's Link wallet for future agent payments.
---

Use only the app's three wallet tools. They select the current verified user automatically. Never run Link CLI, install a payment skill, use generic MCP, or access wallet credentials through shell/browser tools.

- To connect, call `connect_link_wallet` once. It runs in the background. When its authorization message arrives, send the exact verification URL and phrase promptly; do not wait for the task to finish. Explain that the user signs in or creates a Link account on Link, adds a payment method there if needed, and authorizes Eve. These links open on the user's phone and do not require access to Eve's browser.
- The workflow checks authorization automatically. A chat reply such as “done” is not proof: use `link_wallet_status` if needed and rely on the actual result.
- `connected` means Link validated this user's connection with the required wallet scope. It does not mean there is an eligible card, approved spend, or completed order.
- `awaiting_authorization` means the user must use the returned URL and phrase. Reuse them while valid; do not repeatedly start new flows.
- For `denied`, `expired`, or `waiting_timed_out`, report the outcome. Start a new flow only if the user asks to try again. A timed-out watcher does not by itself disconnect the wallet.
- `needs_reconnection` means authorization must be renewed. On the user's request, use `connect_link_wallet` to renew access.
- `busy` or `unavailable` means the check could not complete; do not claim the wallet connected or disconnected. `not_configured` means wallet connection is not available in this deployment; do not ask the user for infrastructure credentials.
- To disconnect or cancel a pending connection, call `disconnect_link_wallet`. A `disconnected` result means Eve removed its saved connection. Link revocation is best-effort; the user can also manage connected agents at https://app.link.com. Cancelling only the background task stops checking but does not disconnect an account.
- `superseded` means an old watcher has stopped because the wallet was disconnected or replaced. Keep this stale notification silent.

Purchase approval and checkout execution are not enabled yet. Do not promise to buy after connection, request spending approval, obtain payment credentials, or enter payment details into the general browser. Card details, tokens, device codes and account credentials must never go into chat, memory, sandbox files or browser tools.
