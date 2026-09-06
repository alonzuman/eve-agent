import assert from "node:assert/strict";
import { test } from "node:test";
import channel from "../agent/channels/linq.js";
import { messageStore } from "../src/messaging/message-store.js";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { callAdapterEventHandler } from "../node_modules/eve/dist/src/channel/adapter.js";
import type { ChannelAdapter } from "../node_modules/eve/dist/src/channel/adapter.js";
import type { UnstampedMessageStreamEvent } from "../node_modules/eve/dist/src/protocol/message.js";

const { adapter } = channel as unknown as { adapter: ChannelAdapter };
const alice = { authenticator: "linq-private", issuer: "linq:test", principalType: "user", principalId: "a".repeat(64), attributes: {} };
const bob = { ...alice, principalId: "b".repeat(64) };
const turn = { turnId: "turn-1", sequence: 1 };
const coordinates = { ...turn, stepIndex: 0 };
const completed = (message: string): UnstampedMessageStreamEvent => ({
  type: "message.completed", data: { ...coordinates, message, finishReason: "stop" },
});

function session(id: string, identity: typeof alice, chatId: string) {
  const context = new ContextContainer();
  context.set(SessionKey, { sessionId: id, auth: { current: identity, initiator: identity },
    turn: { id: turn.turnId, sequence: turn.sequence } });
  const destination = adapter.createAdapterContext!({ ctx: context, session: {} as never, state: { thread: {
    _type: "chat:Thread", adapterName: "linq", channelId: `linq:${chatId}`, id: `linq:${chatId}`, isDM: true,
  } } });
  return { context, destination };
}

function restore(source: ReturnType<typeof session>) {
  const context = new ContextContainer();
  for (const [key, value] of source.context.entries()) context.set(key, structuredClone(value));
  return { context, destination: adapter.createAdapterContext!({ ctx: context, session: {} as never,
    state: structuredClone(source.destination.state) }) };
}

function emit(target: ReturnType<typeof session>, event: UnstampedMessageStreamEvent) {
  // Use Eve's real error-swallowing dispatch, not direct calls that abort a test
  // as soon as turn.started rejects a foreign identity or chat.
  return contextStorage.run(target.context, () => callAdapterEventHandler(adapter, event, target.destination));
}

test("registered Linq replies remain isolated across overlapping users and restored steps", async t => {
  for (const [name, value] of Object.entries({ LINQ_API_KEY: "test-key", LINQ_WEBHOOK_SECRET: "test-secret" })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const sent: { chat: string; text: string }[] = [];
  t.mock.method(messageStore, "record", async (...[_scope, input]: Parameters<typeof messageStore.record>) =>
    input.map(message => ({ ...message, ref: "m1" })));
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    assert.equal(new URL(request.url).hostname, "api.linqapp.com");
    if (path.endsWith("/typing")) return new Response(null, { status: 204 });
    const chat = /^\/api\/partner\/v3\/chats\/([^/]+)\/messages$/.exec(path)?.[1];
    assert.ok(chat, "replies must use the current chat endpoint");
    const body = await request.json() as { message: { parts: { value: string }[] } };
    sent.push({ chat, text: body.message.parts[0].value });
    return Response.json({ message: { id: `reply-${sent.length}` }, chat_id: chat });
  });
  t.mock.method(console, "error", () => {});
  const a = session("session-a", alice, "chat-a"), b = session("session-b", bob, "chat-b");
  await Promise.all([a, b].map(target => emit(target, { type: "turn.started", data: turn })));
  await emit(a, { type: "message.appended", data: { ...coordinates, messageDelta: "Alice's " } });
  await emit(b, completed("Bob's reply"));
  const restored = restore(a);
  await emit(restored, { type: "message.appended", data: { ...coordinates, messageDelta: "reply" } });
  await emit(restored, completed("Alice's reply"));
  assert.deepEqual(sent, [{ chat: "chat-b", text: "Bob's reply" }, { chat: "chat-a", text: "Alice's reply" }]);

  await t.test("a rejected chat binding cannot send through later text or failure callbacks", async () => {
    const foreign = restore(a);
    const wrongChat = session("unused", alice, "chat-b");
    foreign.destination = wrongChat.destination;
    await emit(foreign, { type: "turn.started", data: turn });
    const before = sent.length;
    await emit(foreign, completed("Alice's private reply"));
    await emit(foreign, { type: "turn.failed", data: { ...turn, code: "FAILED", message: "failed" } });
    await emit(foreign, { type: "session.failed", data: { sessionId: "session-a", code: "FAILED", message: "failed" } });
    assert.equal(sent.length, before, "Eve swallowing a failed binding must never permit a reply to the other user");
  });

  await t.test("changed auth, missing bindings and foreign session failures produce no replies", async () => {
    const changed = restore(a);
    changed.context.set(SessionKey, { sessionId: "session-a", auth: { current: bob, initiator: alice },
      turn: { id: turn.turnId, sequence: turn.sequence } });
    const before = sent.length;
    await emit(changed, completed("private"));
    await emit(session("unbound", alice, "chat-a"), completed("unbound"));
    await emit(restore(b), { type: "session.failed", data: { sessionId: "session-a", code: "FAILED", message: "failed" } });
    assert.equal(sent.length, before);
  });

  await t.test("foreign turn events are rejected while a genuine failure still reaches its own chat", async () => {
    const before = sent.length;
    await emit(restore(a), { type: "message.completed", data: {
      ...coordinates, turnId: "another-turn", sequence: 2, message: "foreign", finishReason: "stop",
    } });
    await emit(restore(a), { type: "turn.started", data: { turnId: "stale-turn", sequence: 0 } });
    assert.equal(sent.length, before);
    const failed = restore(b);
    await emit(failed, { type: "session.failed", data: { sessionId: "session-b", code: "FAILED", message: "failed" } });
    assert.deepEqual(sent.slice(before), [{ chat: "chat-b", text: "hit an error before i could finish. try that again?" }]);
  });
});
