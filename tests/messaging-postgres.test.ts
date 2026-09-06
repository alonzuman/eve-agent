import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../src/database/schema.js";
import { createMessageStore, messageStore } from "../src/messaging/message-store.js";
import { bindMessageConversation, messageNamespace, type MessageInput, type MessageScope } from "../src/messaging/message-references.js";
import { beginMessageActions, performMessageAction, stopMessageActions } from "../src/messaging/linq-message-actions.js";
import react from "../agent/tools/react_to_message.js";
import reply from "../agent/tools/reply_to_message.js";
import referenceInstructions from "../agent/instructions/message-references.js";
// Test-only runtime access: actual state handles and serialization across steps.
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { buildCallbackContext } from "../node_modules/eve/dist/src/context/build-callback-context.js";

const connectionString = process.env.TEST_DATABASE_URL;
test("Postgres message storage, action delivery and recovery", { skip: !connectionString }, async t => {
  const pool = new Pool({ connectionString, max: 8 });
  const db = drizzle(pool, { schema });
  const principal = randomBytes(32).toString("hex"), other = randomBytes(32).toString("hex"), reset = randomBytes(32).toString("hex");
  t.after(async () => {
    await db.delete(schema.messageActions).where(inArray(schema.messageActions.principalId, [principal, other, reset]));
    await db.delete(schema.messages).where(inArray(schema.messages.principalId, [principal, other, reset]));
    await pool.end();
  });
  await migrate(db, { migrationsFolder: "drizzle" });
  await migrate(db, { migrationsFolder: "drizzle" });
  const store = createMessageStore(() => db);
  const scope: MessageScope = { namespace: messageNamespace(), principalId: principal, chatId: "chat-a" };
  const input = (messageId: string, content = "hello"): MessageInput => ({
    messageId, content, partIndex: 0, sender: "user", partType: "text", replyTo: null,
  });
  const identity = (principalId = principal) => ({ authenticator: "linq-private", issuer: "linq:test", principalType: "user", principalId, attributes: {} });
  const coordinates = { turnId: "turn-1", sequence: 1 };
  const runtime = (sessionId = "session-a", principalId = principal) => {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, { sessionId, auth: { current: identity(principalId), initiator: identity(principalId) },
      turn: { id: coordinates.turnId, sequence: coordinates.sequence } });
    contextStorage.run(ctx, () => {
      bindMessageConversation(buildCallbackContext(), "linq:chat-a");
      beginMessageActions(coordinates);
    });
    return ctx;
  };
  const toolContext = (abortSignal = new AbortController().signal) => ({
    ...buildCallbackContext(), abortSignal, callId: "call-1", toolName: "test",
    async getToken(): Promise<never> { throw new Error("Unexpected token lookup"); },
    requireAuth(): never { throw new Error("Unexpected authorization request"); },
  });

  await t.test("concurrent duplicate inserts retain one reference and original content", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => store.record(scope, [input("same-message")])));
    assert.equal(new Set(results.map(result => result[0]!.ref)).size, 1);
    const changed = await store.record(scope, [input("same-message", "changed")]);
    assert.equal(changed[0]!.content, "hello");
  });

  const parts = await store.record(scope, [input("multipart"), { ...input("multipart", "[media attachment]"), partType: "media", partIndex: 1 }]);
  const target = parts[1]!.ref;
  await t.test("targets isolate chats, senders, reset generations and environments", async () => {
    for (const foreign of [
      { ...scope, chatId: "chat-b" }, { ...scope, principalId: other }, { ...scope, principalId: reset },
      { ...scope, namespace: "f".repeat(64) },
    ]) {
      assert.equal(await store.resolve(foreign, target), null);
      const saved = await store.record(foreign, [input("multipart")]);
      assert.notEqual(saved[0]!.ref, parts[0]!.ref);
    }
    assert.notEqual(parts[0]!.ref, target);
  });

  await t.test("recent references include the parent of a reply even outside the recent window", async () => {
    const parent = (await store.record(scope, [input("old-parent", "old question")]))[0]!;
    await store.record(scope, Array.from({ length: 45 }, (_, i) => input(`filler-${i}`)));
    await store.record(scope, [{ ...input("thread-reply", "yes"), replyTo: { messageId: parent.messageId, partIndex: 0 } }]);
    const recent = await store.recent(scope);
    assert.equal(recent.length, 41);
    assert.ok(recent.some(message => message.ref === parent.ref));
    t.mock.method(messageStore, "recent", store.recent);
    const result = await referenceInstructions.events["turn.started"]!({}, {
      session: { id: "session-a", auth: { current: identity(), initiator: identity() } },
      channel: { metadata: { adapterName: "linq", threadId: "linq:chat-a" } }, messages: [],
    });
    assert.ok(JSON.stringify(result).includes(parent.ref));
    assert.ok(JSON.stringify(result).includes("old question"));
  });

  await t.test("claims are atomic and survive new store instances", async () => {
    const key = "1".repeat(64);
    const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim(scope, key, target, "reaction", { emoji: "❤️" })));
    assert.equal(claims.filter(claim => claim.claimed).length, 1);
    await store.accept(scope, key, target);
    const restored = createMessageStore(() => db);
    assert.deepEqual(await restored.claim(scope, key, target, "reaction", { emoji: "❤️" }), {
      claimed: false, receipt: { status: "accepted", target },
    });
  });

  const ctx = runtime();
  await t.test("actual tools target the correct part and await provider acceptance without duplicate sends", async () => {
    for (const method of ["resolve", "claim", "accept", "unconfirmed"] as const) t.mock.method(messageStore, method, store[method]);
    const oldKey = process.env.LINQ_API_KEY;
    process.env.LINQ_API_KEY = "test-key";
    t.after(() => { if (oldKey === undefined) delete process.env.LINQ_API_KEY; else process.env.LINQ_API_KEY = oldKey; });
    const calls: { path: string; body: unknown }[] = [];
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      assert.equal(request.headers.get("Authorization"), "Bearer test-key");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      const body = await request.json();
      const path = new URL(request.url).pathname;
      calls.push({ path, body });
      return path.endsWith("/reactions") ? new Response(null, { status: 204 })
        : Response.json({ chat_id: "chat-a", message: { id: "threaded-outgoing" } });
    });
    await contextStorage.run(ctx, async () => {
      const reaction = await react.execute!({ target, emoji: "🎉" }, toolContext());
      assert.deepEqual(reaction, { status: "accepted", target });
      assert.deepEqual(await react.execute!({ target, emoji: "🎉" }, toolContext()), reaction);
      const sent = await reply.execute!({ target, text: "that dog is incredible" }, toolContext()) as { status: string; ref: string };
      assert.equal(sent.status, "accepted");
      assert.equal((await store.resolve(scope, sent.ref))!.replyTo?.partIndex, 1);
      assert.equal((await store.resolve(scope, sent.ref))!.content, "that dog is incredible");
      await reply.execute!({ target, text: "that dog is incredible" }, toolContext());
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.path, "/api/partner/v3/messages/multipart/reactions");
    assert.deepEqual(calls[0]!.body, { operation: "add", part_index: 1, type: "custom", custom_emoji: "🎉" });
    assert.partialDeepStrictEqual(calls[1]!.body, { message: {
      reply_to: { message_id: "multipart", part_index: 1 }, preferred_service: "iMessage",
      parts: [{ type: "text", value: "that dog is incredible" }],
    } });
    assert.match((calls[1]!.body as { message: { idempotency_key: string } }).message.idempotency_key, /^[a-f0-9]{64}$/);
  });

  await t.test("ambiguous sends stay unconfirmed across retries and session-state restoration", async () => {
    let calls = 0;
    const request: typeof fetch = async () => { calls++; throw new Error("secret provider diagnostic"); };
    const options = { store, request, apiKey: "test-key" };
    const action = { kind: "reply" as const, target, text: "ambiguous reply" };
    const result = await contextStorage.run(ctx, () => performMessageAction(action, toolContext(), options));
    assert.equal(result.status, "unconfirmed");
    assert.ok(!JSON.stringify(result).includes("secret"));
    const restored = new ContextContainer();
    for (const [key, value] of ctx.entries()) restored.set(key, JSON.parse(JSON.stringify(value)));
    assert.deepEqual(await contextStorage.run(restored, () => performMessageAction(action, toolContext(), options)), result);
    assert.equal(calls, 1);
  });

  await t.test("receipt-write failure cannot trigger a second provider call", async () => {
    let calls = 0;
    const broken = { ...store, accept: async (): Promise<never> => { throw new Error("DB unavailable after send"); } };
    const request: typeof fetch = async () => { calls++; return new Response(null, { status: 204 }); };
    const action = { kind: "reaction" as const, target, emoji: "👍" };
    const first = await contextStorage.run(ctx, () => performMessageAction(action, toolContext(), { store: broken, request, apiKey: "test-key" }));
    assert.equal(first.status, "unconfirmed");
    await contextStorage.run(ctx, () => performMessageAction(action, toolContext(), { store, request, apiKey: "test-key" }));
    assert.equal(calls, 1);
  });

  await t.test("foreign references, pre-send storage failure and cancelled turns never reach Linq", async () => {
    const request: typeof fetch = async () => assert.fail("must not send");
    const action = { kind: "reaction" as const, target, emoji: "🤔" };
    await assert.rejects(contextStorage.run(runtime("other-session", other), () => performMessageAction(action, toolContext(), { store, request, apiKey: "test-key" })), /Unknown message reference/);
    await assert.rejects(contextStorage.run(ctx, () => performMessageAction(action, toolContext(), {
      store: { ...store, claim: async () => { throw new Error("DB unavailable"); } }, request, apiKey: "test-key",
    })), /DB unavailable/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(contextStorage.run(ctx, () => performMessageAction(action, toolContext(aborted.signal), { store, request, apiKey: "test-key" })));
    contextStorage.run(ctx, () => stopMessageActions(coordinates));
    await assert.rejects(contextStorage.run(ctx, () => performMessageAction(action, toolContext(), { store, request, apiKey: "test-key" })), /inactive turn/);
  });

  await t.test("accepting a reply and recording its message is one transaction", async () => {
    await assert.rejects(store.accept(scope, "f".repeat(64), target, input("should-roll-back")));
    const saved = await db.select().from(schema.messages).where(eq(schema.messages.messageId, "should-roll-back"));
    assert.equal(saved.length, 0);
  });
});
