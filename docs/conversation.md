# Conversation and iMessage delivery

Eve's identity, capability limits, and action boundaries live in `agent/instructions.md`. `agent/instructions/voice.md` supplies the standing personality: casual, concise, curious, warm, and willing to exercise judgment. Tone adapts to the user; artifacts retain their requested style. Stable preferences use the existing private memory provider.

The voice instructions include inline example exchanges showing banter, curiosity, good news, disappointment, concise answers, clarification, recommendations, pushback, uncertainty, task progress, blockers, corrections, frustration, conversational continuity, memory updates, capability limits, detailed explanations, formal drafts, and message formatting. Fictional facts and successful tool outcomes are explicitly labeled as example context. These demonstrate delivery and tone; they do not require a follow-up question in every reply. The conversation eval prompts remain separate from the demonstration scenarios.

`agent/instructions/linq.ts` adds system instructions at each turn only when Eve's channel metadata identifies the Linq adapter. The HTTP/dev channel does not acquire iMessage formatting rules. This uses Eve's instruction composition rather than a second prompt builder or a copied NoScroll harness.

## Bubble boundaries

Ordinary assistant prose is delivered as it is generated, including useful acknowledgments before tools. Private reasoning and tool payloads are separate Eve events and are not delivered.

- A blank line ends a bubble. The channel sends it as soon as that delimiter arrives in `message.appended`.
- A single newline stays inside the bubble. CRLF and a whitespace-only blank line also work; delimiters can span delta chunks.
- `message.completed` sends only the remaining suffix. The full completion text is not sent again. A provider emitting no deltas falls back to splitting the completed text.
- Empty chunks are ignored. There is no character cap, forced sentence splitting, artificial delay, or post-and-edit animation. Fast generation can still yield bubbles close together.
- URLs and single line breaks remain intact. Chat text and generated file content follow separate formatting rules.

`src/messaging/linq-delivery.ts` implements this through the existing Linq channel's event overrides. Eve handles ordered events, sessions, authentication, tool execution, and steering. The helper awaits each post and stores only its delivery state in that session's channel state. It also accounts for multiple assistant messages within one step when Eve executes inline tools.

## Interruption and failures

When Eve signals cancellation, the channel discards unsent text and ignores later events from that turn. A replacement turn starts with a fresh buffer. Cancellation remains cooperative: an in-flight send cannot be recalled, and callbacks already being drained by Eve can settle before the cancellation event. This does not provide instantaneous recall on receipt of a new webhook.

A failed send stops the remaining bubbles; this helper does not retry that send. A failed, withheld, or truncated generation does not flush its unfinished tail. A turn/session failure cascade produces one brief failure notice. Already-delivered text stays visible.

This change does not add an exactly-once delivery guarantee. Provider SDK retries and process failures around a send can still produce ambiguous outcomes, and the existing cross-instance inbound deduplication limitation remains. It introduces no purchase or other consequential action capability.

## Verification

Run `npm run check` and `npm run build` with Node.js 24. The delivery tests cover early sends, every split point in a sample containing CRLF/Unicode/URLs, ordering, completion deduplication, tool-step boundaries, cancellation, send failures, session isolation, and channel-scoped instructions. One test drives the pinned Eve stream emitter and holds generation open until its first bubble arrives; reasoning events are included to verify they stay private.

Run `npm run eval:conversation` with the project's model, Sandbox, and memory credentials configured to review real model behavior through Eve. The six synthetic cases cover banter, a terse recommendation, a personal disclosure, formal tone and an email draft, a detailed explanation, and an unavailable reminder request. These use the HTTP eval channel and assess voice and capability honesty; they do not send real iMessages or validate phone delivery. Eve saves transcripts and scores under `.eve/evals/`.

For a live Linq check after deployment, ask for a few short recommendations, a compact list with single line breaks, and a link. Verify bubble boundaries and early arrival. Interrupt a longer response and verify the replacement continues naturally. Live arrival timing depends on the model, Eve, Linq, and the receiving device.

References: [Eve instructions](https://eve.dev/docs/instructions), [Chat SDK channel events](https://eve.dev/docs/channels/chat-sdk), and the pinned `eve@0.52.2` implementation.
