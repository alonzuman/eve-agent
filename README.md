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
2. Redeploy with `npm run deploy`.
3. Public webhook access is enabled: Vercel SSO was disabled with explicit user approval. Webhook signature verification and HTTP session authentication remain enforced.
4. In Linq, register `https://eve-personal-agent-rouge.vercel.app/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added`, and `reaction.removed`, using the signing secret entered above. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format.
5. Text that number from a real phone. Only verified private inbound messages for the configured line are admitted. Group messages, self messages, ambiguous senders, and attempts to change a conversation's owner are ignored. See [Linq details](docs/linq.md).

You can also enter each variable interactively with `vercel env add NAME production`, keeping its value out of shell history. Pull development values with `vercel env pull .env.local --yes`. Do not commit environment files or paste credentials into conversation history.

The Linq channel uses eve's session continuation and interruption behavior. HTTP session APIs are service-only; they are not a public alternative login surface. The health endpoint is `/eve/v1/health`.

## Browser

The official `@onkernel/eve-extension` is mounted at `agent/extensions/kernel.ts`. Its hosted MCP connection supplies browser lifecycle, Playwright, computer controls, profiles, and managed-auth tools. Eve's shell continues using Vercel Sandbox; the custom Chromium sandbox and image-building scripts have been removed.

Kernel authenticates through the attached Vercel Connect connector `kernel/eve-kernel`. Each sender follows the authorization link on first use; grants are associated with their verified Linq identity. No shared `KERNEL_API_KEY` is configured. Kernel permissions are those of the account the sender authorizes; sharing a Kernel account also shares that account's browser resources. Use separate Kernel projects/accounts for environment or account isolation. The obsolete `AGENT_BROWSER_SNAPSHOT_ID` environment variable is no longer read.

For another deployment, create and attach its connector from the project directory, then update the mount with the returned UID:

```sh
vercel connect create kernel --name eve-kernel --connection-method mcp --yes
vercel connect attach kernel/eve-kernel --yes
```

To send a screenshot, the agent navigates a real Kernel browser, captures with `computer_action`, calls `send_browser_screenshot` with `action: "send"`, then checks `action: "status"`. The Linq channel retains the latest native PNG/JPEG capture in session state and uploads its bytes through Linq's attachment API. The destination comes from the originating private chat, never model input. Internal screenshots are not automatically sent. Sends use a stable per-session/per-capture idempotency key. A `sent` receipt means Linq accepted the message; arrival on the phone remains an end-to-end acceptance check.

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
- Use two sender accounts and confirm memory/session isolation and separate Kernel authorization grants.
- Try a general task such as finding information on a website using the browser.
- Text “Send me a screenshot of the example.com home page,” complete Kernel authorization if prompted, and verify an image attachment arrives in that same chat. Inspect Agent Runs for browser creation, navigation, screenshot capture, and the Linq message receipt. This live check must pass before declaring the screenshot flow verified.
- Verify a group message and an invalid webhook signature do not start a conversation.

eve's current Linq adapter deduplicates incoming webhook messages in process. Cross-instance retries can still cause duplicate conversational turns. There is no claim of exactly-once message processing, and payments must not be enabled until separate atomic purchase records and recovery rules are implemented.

No Link credentials, purchase tools, scheduled jobs, email monitoring, or password-vault integration are enabled. See [the payment handoff](src/payments/README.md) for the verified next-phase requirements. A real merchant confirmation remains necessary to pass the future flower-purchase evaluation.

## References

- [eve Linq channel](https://eve.dev/docs/channels/linq)
- [eve file memory](https://eve.dev/docs/memory/file)
- [eve deployment](https://eve.dev/docs/guides/deployment/vercel)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
