import assert from "node:assert/strict";
import { test } from "node:test";
import channel from "../agent/channels/linq.js";
import { stopLinqTyping } from "../src/messaging/linq-typing.js";
// Test the registered channel with its real pinned Linq adapter and fake HTTP.
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";

test("the registered Linq channel awaits DELETE typing after the final streamed bubble", async t => {
  const previousKey = process.env.LINQ_API_KEY;
  const previousSecret = process.env.LINQ_WEBHOOK_SECRET;
  process.env.LINQ_API_KEY = "test-api-key";
  process.env.LINQ_WEBHOOK_SECRET = "test-signing-secret";
  t.after(() => {
    if (previousKey === undefined) delete process.env.LINQ_API_KEY;
    else process.env.LINQ_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.LINQ_WEBHOOK_SECRET;
    else process.env.LINQ_WEBHOOK_SECRET = previousSecret;
  });
  const calls: string[] = [];
  let isTyping = false;
  const cleanupStarted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("Authorization"), "Bearer test-api-key");
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path === "/api/partner/v3/chats/chat-a/typing") {
      if (request.method === "DELETE") {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        isTyping = false;
      } else {
        assert.equal(request.method, "POST");
        isTyping = true;
      }
      return new Response(null, { status: 204 });
    }
    assert.equal(path, "/api/partner/v3/chats/chat-a/messages");
    assert.equal(request.method, "POST");
    const body = await request.json() as { message: { parts: unknown[] } };
    assert.deepEqual(body.message.parts, [{ type: "text", value: "done" }]);
    isTyping = false;
    return Response.json({ message: { id: "message-1" }, chat_id: "chat-a" });
  });
  const { adapter } = channel as unknown as { adapter: {
    createAdapterContext(input: unknown): { thread: unknown };
    "turn.started"(data: unknown, context: unknown): Promise<void>;
    "message.appended"(data: unknown, context: unknown): Promise<void>;
    "message.completed"(data: unknown, context: unknown): Promise<void>;
    "turn.completed"(data: unknown, context: unknown): Promise<void>;
  } };
  const channelContext = adapter.createAdapterContext({ state: { thread: {
    _type: "chat:Thread", adapterName: "linq", channelId: "linq:chat-a", id: "linq:chat-a", isDM: true,
  } } });
  assert.ok(channelContext.thread, "use Eve's restored thread, not a thread stub");
  const context = new ContextContainer();
  context.set(SessionKey, { sessionId: "session-a", auth: { current: null, initiator: null }, turn: { id: "turn-1", sequence: 1 } });
  const coordinates = { turnId: "turn-1", sequence: 1, stepIndex: 0 };
  await contextStorage.run(context, async () => {
    await adapter["turn.started"](coordinates, channelContext);
    await adapter["message.appended"]({ ...coordinates, messageDelta: "done\n\n" }, channelContext);
    await adapter["message.completed"]({ ...coordinates, message: "done\n\n", finishReason: "stop" }, channelContext);
    assert.equal(isTyping, true, "the final delimited bubble restarted typing");
    let completed = false;
    const completion = adapter["turn.completed"](coordinates, channelContext).then(() => { completed = true; });
    await cleanupStarted.promise;
    assert.equal(completed, false, "cleanup must finish before the terminal callback resolves");
    releaseCleanup.resolve();
    await completion;
    assert.equal(isTyping, false);
  });
  assert.deepEqual(calls, [
    "POST /api/partner/v3/chats/chat-a/typing",
    "POST /api/partner/v3/chats/chat-a/messages",
    "POST /api/partner/v3/chats/chat-a/typing",
    "DELETE /api/partner/v3/chats/chat-a/typing",
  ]);
});

test("typing cleanup uses private chat IDs, bounded requests, and no redirect or retry", async () => {
  for (const threadId of ["linq:chat-a", "linq:chat-a:dm", "linq:chat/a?b:dm"]) {
    const expectedChat = threadId.includes("?") ? "chat%2Fa%3Fb" : "chat-a";
    await stopLinqTyping(threadId, { apiKey: "test-key", request: async (input, init) => {
      assert.equal(input, `https://api.linqapp.com/api/partner/v3/chats/${expectedChat}/typing`);
      assert.equal(init?.method, "DELETE");
      assert.deepEqual(init.headers, { Authorization: "Bearer test-key" });
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.body, undefined);
      return new Response(null, { status: 204 });
    } });
  }
  let requests = 0;
  for (const status of [403, 500]) {
    await assert.rejects(stopLinqTyping("linq:chat-a", { apiKey: "test-key", request: async () => {
      requests++;
      return new Response("private provider diagnostic", { status });
    } }), new RegExp(`Linq typing cleanup failed \\(${status}\\)`));
  }
  assert.equal(requests, 2, "do not retry a stop after a new turn could have started");
  for (const threadId of ["slack:chat-a", "linq:pending:+15555550123", "linq:pending", "linq:chat-a:group", "linq:"]) {
    await assert.rejects(stopLinqTyping(threadId, { apiKey: "test-key", request: async () => {
      assert.fail("invalid threads must not make a request");
    } }), /Invalid private Linq thread/);
  }
});

test("typing cleanup times out independently of the cancelled turn", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 5_000);
    return controller.signal;
  });
  const stopped = stopLinqTyping("linq:chat-a", { apiKey: "test-key", request: async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  } });
  controller.abort(new Error("cleanup timed out"));
  await assert.rejects(stopped, /cleanup timed out/);
});
