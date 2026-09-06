# Eve personal assistant

A general-purpose eve agent on Vercel, connected to an existing Linq iMessage number. The current scope is conversation, private file memory, shell/file tools, Kernel browsing, and browser screenshot attachments. Link payments and the live flower purchase evaluation are deferred.

## Deployment

- Vercel project: [eve-personal-agent](https://vercel.com/undefined-software/eve-personal-agent)
- Deployment: [eve-personal-agent-rouge.vercel.app](https://eve-personal-agent-rouge.vercel.app/eve/v1/health).
- Framework: eve `0.52.2`, pinned with its required AI SDK `7.0.93` peer dependency.
- Model: `anthropic/claude-sonnet-5` through Vercel AI Gateway, using project OIDC.
- Runtime: Node.js 24, eve's Vercel Workflow integration, and Vercel Sandbox.
- Memory: eve's built-in `fileMemory()` scoped by authenticated principal, backed by the connected **private** Blob store. Built-in compaction is unchanged.

## Connect the existing Linq number

First confirm that the existing number's webhook can be routed here. No existing Linq configuration has been changed.

1. Enter `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, and `LINQ_PHONE_NUMBER` in the project's [Vercel environment settings](https://vercel.com/undefined-software/eve-personal-agent/settings/environment-variables). The phone number must be its full E.164 form, such as `+14155550123`. Use encrypted/sensitive variables for secrets.
2. Set `LINQ_ALLOWED_NUMBERS` to the comma-separated sender numbers allowed to receive responses, as described below. Redeploy with `npm run deploy`.
3. Public webhook access is enabled: Vercel SSO was disabled with explicit user approval. Webhook signature verification and HTTP session authentication remain enforced.
4. In Linq, register `https://eve-personal-agent-rouge.vercel.app/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added`, and `reaction.removed`, using the signing secret entered above. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format.
5. Text that number from an allowlisted real phone. Only verified private inbound messages for the configured line from allowed sender numbers are admitted. Group messages, self messages, ambiguous senders, and attempts to change a conversation's owner are ignored. See [Linq details](docs/linq.md).

You can also enter each variable interactively with `vercel env add NAME production`, keeping its value out of shell history. Pull development values with `vercel env pull .env.local --yes`. Do not commit environment files or paste credentials into conversation history.

The Linq channel uses eve's session continuation and interruption behavior. HTTP session APIs are service-only; they are not a public alternative login surface. The health endpoint is `/eve/v1/health`.

Text `!reset` by itself to start fresh. Eve retires the sender's registered conversations and replies with a confirmation. Their next message starts a new conversation with empty memory and a fresh browser project; other users keep their state. This also works before the sender's first ordinary message. See [reset behavior and retention](docs/linq.md#start-fresh-with-reset).

Eve's conversational voice is casual, curious, and concise, with tone and detail adapted to the user. On iMessage, blank lines send separate bubbles as generation progresses; single newlines stay within a bubble. See [conversation and streaming delivery](docs/conversation.md) for the instruction layout, interruption semantics, and verification commands.

## Response allowlist

Set `LINQ_ALLOWED_NUMBERS` in the project's [Vercel environment settings](https://vercel.com/undefined-software/eve-personal-agent/settings/environment-variables) for each intended environment:

```dotenv
LINQ_ALLOWED_NUMBERS=+12025550101,+12025550102
```

Use the allowed **sender** numbers in full E.164 form. Whitespace around entries is ignored; numbers must otherwise match exactly. Missing or empty values block all responses. Any malformed entry also blocks all responses, including wildcards, email handles, local formatting, or an empty entry between commas.

This check runs locally with no flag service or network request. **Redeploy after every environment-variable change**, including removing a sender or clearing the value to stop responses. When migrating from Vercel Flags, set the new variable before deploying; the old `FLAGS` key and dashboard flag are no longer used.

Blocked messages receive an HTTP 200 acknowledgement and are ignored before owner storage, read receipts, or agent dispatch. Invalid signatures still receive 401. The policy is checked for every message, including existing conversations, and does not cancel turns already admitted. See [setup and verification](docs/linq.md#sender-allowlist).

## Browser

The official `@onkernel/eve-extension` is mounted at `agent/extensions/kernel/extension.ts`. Its hosted MCP connection supplies browser lifecycle, Playwright, computer controls and profiles. Eve's shell continues using Vercel Sandbox; the custom Chromium sandbox and image-building scripts have been removed.

Kernel uses the app-owned `KERNEL_API_KEY` supplied by its Vercel Marketplace resource. Users never authorize Kernel or see a Kernel sign-in link. The connection override selects a separate Kernel project for each verified Linq user and environment. Both MCP project selectors are supplied by the server and removed from model control. Project administration and credential-management tools are not exposed. Missing credentials or unavailable project isolation fail closed.

Provision and connect the Developer resource from this project directory after the owner accepts Marketplace terms:

```sh
vercel integration add kernel --plan FREE --name eve-browser --no-claim
vercel env pull .env.local --yes
```

The Developer plan has a $0 monthly base fee; browser usage is metered. Production, development, and preview branches use separate browser projects. The old Connect connector and `AGENT_BROWSER_SNAPSHOT_ID` are no longer used.

To send a screenshot, the agent navigates a real Kernel browser, captures with `computer_action`, calls `send_browser_screenshot` with `action: "send"`, then checks `action: "status"`. The Linq channel retains the latest native PNG/JPEG capture in session state and uploads its bytes through Linq's attachment API. The destination comes from the originating private chat, never model input. Internal screenshots are not automatically sent. Sends use a stable per-session/per-capture idempotency key. A `sent` receipt means Linq accepted the message; arrival on the phone remains an end-to-end acceptance check.

## Visual replies

The agent can compose one to five image cards using `present_cards`, with HTML templates and string props. The generic `renderCard({ html, props })` API uses Satori and resvg to produce PNG attachments. Cards can show researched photos, prices, comparisons, plans, or other visual summaries. A batch is sent in one Linq message; iMessage chooses its native collage or stack layout. Numbered labels and source links are retained for replies such as “option 2.” See [rendering, templates, and delivery](docs/visual-cards.md). Live phone rendering still needs an acceptance check after deployment.

## Development and checks

```sh
npm ci
vercel env pull .env.local --yes
npm run dev
npm run check
npm run build
```

The built-in shell is explicitly configured to use Vercel Sandbox, including in local development. Screenshot sending requires a verified Linq identity; ordinary local TUI sessions cannot impersonate a phone user. The tests cover screenshot validation, original-byte attachment payloads, send failures, idempotency keys, and existing identity/webhook checks.

## Acceptance after credentials are connected

- Send and receive a real iMessage.
- Ask the agent to remember a harmless unique fact, then verify it in a later conversation.
- Use two sender accounts and confirm memory/session isolation and separate Kernel projects.
- Try a general task such as finding information on a website using the browser.
- Text “Send me a screenshot of the example.com home page” and verify an image attachment arrives in that same chat without a Kernel authorization prompt. Inspect Agent Runs for browser creation, navigation, screenshot capture, and the Linq message receipt. This live check must pass before declaring the screenshot flow verified.
- Verify a non-allowlisted sender, a group message, and an invalid webhook signature do not start a conversation. Remove an allowed sender from `LINQ_ALLOWED_NUMBERS`, redeploy, and confirm their next message is ignored; clear the variable and redeploy to confirm all new messages are ignored.

eve's current Linq adapter deduplicates incoming webhook messages in process. Cross-instance retries can still cause duplicate conversational turns. There is no claim of exactly-once message processing, and payments must not be enabled until separate atomic purchase records and recovery rules are implemented.

No Link credentials, purchase tools, scheduled jobs, email monitoring, or password-vault integration are enabled. See [the payment handoff](src/payments/README.md) for the verified next-phase requirements. A real merchant confirmation remains necessary to pass the future flower-purchase evaluation.

## References

- [eve Linq channel](https://eve.dev/docs/channels/linq)
- [eve file memory](https://eve.dev/docs/memory/file)
- [eve deployment](https://eve.dev/docs/guides/deployment/vercel)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
