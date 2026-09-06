# Eve personal assistant

A general-purpose eve agent on Vercel, connected to an existing Linq iMessage number. Live send/receive is verified. The current scope is conversation, private file memory, shell/file tools, and isolated Chromium browsing. Link payments and the live flower purchase evaluation are deferred.

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
2. Create the `linq-responses` Vercel flag and configure its targets and `FLAGS` SDK key as described below. Redeploy with `npm run deploy`.
3. Public webhook access is enabled: Vercel SSO was disabled with explicit user approval. Webhook signature verification and HTTP session authentication remain enforced.
4. In Linq, register `https://eve-personal-agent-rouge.vercel.app/eve/v1/linq?version=2026-02-03` for `message.received`, `reaction.added`, and `reaction.removed`, using the signing secret entered above. Select webhook payload version **2026-02-03** in Linq's subscription settings; the URL query parameter alone does not select the payload format.
5. Text that number from an allowlisted real phone. Only verified private inbound messages for the configured line from allowed sender numbers are admitted while responses are enabled. Group messages, self messages, ambiguous senders, and attempts to change a conversation's owner are ignored. See [Linq details](docs/linq.md).

You can also enter each variable interactively with `vercel env add NAME production`, keeping its value out of shell history. Pull development values with `vercel env pull .env.local --yes`. Do not commit environment files or paste credentials into conversation history.

The Linq channel uses eve's session continuation and interruption behavior. HTTP session APIs are service-only; they are not a public alternative login surface. The health endpoint is `/eve/v1/health`.

## Response allowlist

Manage the allowlist in the project's [Vercel Flags dashboard](https://vercel.com/docs/flags/vercel-flags/dashboard). Create a **boolean** flag with key `linq-responses` and set its fallback outcome to `false`. Under **Targets**, assign the `true` option to each allowed **User ID**, using the sender's exact E.164 number, such as `+12025550101`. The application evaluates the flag with the verified sender as `user.id`.

Vercel provisions a `FLAGS` SDK key for each environment when the first flag is created. Deploy once with that variable. Subsequent target changes apply to new incoming messages after propagation without redeploying. Pause the flag to stop admitting messages from everyone. Empty targets, missing configuration, invalid flag values, and config read failures also block responses. Only explicit `true` targets grant access; rules, rollouts, and a `true` fallback cannot expand the allowlist. Email handles, wildcards, and formatted local numbers are not allowed.

Blocked messages receive an HTTP 200 acknowledgement and are ignored before owner storage, read receipts, or agent dispatch. Invalid signatures still receive 401. The policy is checked for every message, including existing conversations. A flag change does not cancel turns already admitted. See [setup and verification](docs/linq.md#response-flag-and-sender-allowlist).

## Browser

A reusable Chromium image has already been provisioned and its `AGENT_BROWSER_SNAPSHOT_ID` configured in Vercel. To rebuild it, run `npm run browser:snapshot` after pulling local project credentials. It installs pinned Playwright/Chromium in an empty Vercel Sandbox, verifies the browser can load a page, and prints the new snapshot ID. Update the deployment environment and redeploy. The reusable image never contains a user's cookies.

The browser tool supports navigation, page reading, clicking, filling, selecting, key presses, and screenshots. Each verified user gets a separate persistent browser sandbox. The browser and eve's shell run in different sandboxes; neither receives the application environment or Blob credentials. Production browser state is separated from development and preview state.

## Development and checks

```sh
npm ci
vercel env pull .env.local --yes
npm run dev
npm run check
npm run build
```

Run `node --env-file=.env.local --import tsx scripts/browser-smoke.ts` for the live two-user browser check. It creates temporary Vercel Sandboxes and deletes them after the check; Sandbox usage may incur charges.

The built-in shell is explicitly configured to use Vercel Sandbox, including in local development. Browser tools require a verified Linq identity; ordinary local TUI sessions cannot impersonate a phone user.

## Acceptance after credentials are connected

- Send and receive a real iMessage.
- Ask the agent to remember a harmless unique fact, then verify it in a later conversation.
- Use two sender accounts and confirm that memory, sessions, and browser cookies are separate.
- Try a general task such as finding information on a website using the browser.
- Verify a non-allowlisted sender, a group message, and an invalid webhook signature do not start a conversation. Remove an allowed sender and confirm their next message is ignored; disable the response flag and confirm all new messages are ignored.

eve's current Linq adapter deduplicates incoming webhook messages in process. Cross-instance retries can still cause duplicate conversational turns. There is no claim of exactly-once message processing, and payments must not be enabled until separate atomic purchase records and recovery rules are implemented.

No Link credentials, purchase tools, scheduled jobs, email monitoring, or password-vault integration are enabled. See [the payment handoff](src/payments/README.md) for the verified next-phase requirements. A real merchant confirmation remains necessary to pass the future flower-purchase evaluation.

## References

- [eve Linq channel](https://eve.dev/docs/channels/linq)
- [eve file memory](https://eve.dev/docs/memory/file)
- [eve deployment](https://eve.dev/docs/guides/deployment/vercel)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
