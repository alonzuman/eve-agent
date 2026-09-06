import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextStreamPart, ToolSet } from "ai";
import { createLinqDeliveryEvents, linqDeliveryEvents } from "../src/messaging/linq-delivery.js";
import linqInstructions from "../agent/instructions/linq.js";
// Exercise the pinned Eve emitter as well as our handlers. No model or Linq calls.
import { emitStreamContent } from "../node_modules/eve/dist/src/harness/emission.js";

type Channel = Parameters<typeof linqDeliveryEvents["message.appended"]>[1];
const turn = { turnId: "turn_0", sequence: 0 };
const coordinates = { ...turn, stepIndex: 0 };
const delta = (messageDelta: string, stepIndex = 0) => ({ ...coordinates, stepIndex, messageDelta });
const complete = (message: string | null, stepIndex = 0, finishReason: "stop" | "tool-calls" | "length" = "stop") => ({
  ...coordinates, stepIndex, message, finishReason,
});

function fixture(post?: (text: string) => Promise<void>, stopTyping?: () => Promise<void>) {
  const sent: string[] = [];
  let typingCount = 0, typingStops = 0;
  let isTyping = false;
  const channel: Channel = {
    state: {},
    thread: {
      id: "linq:test-chat",
      async post(text) { sent.push(text); await post?.(text); isTyping = false; },
      async startTyping() { typingCount++; isTyping = true; },
    },
  };
  // Keep extraction tests fast; pacing tests below control their own sleeper.
  const events = createLinqDeliveryEvents(async threadId => {
    assert.equal(threadId, channel.thread?.id);
    await stopTyping?.();
    typingStops++;
    isTyping = false;
  }, { sleep: async () => {} });
  return { events, channel, sent, typingCount: () => typingCount, typingStops: () => typingStops, isTyping: () => isTyping };
}

test("sends each delimited bubble before completion and flushes the final tail only once", async () => {
  const { events, channel, sent } = fixture();
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
  await events["turn.completed"](turn, channel);
  assert.deepEqual(sent, ["found three places", "i'd pick hillside", "https://example.com/?a=1&b=two#details"]);
});

test("all chunk boundaries preserve single newlines, CRLF, Unicode, and intact URLs", async () => {
  const text = "  first\nsecond\r\n\t\r\n\n\n café 🙌\n\nhttps://example.com/a_b?q=x%20y&n=1#part\n\nlast  ";
  const expected = ["first\nsecond", "café 🙌", "https://example.com/a_b?q=x%20y&n=1#part", "last"];
  for (let cut = 0; cut <= text.length; cut++) {
    const { events, channel, sent } = fixture();
    await events["message.appended"](delta(text.slice(0, cut)), channel);
    await events["message.appended"](delta(text.slice(cut)), channel);
    await events["message.completed"](complete(text), channel);
    assert.deepEqual(sent, expected, `split at UTF-16 offset ${cut}`);
  }
  const { events, channel, sent } = fixture();
  for (let i = 0; i < text.length; i++) await events["message.appended"](delta(text[i]), channel);
  await events["message.completed"](complete(text), channel);
  assert.deepEqual(sent, expected);
});

test("waits for each send, preserves order, and refreshes typing while generating", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { events, channel, sent, typingCount } = fixture(async () => { started.resolve(); await release.promise; });
  await events["turn.started"](turn, channel);
  const sending = events["message.appended"](delta("one\n\ntwo\n\nthree"), channel);
  await started.promise;
  assert.deepEqual(sent, ["one"]);
  release.resolve();
  await sending;
  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(typingCount(), 3);
  await events["message.completed"](complete("one\n\ntwo\n\nthree"), channel);
  assert.deepEqual(sent, ["one", "two", "three"]);
});

test("tool-step acknowledgments and multiple messages within one step remain distinct", async () => {
  const delays: number[] = [];
  const events = createLinqDeliveryEvents(async () => {}, { sleep: async ms => { delays.push(ms); } });
  const { channel, sent } = fixture();
  await events["message.appended"](delta("checking availability"), channel);
  await events["message.completed"](complete("checking availability", 0, "tool-calls"), channel);
  // Eve may continue emitting text after an inline tool without advancing the step.
  await events["message.appended"](delta("found a table\n\n7 pm works"), channel);
  await events["message.completed"](complete("found a table\n\n7 pm works"), channel);
  await events["message.appended"](delta("here's the link", 1), channel);
  await events["message.completed"](complete("here's the link", 1), channel);
  assert.deepEqual(sent, ["checking availability", "found a table", "7 pm works", "here's the link"]);
  assert.equal(delays.length, 3, "only the first bubble in the entire turn skips the delay");
});

test("the first bubble is immediate and subsequent bubbles type and wait before sending", async () => {
  const release = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const actions: string[] = [];
  const { channel, sent } = fixture(async text => { actions.push(`send:${text}`); });
  channel.thread!.startTyping = async () => { actions.push("typing"); };
  const events = createLinqDeliveryEvents(async () => {}, {
    random: () => 0.5,
    sleep: async ms => { actions.push(`wait:${ms}`); waiting.resolve(); await release.promise; },
  });
  await events["turn.started"](turn, channel);
  const sending = events["message.appended"](delta("first\n\n0123456789\n\nlast"), channel);
  await waiting.promise;
  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(actions, ["typing", "send:first", "typing", "wait:500"]);
  release.resolve();
  await sending;
  await events["message.completed"](complete("first\n\n0123456789\n\nlast"), channel);
  assert.deepEqual(sent, ["first", "0123456789", "last"]);
  assert.deepEqual(actions.slice(4), ["send:0123456789", "typing", "typing", "wait:400", "send:last"]);
});

test("delays scale with Unicode text length, vary slightly, and stay bounded", async () => {
  for (const [text, random, expected] of [
    ["hi", 0.5, 400],
    ["🙌".repeat(8), 0.5, 450],
    ["a".repeat(30), 0, 850],
    ["a".repeat(30), 0.5, 1000],
    ["a".repeat(30), 1, 1150],
    ["a".repeat(100), 0.5, 2750],
    ["a".repeat(10_000), 0.5, 4000],
  ] as const) {
    const delays: number[] = [];
    const events = createLinqDeliveryEvents(async () => {}, { random: () => random, sleep: async ms => { delays.push(ms); } });
    const { channel, sent } = fixture();
    await events["message.completed"](complete(`first\n\n${text}`), channel);
    assert.deepEqual(delays, [expected]);
    assert.deepEqual(sent, ["first", text]);
  }
});

test("pacing survives serialization, ignores empty bubbles, and resets only for a new turn", async () => {
  const delays: number[] = [];
  const events = createLinqDeliveryEvents(async () => {}, { sleep: async ms => { delays.push(ms); } });
  const alice = fixture(), bob = fixture();
  await events["message.completed"](complete("\n\n \n\nfirst"), alice.channel);
  assert.deepEqual(delays, []);
  alice.channel.state = JSON.parse(JSON.stringify(alice.channel.state));
  await events["message.completed"](complete("second", 1), alice.channel);
  await events["message.completed"](complete("bob's first"), bob.channel);
  assert.equal(delays.length, 1);
  const next = { turnId: "turn_1", sequence: 1 };
  await events["turn.started"](next, alice.channel);
  await events["message.completed"]({ ...complete("next first"), ...next }, alice.channel);
  assert.equal(delays.length, 1);
  await events["message.completed"]({ ...complete("next second", 1), ...next }, alice.channel);
  assert.equal(delays.length, 2);
  assert.deepEqual(alice.sent, ["first", "second", "next first", "next second"]);
});

test("cancellation, replacement, and thread loss during a pause discard unsent bubbles", async () => {
  for (const interruption of ["cancel", "replace", "disconnect"] as const) {
    const release = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const events = createLinqDeliveryEvents(async () => {}, { sleep: async () => { waiting.resolve(); await release.promise; } });
    const { channel, sent } = fixture();
    const sending = events["message.appended"](delta("first\n\nqueued\n\nlast"), channel);
    await waiting.promise;
    if (interruption === "cancel") await events["turn.cancelled"](turn, channel);
    else if (interruption === "replace") await events["turn.started"]({ turnId: "turn_1", sequence: 1 }, channel);
    else channel.thread = null;
    release.resolve();
    await sending;
    await events["message.completed"](complete("first\n\nqueued\n\nlast"), channel);
    assert.deepEqual(sent, ["first"], interruption);
  }
});

test("cancellation discards pending bubbles, blocks late events, and allows the next turn", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { events, channel, sent } = fixture(async () => { started.resolve(); await release.promise; });
  const sending = events["message.appended"](delta("already sent\n\nqueued\n\nunfinished"), channel);
  await started.promise;
  await events["turn.cancelled"](turn, channel);
  release.resolve();
  await sending;
  await events["message.completed"](complete("already sent\n\nqueued\n\nunfinished"), channel);
  await events["message.appended"](delta("stale\n\n", 1), channel);
  assert.deepEqual(sent, ["already sent"]);
  assert.equal(channel.state.bubbleStream?.pending, "");
  const next = { turnId: "turn_1", sequence: 1 };
  await events["turn.started"](next, channel);
  await events["message.appended"]({ ...delta("new plan"), ...next }, channel);
  await events["turn.cancelled"](turn, channel); // Late cancellation from the old turn.
  await events["message.completed"]({ ...complete("new plan"), ...next }, channel);
  assert.deepEqual(sent, ["already sent", "new plan"]);
});

test("a replacement turn also stops an outstanding send loop", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { events, channel, sent } = fixture(async () => { started.resolve(); await release.promise; });
  const sending = events["message.appended"](delta("one\n\ntwo\n\n"), channel);
  await started.promise;
  await events["turn.started"]({ turnId: "turn_1", sequence: 1 }, channel);
  release.resolve();
  await sending;
  assert.deepEqual(sent, ["one"]);
});

test("a late typing failure from an old turn cannot stop its replacement", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { events, channel, sent } = fixture();
  await events["message.completed"](complete("first"), channel);
  channel.thread!.startTyping = async () => {
    started.resolve();
    await release.promise;
    throw new Error("typing failed");
  };
  const sending = events["message.completed"](complete("second", 1), channel);
  const failed = assert.rejects(sending, /typing failed/);
  await started.promise;
  channel.thread!.startTyping = async () => {};
  const next = { turnId: "turn_1", sequence: 1 };
  await events["turn.started"](next, channel);
  release.resolve();
  await failed;
  await events["message.completed"]({ ...complete("replacement"), ...next }, channel);
  assert.deepEqual(sent, ["first", "replacement"]);
});

test("failed sends stop later bubbles and are not retried by completion", async () => {
  const { events, channel, sent } = fixture(async () => { throw new Error("provider timeout"); });
  await assert.rejects(events["message.appended"](delta("one\n\ntwo\n\n"), channel), /provider timeout/);
  await events["message.completed"](complete("one\n\ntwo\n\n"), channel);
  assert.deepEqual(sent, ["one"]);
});

test("model failure drops a draft and the failure cascade produces one notice", async () => {
  const { events, channel, sent } = fixture();
  await events["message.appended"](delta("a partial draft"), channel);
  const failure = { code: "MODEL_ERROR", message: "internal provider diagnostic" };
  await events["turn.failed"]({ ...turn, ...failure }, channel);
  await events["session.failed"]({ ...failure, sessionId: "session-a" }, channel);
  await events["message.completed"](complete("a partial draft"), channel);
  assert.deepEqual(sent, ["hit an error before i could finish. try that again?"]);
});

test("empty, withheld, and truncated completions never flush unfinished text", async () => {
  for (const done of [complete(null), complete("", 0, "length")]) {
    const { events, channel, sent } = fixture();
    await events["message.appended"](delta("unfinished"), channel);
    await events["message.completed"](done, channel);
    assert.deepEqual(sent, []);
  }
  const { events, channel, sent } = fixture();
  await events["message.appended"](delta("\n\n \n\n"), channel);
  await events["message.completed"](complete("\n\n \n\n"), channel);
  assert.deepEqual(sent, []);
});

test("completion-only providers work without duplicate final delivery", async () => {
  const { events, channel, sent } = fixture();
  await events["message.completed"](complete("one\n\ntwo\nthree"), channel);
  await events["message.completed"](complete("one\n\ntwo\nthree"), channel);
  assert.deepEqual(sent, ["one", "two\nthree"]);
});

test("turn completion clears typing when the final bubble already streamed with a trailing delimiter", async () => {
  for (const message of ["done\n\n", "done\r\n \r\n", "one\n\ndone\n\n"]) {
    const { events, channel, sent, isTyping } = fixture();
    await events["turn.started"](turn, channel);
    await events["message.appended"](delta(message), channel);
    assert.equal(isTyping(), true, "typing resumes after sending a bubble while generation continues");
    await events["message.completed"](complete(message), channel);
    await events["turn.completed"](turn, channel);
    assert.equal(isTyping(), false, "the completed turn must not leave typing on");
    assert.deepEqual(sent, message.startsWith("one") ? ["one", "done"] : ["done"]);
  }
});

test("completion without a final send and cancellation still stop typing", async () => {
  for (const done of [complete(null), complete(""), complete("unfinished", 0, "length")]) {
    const { events, channel, sent, isTyping } = fixture();
    await events["turn.started"](turn, channel);
    await events["message.completed"](done, channel);
    await events["turn.completed"](turn, channel);
    assert.equal(isTyping(), false);
    assert.deepEqual(sent, []);
  }
  const { events, channel, sent, isTyping } = fixture();
  await events["turn.started"](turn, channel);
  await events["message.appended"](delta("unfinished"), channel);
  await events["turn.cancelled"](turn, channel);
  await events["message.appended"](delta("late text\n\n"), channel);
  assert.equal(isTyping(), false);
  assert.deepEqual(sent, []);
});

test("stale terminal events never stop a newer turn's typing", async () => {
  const { events, channel, sent, isTyping, typingStops } = fixture();
  await events["turn.started"](turn, channel);
  await events["turn.started"]({ turnId: "turn_1", sequence: 1 }, channel);
  for (const stale of [turn, { turnId: "wrong-turn", sequence: 1 }]) {
    await events["turn.completed"](stale, channel);
    await events["turn.cancelled"](stale, channel);
    await events["turn.failed"]({ ...stale, code: "MODEL_ERROR", message: "failed" }, channel);
  }
  assert.equal(isTyping(), true);
  assert.equal(typingStops(), 0);
  assert.deepEqual(sent, []);
});

test("failure cleanup runs even if sending the error notice fails", async () => {
  const failure = { code: "MODEL_ERROR", message: "failed" };
  for (const event of ["turn.failed", "session.failed"] as const) {
    const { events, channel, sent, isTyping } = fixture(async () => { throw new Error("send failed"); });
    await events["turn.started"](turn, channel);
    await assert.rejects(events[event]({ ...turn, ...failure, sessionId: "test-session" }, channel), /send failed/);
    assert.equal(isTyping(), false);
    await events["session.failed"]({ ...failure, sessionId: "test-session" }, channel);
    assert.equal(sent.length, 1, "failure cascades still send only one notice");
  }
});

test("a delayed old failure does not run typing cleanup for a replacement turn", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { events, channel, typingStops } = fixture(async () => { started.resolve(); await release.promise; });
  await events["turn.started"](turn, channel);
  const failing = events["turn.failed"]({ ...turn, code: "MODEL_ERROR", message: "failed" }, channel);
  await started.promise;
  await events["turn.started"]({ turnId: "turn_1", sequence: 1 }, channel);
  release.resolve();
  await failing;
  assert.equal(typingStops(), 0);
  assert.equal(channel.state.bubbleStream?.stopped, false);
});

test("typing cleanup errors do not fail a completed reply or expose provider details", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const { events, channel, sent } = fixture(undefined, async () => { throw new Error("private provider details"); });
  await events["turn.started"](turn, channel);
  await events["message.appended"](delta("done\n\n"), channel);
  await events["message.completed"](complete("done\n\n"), channel);
  await events["turn.completed"](turn, channel);
  assert.deepEqual(sent, ["done"]);
  assert.equal(channel.state.bubbleStream?.stopped, true);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [["[linq] typing cleanup failed"]]);
});

test("buffer state stays private to each session and survives serialization", async () => {
  const alice = fixture(), bob = fixture();
  await alice.events["message.appended"](delta("alice's "), alice.channel);
  await bob.events["message.appended"](delta("bob's message\n\n"), bob.channel);
  alice.channel.state = JSON.parse(JSON.stringify(alice.channel.state));
  await alice.events["message.appended"](delta("message\n\n"), alice.channel);
  await alice.events["message.completed"](complete("alice's message\n\n"), alice.channel);
  assert.deepEqual(alice.sent, ["alice's message"]);
  assert.deepEqual(bob.sent, ["bob's message"]);
});

test("optional typing support and absent threads do not break the stream", async () => {
  const delays: number[] = [];
  const events = createLinqDeliveryEvents(async () => {}, { sleep: async ms => { delays.push(ms); } });
  const { channel, sent } = fixture();
  channel.thread!.startTyping = async () => { throw Object.assign(new Error("unsupported"), { code: "NOT_IMPLEMENTED" }); };
  await events["turn.started"](turn, channel);
  await events["message.appended"](delta("one\n\n"), channel);
  assert.deepEqual(sent, ["one"]);
  await events["message.completed"](complete("two", 1), channel);
  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(delays.length, 1, "unsupported typing indicators still get a send delay");
  channel.thread = null;
  await events["message.completed"](complete("three", 2), channel);
  assert.deepEqual(sent, ["one", "two"]);
  await events["turn.completed"](turn, channel);
  assert.equal(delays.length, 1, "no thread means no delay or send");
});

test("Eve's real emitter delivers bubbles before generation ends and separates private reasoning", async () => {
  const firstBubble = Promise.withResolvers<void>();
  const { events, channel, sent } = fixture(async () => { firstBubble.resolve(); });
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

test("reaction-only completion suppresses Eve's empty-delivery marker at every chunk boundary", async () => {
  for (const marker of ["<eve-empty-delivery/>", "&lt;eve-empty-delivery/&gt;"]) {
    for (let cut = 0; cut <= marker.length; cut++) {
      const { events, channel, sent, isTyping } = fixture();
      await events["turn.started"](turn, channel);
      await events["message.appended"](delta(marker.slice(0, cut)), channel);
      await events["message.appended"](delta(marker.slice(cut) + "\n\n"), channel);
      await events["message.completed"](complete(null), channel);
      await events["turn.completed"](turn, channel);
      assert.deepEqual(sent, []);
      assert.equal(isTyping(), false);
    }
  }
});
