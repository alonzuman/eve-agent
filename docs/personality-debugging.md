# Personality investigation — September 6, 2026

The reported small-talk failure reproduced locally with the original prompt and Sonnet. The voice instructions were present on every request: this was model adherence, not a missing personality file. The production candidate uses the revised composition prompt with `openai/gpt-5.6-sol`; wider pre-merge testing exposed intermittent failures in the earlier Luna candidate, described below. The candidate is local and has not been deployed.

## What failed and why

The baseline checkout was `2c2b328`, using Eve `0.52.2`, AI SDK `7.0.93`, Node `24.20.0`, and `anthropic/claude-sonnet-5`.

The original voice file already required lowercase, prohibited generic offers, and discouraged unnecessary questions. A temporary local fetch observer confirmed that all four outgoing Gateway requests included those rules in system context, with 18,115 serialized characters on each request. Only rule-presence, role, and length metadata were retained; the observer was removed.

The original six conversation evals passed, but none tested a sustained ordinary greeting. The new four-turn case failed in four baseline runs, including “anything you need help with, or just saying hi?” and “nice, enjoy it. i'll be here whenever you need something.” The contextual judge sometimes missed uppercase “I”, so the regression also checks casing and common service offers deterministically. These are scenario-specific assertions, not transformations applied to delivered text.

The root identity emphasized a general-purpose assistant, and the 1,814-word voice guide lacked greetings and everyday self-description examples. Those are plausible reasons for falling into a service-desk register. The experiments establish noncompliance and a working candidate; they do not isolate prompt length or any one phrase as the cause. HTTP reproductions also show that Linq delivery and stale production history are not necessary for the failure. We did not retrieve the exact production request behind the user's historical transcript.

## Experiments

The judge stayed `anthropic/claude-sonnet-5` for the initial agent-model comparisons. A later Opus judge probe also returned malformed tool calls, so the final configuration retains Sonnet with strict tool schemas and bounded validation retries. All evaluations used the real Eve runtime and Gateway, unless explicitly identified as an early direct-Gateway probe.

| Candidate | Observed result |
| --- | --- |
| Stronger wording added to the original Sonnet prompt | Still failed the reported conversation |
| Compact voice and assistant/pilot identity, Sonnet | 4/5 fresh small-talk cases passed |
| Compact voice plus a system-role turn reminder, Sonnet | 3/5 passed |
| Strong writer identity and `<message>` examples, Sonnet | 5/5 passed; some weak self-descriptions remained |
| Writer identity, tags, and a user-role composition request, Luna | 5/5 passed |
| Writer identity and plain text, Luna, without the turn request | 13/14 broader cases passed; one small-talk failure and some invented callbacks to fictional examples |
| Original prompt with Luna alone | 1/5 passed; capitalization and generic assistant language returned |
| Final plain-text writer prompt, fenced examples, and per-turn composition request, Luna | 16/16 broader cases passed, then 5/5 additional repetitions |
| Final candidate with the Linq delivery prompt enabled in a local HTTP fixture | 5/5 additional repetitions passed |

These are finite samples, with different case sets where noted, not a statistical ranking of the models. Model choice alone did not solve the problem. The final changes combine framing, examples, and a composition request; their individual contributions have not all been independently measured.

## Final implementation

- `agent/agent.ts` selects `openai/gpt-5.6-sol` through the existing Gateway.
- `agent/instructions.md` frames the model as the writer of Eve's messages and her tool operator. The operational capabilities and action boundaries remain intact.
- `agent/instructions/voice.md` is an 821-word voice contract with fenced fictional examples. It explicitly treats social conversation as a complete interaction, requires brief honest self-description, and preserves requested artifact styles and exact text.
- `agent/instructions/compose.ts` appends an application-authored user-role request before each incoming message using Eve's supported `turn.started` hook. It asks for a response appropriate to the social, practical, or personal moment, grounded in actual conversation rather than fictional examples. The person's own request follows it and explicit style requests remain supported.

The composition request adds about 210 words to durable history per turn. It does not add a model call or an outbound message. Long-history behavior, compaction, and context growth have not been evaluated here.

Explicit delivery tags were useful during exploration, but the final candidate works with the existing plain-text bubble format. There is no new decoder, casing filter, second-pass rewriter, or change to streaming delivery.

An actual earlier Luna-fixture reply to the location question was:

> i’m not based anywhere — i’m software. but sf gets the scenic half of this conversation today.

## Pre-merge hardening

Re-running on main's newer typing-pacing code (`947dea3`) exposed two intermittent failures in the held-out conversations: an uppercase “I’m” when asked about plans, and a reply implying that talking to the user relieved Eve's boredom. That run passed 14 of 16 cases (`.eve/evals/2026-09-06T23-17-30/`). The original four-turn regression and all five of its repetitions still passed.

The per-turn request now explicitly checks lowercase pronouns/contractions after punctuation and rules out invented boredom, loneliness, leisure time, and personal plans. The stability suite now repeats both held-out social scenarios five times as well, for fifteen fresh conversations. Capitalization and generic-offer assertions and all judge thresholds are unchanged. With the hardened prompt, Luna still emitted uppercase “I’m” in a 26-case run (`23-21-22`); Sol passed the deterministic voice checks in the same comparison. Sol was selected for the production candidate.

Two evaluator problems also surfaced. The broad phrase “human feelings” could penalize ordinary conversational preferences, contrary to the intended persona. The social rubric now explicitly allows preferences while rejecting claims of boredom, emotional needs, physical activity, or an offscreen life, including jokes that imply such needs. Separately, both Sonnet and an Opus probe occasionally returned malformed `select_choice` tool arguments. `evals/judge-model.ts` requests strict schemas and validates the choice and required rationale before Eve's adapter discards invalid inputs. It retries malformed classifications at most twice and fails if none is valid. It never retries a valid failing grade, changes a grade, or affects agent output. Unit tests cover negative-grade preservation, malformed JSON/fields, and retry exhaustion.

Rebasing also retained the new shopping and visual-card capabilities. Satori is kept external to the authored bundle. HarfBuzz is pinned directly and fully traced with Nitro’s trailing-star selector so its runtime-loaded WebAssembly asset is included in the production package. CI initializes that packaged engine after building.

## Verification and reproduction

With Node 24 and the project's development Gateway, Sandbox, and memory credentials:

```sh
npm run check
npm run build
npm run eval:conversation
npm run eval:voice-stability
```

Before the pre-merge hardening above, the combined conversation/stability run passed 16 cases, 85 deterministic gates, and 38 contextual judgments. This covers the original six cases, the four-turn transcript regression, two held-out social conversations, exact case-sensitive text and literal markup, actual sandbox SHA-256 computation, and five fresh repetitions. Another five repetitions passed without prompt changes. The Linq-prompt fixture then passed five more: 26 cases total, with 175 gates and 78 judgments passing. That checkout passed typecheck, all 55 automated tests, and the application build. After rebasing onto the typing-pacing change, typecheck, all 60 automated tests, and the build pass.

Local, ignored evidence:

- Original Sonnet failures: `.eve/evals/2026-09-06T22-36-24/`, `22-37-21/`, `22-37-49/`, and `22-38-18/`.
- Original prompt with Luna: `.eve/evals/2026-09-06T23-04-35/`.
- Final 16-case suite: `.eve/evals/2026-09-06T23-09-28/`.
- Additional five repetitions: `.eve/evals/2026-09-06T23-11-01/`.
- Linq prompt fixture: `.eve/personality-experiments/linq-eval-app/.eve/evals/2026-09-06T23-11-17/`.

The fixture copies the final application and changes only the Linq instruction resolver's channel condition to include the same delivery prompt on HTTP. It uses the same five repetition evals and does not send phone messages. Automated tests separately cover the existing Linq stream delivery and typing behavior. A production deployment and handset check remain separate from this local prompt fix.

The hardened Sol candidate subsequently passed all 31 conversation, stability, and shopping cases: 191 gates and 83 contextual judgments. A separate six-sample calibration accepted two valid conversational replies and rejected four known violations (invented boredom, physical activity, personal plans, and a service closer).
