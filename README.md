# Eve personal assistant

A general-purpose eve agent on Vercel, connected to an existing Linq iMessage number. The current scope is conversation, private file memory, shell/file tools, Exa search, Kernel browsing, and shopping through cart preparation. Payments and order placement remain disabled.

## Deployment

- Vercel project: [eve-personal-agent](https://vercel.com/undefined-software/eve-personal-agent)
- Deployment: [eve-personal-agent-rouge.vercel.app](https://eve-personal-agent-rouge.vercel.app/eve/v1/health).
- Framework: eve `0.52.2`, pinned with its required AI SDK `7.0.93` peer dependency.
- Model: `openai/gpt-5.6-luna` through Vercel AI Gateway, using project OIDC. Conversation evals retain an independent `anthropic/claude-sonnet-5` judge.
- Runtime: Node.js 24, eve's Vercel Workflow integration, and Vercel Sandbox.
- Memory: eve's built-in `fileMemory()` scoped by authenticated principal, backed by the connected **private** Blob store. Built-in compaction is unchanged.
- Messages: Neon Postgres through Drizzle stores Linq message IDs, addressable parts, reply relationships, and reaction/reply action receipts. See [database setup and migrations](docs/database.md).

## Connect the existing Linq number

First confirm that the existing number's webhook can be routed here. No existing Linq configuration has been changed.

1. Enter `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, and `LINQ_PHONE_NUMBER` in the project's [Vercel environment settings](https://vercel.com/undefined-software/eve-personal-agent/settings/environment-variables). The phone number must be its full E.164 form, such as `+14155550123`. Use encrypted/sensitive variables for secrets.
2. Set `LINQ_ALLOWED_NUMBERS` to the comma-separated sender numbers allowed to receive responses, as described below. Connect Neon, apply the [database migrations](docs/database.md), then redeploy with `npm run deploy`.
3. Public webhook access is enabled: Vercel SSO was disabled with explicit user approval. Webhook signature verification and HTTP session authentication remain enforced.
4. In Linq, register `https://eve-personal-agent-rouge.vercel.app/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added`, and `reaction.removed`, using the signing secret entered above. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format.
5. Text that number from an allowlisted real phone. Only verified private inbound messages for the configured line from allowed sender numbers are admitted. Group messages, self messages, ambiguous senders, and attempts to change a conversation's owner are ignored. See [Linq details](docs/linq.md).

You can also enter each variable interactively with `vercel env add NAME production`, keeping its value out of shell history. Pull development values with `vercel env pull .env.local --yes`. Do not commit environment files or paste credentials into conversation history.

The Linq channel uses eve's session continuation and interruption behavior. HTTP session APIs are service-only; they are not a public alternative login surface. The health endpoint is `/eve/v1/health`.

Text `!reset` by itself to start fresh. Eve retires the sender's registered conversations and replies with a confirmation. Their next message starts a new conversation with empty memory and a fresh browser project; other users keep their state. This also works before the sender's first ordinary message. See [reset behavior and retention](docs/linq.md#start-fresh-with-reset).

Eve's conversational voice is casual, curious, and concise, with tone and detail adapted to the user. On iMessage, blank lines send separate bubbles as generation progresses; single newlines stay within a bubble. See [conversation and streaming delivery](docs/conversation.md) for the instruction layout, interruption semantics, and verification commands.

The agent promptly acknowledges requests with fitting emoji reactions and defaults to answering in threads attached to the specific request. These tools resolve short references through Postgres and always use the authenticated current chat. An accepted tool result means Linq accepted the request. Standalone conversation and replies without an available target still stream as assistant text.

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

Kernel screenshots remain available for internal page inspection. The custom screenshot-sending tool and Linq attachment pipeline have been removed; Eve shares findings and public product URLs through chat.

## Shopping and search

The app-owned Exa Search API resource is connected to the Vercel project. Pull its server-only `EXA_API_KEY` with `vercel env pull .env.local --yes`. The `search_web` tool accepts verified private Linq identities and eve's authenticated local development identity, as does browsing. It returns bounded titles, public URLs and excerpts; live merchant prices, inventory and delivery still require browser verification.

Eve loads the shopping skill to gather missing constraints, present two or three specific products with clickable links, preserve the user's choice, and prepare non-payment checkout fields. It reports the final total when available and stops before placing an order or using any payment method. Browser sessions and carts belong to Eve's remote computer and are not accessible from the user's phone.

The app overrides Kernel's bundled browse skill under `agent/extensions/kernel/skills/browse/SKILL.md` to remove upstream live-view and takeover instructions. See [shopping verification](docs/shopping.md) for acceptance checks and test limitations.

## Visual replies

The agent can compose one to five image cards using `present_cards`, with HTML templates and string props. The generic `renderCard({ html, props })` API uses Satori and resvg to produce PNG attachments. Cards can show researched photos, prices, comparisons, plans, or other visual summaries. A batch is sent in one Linq message; iMessage chooses its native collage or stack layout. Numbered labels and source links are retained for replies such as “option 2.” See [rendering, templates, and delivery](docs/visual-cards.md). Live phone rendering still needs an acceptance check after deployment.

## Development and checks

```sh
npm ci
vercel env pull .env.local --yes
npm run db:migrate
npm run dev
npm run check
npm run build
```

Use a development database in `.env.local`; the migration step needs a database URL. The Neon integration must expose credentials to Development for `vercel env pull` to include them. The real Postgres integration tests run when `TEST_DATABASE_URL` points at an isolated test database; see [database verification](docs/database.md#verification).

For a local development server with terminal logs and no terminal chat UI, run:

```sh
bun run dev --no-ui --host 127.0.0.1 --port 2000
```

Wait for the listening URL, then leave the process running while you edit; eve rebuilds on changes. In Eve Studio, open this project and use **Chat → Local**. Studio can also start the development server with its **Start** button. The local health endpoint is `http://127.0.0.1:2000/eve/v1/health`. Use `bunx eve traces` to inspect local traces, or `bun run dev` for eve's terminal chat UI.

`bun start` serves the last production build; use `bun run build` first when testing that output. Satori stays external in `agent/agent.ts` so its HarfBuzz WASM file remains resolvable in both development and built servers.

The built-in shell is explicitly configured to use Vercel Sandbox, including in local development. Local TUI and Studio sessions can search with Exa and browse in a separate local Kernel project. They can also render cards: `present_cards` returns `preview_ready` with an HTML gallery URL/path and PNG files under the system temporary directory's `eve-local-cards` folder. Open the gallery in your browser; local previews do not send iMessages. Files remain until removed or the system clears temporary storage. Production and preview deployments still require a verified private Linq identity for these tools; local sessions cannot use phone-user resources or authorize Linq delivery. Tests cover both identities, rendering, browser isolation, streaming delivery, message references, action receipts, send failures, idempotency keys, and webhook checks.

## Acceptance after credentials are connected

- Send and receive a real iMessage.
- Ask for an emoji reaction, then ask for a threaded reply to an earlier message or photo. Verify the correct bubble/attachment receives it and a reaction-only response adds no text bubble.
- Ask the agent to remember a harmless unique fact, then verify it in a later conversation.
- Use two sender accounts and confirm memory/session isolation and separate Kernel projects.
- Try a general task such as finding information on a website using the browser.
- Verify a non-allowlisted sender, a group message, and an invalid webhook signature do not start a conversation. Remove an allowed sender from `LINQ_ALLOWED_NUMBERS`, redeploy, and confirm their next message is ignored; clear the variable and redeploy to confirm all new messages are ignored.

eve's current Linq adapter deduplicates incoming webhook messages in process. Cross-instance retries can still cause duplicate conversational turns. There is no claim of exactly-once message processing, and payments must not be enabled until separate atomic purchase records and recovery rules are implemented.

No Link credentials, purchase tools, scheduled jobs, email monitoring, or password-vault integration are enabled. See [the payment handoff](src/payments/README.md) for the verified next-phase requirements. A real merchant confirmation remains necessary to pass the future flower-purchase evaluation.

## References

- [eve Linq channel](https://eve.dev/docs/channels/linq)
- [eve file memory](https://eve.dev/docs/memory/file)
- [eve deployment](https://eve.dev/docs/guides/deployment/vercel)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
