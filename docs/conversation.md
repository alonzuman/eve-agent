# Conversation and iMessage delivery

Eve's identity, capability limits, and action boundaries live in `agent/instructions.md`. The model writes Eve's side of a private conversation and operates tools on her behalf. `agent/instructions/voice.md` supplies the standing personality: lowercase, casual, concise, curious, warm, and willing to exercise judgment. Tone adapts to explicit user requests; artifacts and exact quotations retain their required style. Stable preferences use the existing private memory provider.

The compact voice contract includes fictional, fenced examples of greetings, ordinary social chat, honest self-description, banter, disappointment, recommendations, formal drafts, and bubble formatting. Examples teach patterns and must not become memories or callbacks about the current person. The conversation eval prompts remain separate from these demonstrations.

`agent/instructions/compose.ts` uses Eve's `turn.started` instruction hook to append an application-authored composition request in the user role, immediately before the incoming message. It asks for a response suited to social chat, a practical task, or a personal disclosure, while honoring the person's actual request. This framing improved the tested small-talk behavior beyond a system-only reminder. It adds about 150 words of durable context each turn, so long-history behavior and context growth remain worth monitoring. It is input context, never a delivered message; there is no second generation or output rewriting stage.

`agent/instructions/linq.ts` adds system instructions at each turn only when Eve's channel metadata identifies the Linq adapter. The HTTP/dev channel does not acquire iMessage formatting rules. This uses Eve's instruction composition rather than a second prompt builder or a copied NoScroll harness.

## Bubble boundaries

Ordinary assistant prose is delivered as it is generated, including useful acknowledgments before tools. Private reasoning and tool payloads are separate Eve events and are not delivered.

- A blank line ends a bubble. The channel extracts it as soon as that delimiter arrives in `message.appended` and sends the first bubble in each turn immediately.
- A single newline stays inside the bubble. CRLF and a whitespace-only blank line also work; delimiters can span delta chunks.
- `message.completed` sends only the remaining suffix. The full completion text is not sent again. A provider emitting no deltas falls back to splitting the completed text.
- Every later bubble starts typing, waits for a length-based pause, and then sends, including completion tails, completion-only providers, and messages after tools in the same turn. The starting pace is 250 ms plus 25 ms per Unicode code point, varied by ±15% per bubble and clamped to 400–4,000 ms. For example, a 30-character message takes about 1 second and a 100-character message about 2.75 seconds. These pacing choices can be tuned.
- Empty chunks are ignored and do not consume the immediate first bubble. There is no character cap, forced sentence splitting, or post-and-edit animation.
- URLs and single line breaks remain intact. Chat text and generated file content follow separate formatting rules.

`src/messaging/linq-delivery.ts` implements this through the existing Linq channel's event overrides. Eve handles ordered events, sessions, authentication, tool execution, and steering. The helper awaits each pause and post and stores its buffer and sent count in that session's serializable channel state. It also accounts for multiple assistant messages within one step when Eve executes inline tools. Timing and randomness can be injected in tests; production uses a normal awaited timer. Pacing still applies when a provider does not support typing indicators.

## Interruption and failures

When Eve signals cancellation, the channel discards unsent text and ignores later events from that turn. The sender rechecks cancellation after starting typing and after the pause before posting. A replacement turn starts with a fresh buffer and an immediate first bubble. Cancellation remains cooperative: an in-flight send cannot be recalled, and callbacks already being drained by Eve can settle before the cancellation event, including their typing pauses. This does not provide instantaneous recall on receipt of a new webhook.

A failed send stops the remaining bubbles; this helper does not retry that send. A failed, withheld, or truncated generation does not flush its unfinished tail. A turn/session failure cascade produces one brief failure notice. Already-delivered text stays visible.

Typing resumes after a streamed bubble while generation continues. Completion, cancellation, and failure explicitly stop typing, including when the reply ends with a blank line and has no final suffix to send. The channel awaits this cleanup and ignores stale turn events. Since Eve's pinned Linq adapter only exposes starting typing, `src/messaging/linq-typing.ts` calls Linq's documented stop endpoint with the existing server API key. Cleanup has a five-second timeout and no retries; failures are logged without failing or resending the reply.

This change does not add an exactly-once delivery guarantee. Provider SDK retries and process failures around a send can still produce ambiguous outcomes, and the existing cross-instance inbound deduplication limitation remains. It introduces no purchase or other consequential action capability.

## Reactions and threaded replies

`react_to_message` and `reply_to_message` are separate, awaited tools. They take a short message reference such as `m123`; only the server resolves the Linq message ID, part index, and destination. A threaded reply stays in the same Eve conversation and sends one bubble through Linq's `reply_to` field. New ordinary assistant text still uses the streaming channel.

Admitted inbound message parts are saved to Postgres before dispatch. Their references accompany the incoming text, including input that steers an active turn. At turn start, `agent/instructions/message-references.ts` adds the latest 40 parts and their available reply parents as quoted conversation context. Successful outbound text bubbles and visual-card captions and attachments are saved from their provider receipts. A threaded reply returns its new reference immediately. No Eve internal dispatch symbols or modified adapter implementation are used.

The tools claim an action in Postgres before sending it, then persist provider acceptance. A duplicate invocation with the same target and content in the same turn reuses the receipt. A pending or ambiguous attempt is not automatically sent again. These are conversational actions in the current private chat; they do not require another permission prompt.

The instructions allow a reaction to be the whole response and prevent repeating a tool-delivered threaded reply as ordinary text. After a tool fully answers the user, the model can finish with Eve's built-in `<eve-empty-delivery/>` marker. The streaming helper suppresses both literal and escaped marker forms, even if they arrive with a bubble delimiter before completion. Tool payloads remain private. See [storage and recovery limits](database.md#delivery-and-recovery-limits).

## Verification

Run `npm run check` and `npm run build` with Node.js 24. The delivery tests cover early sends, every split point in a sample containing CRLF/Unicode/URLs, ordering, completion deduplication, tool-step boundaries, cancellation, send failures, session isolation, and channel-scoped instructions. Controlled timers also verify typing-before-send order, proportional delays and jitter bounds, pacing across serialization and tools, per-turn reset, and cancellation or replacement during a pause. Typing tests cover terminal cleanup, trailing delimiters, stale events, and failed cleanup; an integration test uses the registered channel and real Linq adapter with mocked HTTP to verify the final stop request is awaited. One test drives the pinned Eve stream emitter and holds generation open until its first bubble arrives; reasoning events are included to verify they stay private.

Run `npm run eval:conversation` with the project's Gateway, Sandbox, and memory credentials configured to review real model behavior through Eve. It selects eleven cases: the original six conversation cases, the reported four-turn small-talk regression, two held-out social conversations, exact-text preservation, and a real sandbox hash calculation. The casual cases check every reply with deterministic capitalization and generic-offer checks alongside a contextual judge. The capitalization check is scoped to these scenarios, not intended as a general output filter. Formal artifacts, URLs, and literal markup are checked separately. These use the HTTP eval channel and do not send real iMessages. Eve saves transcripts and scores under `.eve/evals/`.

Run `npm run eval:voice-stability` for five fresh repetitions of the reported conversation. The current Luna model and composition prompt passed all eleven conversation cases and all five repetitions in a combined run. The judge remains Sonnet across agent-model comparisons. See [the personality investigation](personality-debugging.md) for baseline failures, prompt experiments, and verification limits; these finite samples do not guarantee future adherence.

For a live Linq check after deployment, ask for a few short recommendations, a compact list with single line breaks, and a link. Verify the first bubble arrives promptly and later bubbles show typing with longer pauses for longer text. Interrupt a longer response and verify the replacement continues naturally. Check that typing disappears after the final reply and after cancellation without another message. Live arrival timing depends on the model, Eve, Linq, and the receiving device.

References: [Eve instructions](https://eve.dev/docs/instructions), [Chat SDK channel events](https://eve.dev/docs/channels/chat-sdk), [Linq typing indicators](https://docs.linqapp.com/guides/chats/typing-indicators/), and the pinned `eve@0.52.2` implementation.
