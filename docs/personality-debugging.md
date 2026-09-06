# Personality investigation — September 6, 2026

The reported small-talk failure reproduced locally with the original prompt and Sonnet. The voice instructions were present on every request: this was model adherence, not a missing personality file. A revised composition prompt with `openai/gpt-5.6-luna` now passes the regression repeatedly, alongside the existing conversation and capability checks. The candidate is local and has not been deployed.

## What failed and why

The baseline checkout was `2c2b328`, using Eve `0.52.2`, AI SDK `7.0.93`, Node `24.20.0`, and `anthropic/claude-sonnet-5`.

The original voice file already required lowercase, prohibited generic offers, and discouraged unnecessary questions. A temporary local fetch observer confirmed that all four outgoing Gateway requests included those rules in system context, with 18,115 serialized characters on each request. Only rule-presence, role, and length metadata were retained; the observer was removed.

The original six conversation evals passed, but none tested a sustained ordinary greeting. The new four-turn case failed in four baseline runs, including “anything you need help with, or just saying hi?” and “nice, enjoy it. i'll be here whenever you need something.” The contextual judge sometimes missed uppercase “I”, so the regression also checks casing and common service offers deterministically. These are scenario-specific assertions, not transformations applied to delivered text.

The root identity emphasized a general-purpose assistant, and the 1,814-word voice guide lacked greetings and everyday self-description examples. Those are plausible reasons for falling into a service-desk register. The experiments establish noncompliance and a working candidate; they do not isolate prompt length or any one phrase as the cause. HTTP reproductions also show that Linq delivery and stale production history are not necessary for the failure. We did not retrieve the exact production request behind the user's historical transcript.

## Experiments

The judge stayed `anthropic/claude-sonnet-5` when changing the agent model. All evaluations used the real Eve runtime and Gateway, unless explicitly identified as an early direct-Gateway probe.

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

- `agent/agent.ts` selects `openai/gpt-5.6-luna` through the existing Gateway.
- `agent/instructions.md` frames the model as the writer of Eve's messages and her tool operator. The operational capabilities and action boundaries remain intact.
- `agent/instructions/voice.md` is an 821-word voice contract with fenced fictional examples. It explicitly treats social conversation as a complete interaction, requires brief honest self-description, and preserves requested artifact styles and exact text.
- `agent/instructions/compose.ts` appends an application-authored user-role request before each incoming message using Eve's supported `turn.started` hook. It asks for a response appropriate to the social, practical, or personal moment, grounded in actual conversation rather than fictional examples. The person's own request follows it and explicit style requests remain supported.

The composition request adds about 150 words to durable history per turn. It does not add a model call or an outbound message. Long-history behavior, compaction, and context growth have not been evaluated here.

Explicit delivery tags were useful during exploration, but the final candidate works with the existing plain-text bubble format. There is no new decoder, casing filter, second-pass rewriter, or change to streaming delivery.

An actual final-fixture reply to the location question was:

> i’m not based anywhere — i’m software. but sf gets the scenic half of this conversation today.

## Verification and reproduction

With Node 24 and the project's development Gateway, Sandbox, and memory credentials:

```sh
npm run check
npm run build
npm run eval:conversation
npm run eval:voice-stability
```

The combined conversation/stability run passed 16 cases, 85 deterministic gates, and 38 contextual judgments. This covers the original six cases, the four-turn transcript regression, two held-out social conversations, exact case-sensitive text and literal markup, actual sandbox SHA-256 computation, and five fresh repetitions. Another five repetitions passed without prompt changes. The Linq-prompt fixture then passed five more: 26 cases total, with 175 gates and 78 judgments passing. The final application typecheck, all 55 automated tests, and the application build pass.

Local, ignored evidence:

- Original Sonnet failures: `.eve/evals/2026-09-06T22-36-24/`, `22-37-21/`, `22-37-49/`, and `22-38-18/`.
- Original prompt with Luna: `.eve/evals/2026-09-06T23-04-35/`.
- Final 16-case suite: `.eve/evals/2026-09-06T23-09-28/`.
- Additional five repetitions: `.eve/evals/2026-09-06T23-11-01/`.
- Linq prompt fixture: `.eve/personality-experiments/linq-eval-app/.eve/evals/2026-09-06T23-11-17/`.

The fixture copies the final application and changes only the Linq instruction resolver's channel condition to include the same delivery prompt on HTTP. It uses the same five repetition evals and does not send phone messages. Automated tests separately cover the existing Linq stream delivery and typing behavior. A production deployment and handset check remain separate from this local prompt fix.
