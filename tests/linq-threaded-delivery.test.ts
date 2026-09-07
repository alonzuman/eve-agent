import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginMessageActions, messageTurnDelivery, performMessageAction, stopMessageActions,
} from "../src/messaging/linq-message-actions.js";
import { createLinqDeliveryEvents } from "../src/messaging/linq-delivery.js";
import { bindMessageConversation, type AcceptedMessageAction, type MessageReference } from "../src/messaging/message-references.js";
import type { MessageStore } from "../src/messaging/message-store.js";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { buildCallbackContext } from "../node_modules/eve/dist/src/context/build-callback-context.js";

const turn = { turnId: "turn-1", sequence: 1 };
const target: MessageReference = {
  ref: "m1", messageId: "photo", partIndex: 1, sender: "user", content: "[media attachment]", partType: "media", replyTo: null,
};
const reply = (text: string) => ({ kind: "reply" as const, target: target.ref, text });
const complete = (message: string, stepIndex = 0) => ({ ...turn, stepIndex, message, finishReason: "stop" as const });

function fixture(options: { sleep?: (ms: number) => Promise<void>; failAt?: number; typingStatus?: number } = {}) {
  let runtime = new ContextContainer();
  const identity = { authenticator: "linq-private", issuer: "linq:test", principalType: "user", principalId: "a".repeat(64), attributes: {} };
  runtime.set(SessionKey, { sessionId: "session-a", auth: { current: identity, initiator: identity },
    turn: { id: turn.turnId, sequence: turn.sequence } });
  contextStorage.run(runtime, () => {
    bindMessageConversation(buildCallbackContext(), "linq:chat-a");
    beginMessageActions(turn);
  });
  const run = <T>(callback: () => T) => contextStorage.run(runtime, callback);
  const context = (signal = new AbortController().signal) => ({ ...buildCallbackContext(), abortSignal: signal });
  const saved: MessageReference[] = [];
  const claims = new Map<string, AcceptedMessageAction | null>();
  const store: MessageStore = {
    resolve: async () => target,
    recent: async () => saved,
    record: async (_scope, input) => {
      const result = input.map(message => ({ ...message, ref: `m${saved.length + 2}` }));
      saved.push(...result);
      return result;
    },
    claim: async (_scope, key) => {
      if (claims.has(key)) return { claimed: false, receipt: claims.get(key)! };
      claims.set(key, null);
      return { claimed: true };
    },
    accept: async (scope, key, target, sent) => {
      const ref = sent ? (await store.record(scope, [sent]))[0]!.ref : undefined;
      const receipt: AcceptedMessageAction = { status: "accepted", target, ...(sent ? { messageId: sent.messageId, ref } : {}) };
      claims.set(key, receipt);
      return receipt;
    },
    unconfirmed: async () => {},
  };
  const actions: string[] = [], ordinary: string[] = [], delays: number[] = [];
  const posted: { parts: { value: string }[]; reply_to: { message_id: string; part_index: number }; idempotency_key: string }[] = [];
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    assert.equal(req.headers.get("Authorization"), "Bearer test-key");
    assert.equal(req.redirect, "error");
    assert.ok(init?.signal);
    if (new URL(req.url).pathname.endsWith("/typing")) {
      assert.equal(req.method, "POST");
      actions.push("typing");
      return new Response(null, { status: options.typingStatus ?? 204 });
    }
    assert.equal(new URL(req.url).pathname, "/api/partner/v3/chats/chat-a/messages");
    const { message } = await req.json() as { message: typeof posted[number] };
    posted.push(message);
    actions.push(`reply:${message.parts[0]!.value}`);
    if (posted.length === options.failAt) throw new Error("private ambiguous provider diagnostic");
    return Response.json({ chat_id: "chat-a", message: { id: `reply-${posted.length}` } });
  };
  const timing = {
    random: () => 0.5,
    sleep: async (ms: number) => { delays.push(ms); actions.push(`wait:${ms}`); await options.sleep?.(ms); },
  };
  const transport = { apiKey: "test-key", store, request, ...timing };
  const events = createLinqDeliveryEvents(async () => { actions.push("stop typing"); }, { ...timing, turnDelivery: messageTurnDelivery });
  const channel: Parameters<typeof events["message.completed"]>[1] = {
    state: {}, thread: {
      id: "linq:chat-a", startTyping: async () => { actions.push("typing"); },
      post: async text => { ordinary.push(text); actions.push(`ordinary:${text}`); },
    },
  };
  return {
    run, context, transport, events, channel, posted, saved, ordinary, delays, actions,
    restore() {
      const restored = new ContextContainer();
      for (const [key, value] of runtime.entries()) restored.set(key, JSON.parse(JSON.stringify(value)));
      runtime = restored;
      channel.state = JSON.parse(JSON.stringify(channel.state));
    },
  };
}

test("threaded replies split and pace like ordinary text, preserving every parent and receipt", async () => {
  const f = fixture();
  const text = "  cart prepared\r\n\t\r\nflowers 🌸\nhttps://example.com/a_b?q=x%20y&n=1#part\n\nno order placed  ";
  const receipt = await f.run(() => performMessageAction(reply(text), f.context(), f.transport));
  const expected = ["cart prepared", "flowers 🌸\nhttps://example.com/a_b?q=x%20y&n=1#part", "no order placed"];
  assert.deepEqual(f.posted.map(message => message.parts[0]!.value), expected);
  assert.deepEqual(f.saved.map(message => message.content), expected);
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.status === "accepted" && receipt.ref, f.saved.at(-1)!.ref);
  for (const message of f.posted) assert.deepEqual(message.reply_to, { message_id: "photo", part_index: 1 });
  for (const message of f.saved) assert.deepEqual(message.replyTo, { messageId: "photo", partIndex: 1 });
  assert.equal(new Set(f.posted.map(message => message.idempotency_key)).size, 3);
  assert.equal(f.actions[0], "reply:cart prepared", "the first bubble has no artificial delay");
  assert.equal(f.delays.length, 2);
  const ordinary = fixture();
  await ordinary.run(() => ordinary.events["message.completed"](complete(text), ordinary.channel));
  assert.deepEqual(ordinary.ordinary, expected);
  assert.deepEqual(ordinary.delays, f.delays);
  assert.deepEqual(await f.run(() => performMessageAction(reply(text), f.context(), f.transport)), receipt);
  assert.equal(f.posted.length, 3, "a replay does not resend any bubble");
});

test("ordinary acknowledgments, threaded bubbles and new follow-ups share one pacing counter", async () => {
  const f = fixture();
  await f.run(async () => {
    await f.events["message.completed"](complete("checking", 0), f.channel);
    await performMessageAction(reply("0123456789\n\nlast"), f.context(), f.transport);
    await f.events["message.completed"](complete("new information", 1), f.channel);
  });
  assert.deepEqual(f.actions, [
    "ordinary:checking", "typing", "wait:500", "reply:0123456789", "typing", "wait:400", "reply:last",
    "typing", "wait:625", "ordinary:new information",
  ]);
});

test("threaded echoes are suppressed across streamed chunks, completion-only output and restoration", async () => {
  const f = fixture();
  const text = "cart prepared\n\nflowers\ndelivery tomorrow\n\nno order placed";
  await f.run(() => performMessageAction(reply(text), f.context(), f.transport));
  f.restore();
  await f.run(async () => {
    for (const messageDelta of text) {
      await f.events["message.appended"]({ ...turn, stepIndex: 1, messageDelta }, f.channel);
    }
    await f.events["message.completed"](complete(text, 1), f.channel);
    await f.events["message.completed"](complete(text.replaceAll("\n", " "), 2), f.channel);
    await f.events["message.completed"](complete("flowers\r\ndelivery tomorrow\r\n\r\nnew information", 3), f.channel);
  });
  assert.deepEqual(f.ordinary, ["new information"]);
  assert.equal(f.delays.length, 3, "echoes cause no send delay");
  assert.equal(f.posted.length, 3);
});

test("echo suppression stays in its session and turn and preserves bubbles with new content", async () => {
  const f = fixture(), other = fixture();
  await f.run(() => performMessageAction(reply("done"), f.context(), f.transport));
  await other.run(() => other.events["message.completed"](complete("done"), other.channel));
  await f.run(async () => {
    await f.events["message.completed"](complete("done, and here is something new"), f.channel);
    const next = { turnId: "turn-2", sequence: 2 };
    beginMessageActions(next);
    await f.events["turn.started"](next, f.channel);
    await f.events["message.completed"]({ ...complete("done"), ...next }, f.channel);
  });
  assert.deepEqual(f.ordinary, ["done, and here is something new", "done"]);
  assert.deepEqual(other.ordinary, ["done"]);
  assert.equal(f.delays.length, 1, "the new turn's first bubble is immediate");
});

test("partial failures retain accepted references and never replay or substitute the batch", async () => {
  const f = fixture({ failAt: 2 });
  const text = "first\n\nambiguous\n\nunsent";
  const result = await f.run(() => performMessageAction(reply(text), f.context(), f.transport));
  assert.equal(result.status, "unconfirmed");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(f.posted.length, 2);
  assert.deepEqual(f.saved.map(message => message.content), ["first"]);
  f.restore();
  assert.deepEqual(await f.run(() => performMessageAction(reply(text), f.context(), f.transport)), result);
  await f.run(() => f.events["message.completed"](complete(text, 1), f.channel));
  assert.equal(f.posted.length, 2);
  assert.deepEqual(f.ordinary, []);
});

test("cancellation and replacement during a typing pause discard unsent threaded bubbles", async () => {
  for (const interruption of ["abort", "cancel", "replace"] as const) {
    const waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = fixture({ sleep: async () => { waiting.resolve(); await release.promise; } });
    const controller = new AbortController();
    const sending = f.run(() => performMessageAction(reply("first\n\nunsent\n\nlast"), f.context(controller.signal), f.transport));
    await waiting.promise;
    f.run(() => {
      if (interruption === "abort") controller.abort();
      else if (interruption === "cancel") stopMessageActions(turn);
      else beginMessageActions({ turnId: "turn-2", sequence: 2 });
    });
    release.resolve();
    assert.equal((await sending).status, "unconfirmed");
    assert.deepEqual(f.posted.map(message => message.parts[0]!.value), ["first"], interruption);
  }
});

test("receipt storage failure stops the batch and equal bubbles have distinct idempotency keys", async () => {
  const f = fixture();
  f.transport.store.record = async () => { throw new Error("database unavailable"); };
  const text = "first\n\nsecond";
  assert.equal((await f.run(() => performMessageAction(reply(text), f.context(), f.transport))).status, "unconfirmed");
  await f.run(() => performMessageAction(reply(text), f.context(), f.transport));
  assert.equal(f.posted.length, 1);
  const repeated = fixture({ typingStatus: 403 });
  await repeated.run(() => performMessageAction(reply("again\n\nagain"), repeated.context(), repeated.transport));
  assert.equal(repeated.posted.length, 2);
  assert.notEqual(repeated.posted[0]!.idempotency_key, repeated.posted[1]!.idempotency_key);
  assert.deepEqual(repeated.delays, [400], "unavailable typing still gets a send delay");
});
