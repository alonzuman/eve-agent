import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextStreamPart, ToolSet } from "ai";
import { linqDeliveryEvents as events } from "../src/messaging/linq-delivery.js";
import linqInstructions from "../agent/instructions/linq.js";
// Exercise the pinned Eve emitter as well as our handlers. No model or Linq calls.
import { emitStreamContent } from "../node_modules/eve/dist/src/harness/emission.js";

type Channel = Parameters<typeof events["message.appended"]>[1];
const turn = { turnId: "turn_0", sequence: 0 };
const coordinates = { ...turn, stepIndex: 0 };
const delta = (messageDelta: string, stepIndex = 0) => ({ ...coordinates, stepIndex, messageDelta });
const complete = (message: string | null, stepIndex = 0, finishReason: "stop" | "tool-calls" | "length" = "stop") => ({
  ...coordinates, stepIndex, message, finishReason,
});

function fixture(post?: (text: string) => Promise<void>) {
  const sent: string[] = [];
  let typingCount = 0;
  const channel: Channel = {
    state: {},
    thread: {
      async post(text) { sent.push(text); await post?.(text); },
      async startTyping() { typingCount++; },
    },
  };
  return { channel, sent, typingCount: () => typingCount };
}

test("sends each delimited bubble before completion and flushes the final tail only once", async () => {
  const { channel, sent } = fixture();
  await events["turn.started"](turn, channel);
  await events["message.appended"](delta("found three places\n"), channel);
  assert.deepEqual(sent, []);
  await events["message.appended"](delta("\ni'd pick hillside"), channel);
  assert.deepEqual(sent, ["found three places"]);
  await events["message.appended"](delta("\n\nhttps://example.com/?a=1&b=two#details"), channel);
  assert.deepEqual(sent, ["found three places", "i'd pick hillside"]);
  const done = complete("found three places\n\ni'd pick hillside\n\nhttps://example.com/?a=1&b=two#details");
  await events["message.completed"](done, channel);
  await events["message.completed"](done, channel);
  events["turn.completed"](turn, channel);
  assert.deepEqual(sent, ["found three places", "i'd pick hillside", "https://example.com/?a=1&b=two#details"]);
});

test("all chunk boundaries preserve single newlines, CRLF, Unicode, and intact URLs", async () => {
  const text = "  first\nsecond\r\n\t\r\n\n\n café 🙌\n\nhttps://example.com/a_b?q=x%20y&n=1#part\n\nlast  ";
  const expected = ["first\nsecond", "café 🙌", "https://example.com/a_b?q=x%20y&n=1#part", "last"];
  for (let cut = 0; cut <= text.length; cut++) {
    const { channel, sent } = fixture();
    await events["message.appended"](delta(text.slice(0, cut)), channel);
    await events["message.appended"](delta(text.slice(cut)), channel);
    await events["message.completed"](complete(text), channel);
    assert.deepEqual(sent, expected, `split at UTF-16 offset ${cut}`);
  }
  const { channel, sent } = fixture();
  for (let i = 0; i < text.length; i++) await events["message.appended"](delta(text[i]), channel);
  await events["message.completed"](complete(text), channel);
  assert.deepEqual(sent, expected);
});

test("waits for each send, preserves order, and refreshes typing while generating", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { channel, sent, typingCount } = fixture(async () => { started.resolve(); await release.promise; });
  await events["turn.started"](turn, channel);
  const sending = events["message.appended"](delta("one\n\ntwo\n\nthree"), channel);
  await started.promise;
  assert.deepEqual(sent, ["one"]);
  release.resolve();
  await sending;
  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(typingCount(), 2);
  await events["message.completed"](complete("one\n\ntwo\n\nthree"), channel);
  assert.deepEqual(sent, ["one", "two", "three"]);
});

test("tool-step acknowledgments and multiple messages within one step remain distinct", async () => {
  const { channel, sent } = fixture();
  await events["message.appended"](delta("checking availability"), channel);
  await events["message.completed"](complete("checking availability", 0, "tool-calls"), channel);
  // Eve may continue emitting text after an inline tool without advancing the step.
  await events["message.appended"](delta("found a table\n\n7 pm works"), channel);
  await events["message.completed"](complete("found a table\n\n7 pm works"), channel);
  await events["message.appended"](delta("here's the link", 1), channel);
  await events["message.completed"](complete("here's the link", 1), channel);
  assert.deepEqual(sent, ["checking availability", "found a table", "7 pm works", "here's the link"]);
});

test("cancellation discards pending bubbles, blocks late events, and allows the next turn", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { channel, sent } = fixture(async () => { started.resolve(); await release.promise; });
  const sending = events["message.appended"](delta("already sent\n\nqueued\n\nunfinished"), channel);
  await started.promise;
  events["turn.cancelled"](turn, channel);
  release.resolve();
  await sending;
  await events["message.completed"](complete("already sent\n\nqueued\n\nunfinished"), channel);
  await events["message.appended"](delta("stale\n\n", 1), channel);
  assert.deepEqual(sent, ["already sent"]);
  assert.equal(channel.state.bubbleStream?.pending, "");
  const next = { turnId: "turn_1", sequence: 1 };
  await events["turn.started"](next, channel);
  await events["message.appended"]({ ...delta("new plan"), ...next }, channel);
  events["turn.cancelled"](turn, channel); // Late cancellation from the old turn.
  await events["message.completed"]({ ...complete("new plan"), ...next }, channel);
  assert.deepEqual(sent, ["already sent", "new plan"]);
});

test("a replacement turn also stops an outstanding send loop", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { channel, sent } = fixture(async () => { started.resolve(); await release.promise; });
  const sending = events["message.appended"](delta("one\n\ntwo\n\n"), channel);
  await started.promise;
  await events["turn.started"]({ turnId: "turn_1", sequence: 1 }, channel);
  release.resolve();
  await sending;
  assert.deepEqual(sent, ["one"]);
});

test("failed sends stop later bubbles and are not retried by completion", async () => {
  const { channel, sent } = fixture(async () => { throw new Error("provider timeout"); });
  await assert.rejects(events["message.appended"](delta("one\n\ntwo\n\n"), channel), /provider timeout/);
  await events["message.completed"](complete("one\n\ntwo\n\n"), channel);
  assert.deepEqual(sent, ["one"]);
});

test("model failure drops a draft and the failure cascade produces one notice", async () => {
  const { channel, sent } = fixture();
  await events["message.appended"](delta("a partial draft"), channel);
  const failure = { code: "MODEL_ERROR", message: "internal provider diagnostic" };
  await events["turn.failed"]({ ...turn, ...failure }, channel);
  await events["session.failed"]({ ...failure, sessionId: "session-a" }, channel);
  await events["message.completed"](complete("a partial draft"), channel);
  assert.deepEqual(sent, ["hit an error before i could finish. try that again?"]);
});

test("empty, withheld, and truncated completions never flush unfinished text", async () => {
  for (const done of [complete(null), complete("", 0, "length")]) {
    const { channel, sent } = fixture();
    await events["message.appended"](delta("unfinished"), channel);
    await events["message.completed"](done, channel);
    assert.deepEqual(sent, []);
  }
  const { channel, sent } = fixture();
  await events["message.appended"](delta("\n\n \n\n"), channel);
  await events["message.completed"](complete("\n\n \n\n"), channel);
  assert.deepEqual(sent, []);
});

test("completion-only providers work without duplicate final delivery", async () => {
  const { channel, sent } = fixture();
  await events["message.completed"](complete("one\n\ntwo\nthree"), channel);
  await events["message.completed"](complete("one\n\ntwo\nthree"), channel);
  assert.deepEqual(sent, ["one", "two\nthree"]);
});

test("buffer state stays private to each session and survives serialization", async () => {
  const alice = fixture(), bob = fixture();
  await events["message.appended"](delta("alice's "), alice.channel);
  await events["message.appended"](delta("bob's message\n\n"), bob.channel);
  alice.channel.state = JSON.parse(JSON.stringify(alice.channel.state));
  await events["message.appended"](delta("message\n\n"), alice.channel);
  await events["message.completed"](complete("alice's message\n\n"), alice.channel);
  assert.deepEqual(alice.sent, ["alice's message"]);
  assert.deepEqual(bob.sent, ["bob's message"]);
});

test("optional typing support and absent threads do not break the stream", async () => {
  const { channel, sent } = fixture();
  channel.thread!.startTyping = async () => { throw Object.assign(new Error("unsupported"), { code: "NOT_IMPLEMENTED" }); };
  await events["turn.started"](turn, channel);
  await events["message.appended"](delta("one\n\n"), channel);
  assert.deepEqual(sent, ["one"]);
  channel.thread = null;
  await events["message.completed"](complete("two", 1), channel);
  assert.deepEqual(sent, ["one"]);
});

test("Eve's real emitter delivers bubbles before generation ends and separates private reasoning", async () => {
  const firstBubble = Promise.withResolvers<void>();
  const { channel, sent } = fixture(async () => { firstBubble.resolve(); });
  async function* stream(): AsyncIterable<TextStreamPart<ToolSet>> {
    yield { type: "reasoning-delta", id: "r", text: "private scratch work" };
    yield { type: "text-delta", id: "m", text: "first bubble\n" };
    yield { type: "text-delta", id: "m", text: "\n" };
    // The provider is still generating: waiting here detects accidental batching.
    await firstBubble.promise;
    assert.deepEqual(sent, ["first bubble"]);
    yield { type: "text-delta", id: "m", text: "final bubble" };
  }
  await emitStreamContent(async event => {
    if (event.type === "message.appended") await events["message.appended"](event.data, channel);
    if (event.type === "message.completed") await events["message.completed"](event.data, channel);
  }, { ...coordinates, sessionStarted: true }, stream());
  assert.deepEqual(sent, ["first bubble", "final bubble"]);
});

test("iMessage delivery instructions apply only on the Linq channel", async () => {
  const resolver = linqInstructions.events["turn.started"]!;
  const context = {
    session: { id: "session-a", auth: { current: null, initiator: null } },
    channel: { metadata: { adapterName: "linq" } },
    messages: [],
  };
  assert.ok(await resolver({}, context));
  assert.equal(await resolver({}, { ...context, channel: { metadata: { adapterName: "slack" } } }), null);
  assert.equal(await resolver({}, { ...context, channel: {} }), null);
});
