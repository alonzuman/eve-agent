import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import channel from "../agent/channels/linq.js";
import { assessLinqResponseAccess } from "../src/identity/linq-allowlist.js";
import { admitLinqMessage } from "../src/identity/linq-admission.js";
import { privateLinqIdentity } from "../src/identity/linq-policy.js";

const line = "+12025550100", alice = "+12025550101", bob = "+12025550102";

function message(sender = alice, id = "message-1") {
  return {
    id, threadId: "linq:chat-a",
    author: { userId: "handle-1", userName: sender, isBot: false, isMe: false },
    raw: {
      id, direction: "inbound", parts: [{ type: "text", value: "Hello" }],
      chat: { id: "chat-a", is_group: false, owner_handle: { handle: line, is_me: true } },
      sender_handle: { id: "handle-1", handle: sender, is_me: false },
    },
  };
}

test("the environment allowlist matches exact numbers locally", (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Allowlist checks must not make network requests");
  });
  const allowedNumbers = "  " + [alice, bob, alice].join(", \n") + "  ";
  for (const sender of [alice, bob]) {
    assert.deepEqual(assessLinqResponseAccess(sender, allowedNumbers), { accepted: true });
  }
  for (const sender of [line, "alice@example.com", "12025550101", alice + " ", alice + "\n", alice + "0"]) {
    assert.deepEqual(assessLinqResponseAccess(sender, allowedNumbers), {
      accepted: false, reason: "sender_not_allowlisted",
    });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("empty or malformed configuration blocks every sender", () => {
  for (const value of ["", " \n\t "]) {
    assert.deepEqual(assessLinqResponseAccess(alice, value), {
      accepted: false, reason: "responses_disabled",
    });
  }
  for (const invalid of ["*", "alice@example.com", alice.slice(1), "+01234567", "+123456", "+1234567890123456",
    "+1 (202) 555-0102", bob + "\n" + line, "", "true", "[" + bob + "]"]) {
    // An invalid entry must not allow other, valid entries through.
    assert.deepEqual(assessLinqResponseAccess(alice, alice + "," + invalid), {
      accepted: false, reason: "response_allowlist_invalid",
    });
  }
});

test("rejected senders never reach owner storage, even if it is unavailable", async (t) => {
  const bindChat = t.mock.fn(async () => { throw new Error("Storage unavailable"); });
  t.mock.method(console, "info", () => {});
  for (const allowedNumbers of [alice, "", bob + ",*"]) {
    assert.equal(await admitLinqMessage(message(bob), true, line, { allowedNumbers, bindChat }), null);
  }
  assert.equal(bindChat.mock.callCount(), 0);
});

test("allowlisted senders must still pass identity and conversation ownership checks", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  const bindChat = t.mock.fn(async () => true);
  const deps = { allowedNumbers: alice, bindChat };
  const group = message(); group.raw.chat.is_group = true;
  const contradiction = message(bob); contradiction.author.userName = alice;
  for (const incoming of [group, contradiction]) {
    assert.equal(await admitLinqMessage(incoming, true, line, deps), null);
  }
  assert.equal(await admitLinqMessage(message(), true, bob, deps), null);
  assert.equal(bindChat.mock.callCount(), 0);

  const identity = privateLinqIdentity(message(), true, line)!;
  assert.deepEqual(await admitLinqMessage(message(), true, line, deps), { auth: identity.auth });
  assert.deepEqual(bindChat.mock.calls[0].arguments, [identity.chatKey, identity.auth.principalId]);
  assert.ok(!JSON.stringify(identity.auth).includes(alice));
  assert.equal(await admitLinqMessage(message(), true, line, {
    allowedNumbers: alice, bindChat: async () => false,
  }), null);
});

test("application route ignores blocked webhooks and dispatches only allowlisted senders", async (t) => {
  const key = Buffer.from("test-signature-secret-32-bytes-123");
  const env = {
    LINQ_API_KEY: "test-api-key",
    LINQ_WEBHOOK_SECRET: `whsec_${key.toString("base64")}`,
    LINQ_PHONE_NUMBER: line,
    LINQ_ALLOWED_NUMBERS: alice,
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_testsecret",
    // Keep Blob's optional OIDC lookup from refreshing the developer's real
    // Vercel credentials. With no store ID it uses the test read-write token.
    VERCEL_OIDC_TOKEN: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.test`,
    BLOB_STORE_ID: "",
  };
  for (const [name, value] of Object.entries(env)) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
  let allowSideEffects = false;
  const identity = privateLinqIdentity(message(bob), true, line)!;
  const outbound: string[] = [];
  // Blob uses undici directly. Intercept it too, and disallow all real network I/O.
  const dispatcher = getGlobalDispatcher();
  const network = new MockAgent();
  network.disableNetConnect();
  setGlobalDispatcher(network);
  t.after(async () => { setGlobalDispatcher(dispatcher); await network.close(); });
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (allowSideEffects && url.hostname === "api.linqapp.com") {
      assert.equal(url.pathname, "/api/partner/v3/chats/chat-a/read");
      assert.equal(init?.method, "POST");
      outbound.push("mark-read");
      return new Response(null, { status: 204 });
    }
    outbound.push(url.href);
    throw new Error("Blocked webhooks must not call Linq or storage");
  });
  const logs = t.mock.method(console, "info", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const route = channel.routes.find((route) => route.method === "POST")!;
  if (route.transport === "websocket") throw new Error("Expected HTTP");
  const httpRoute = route;
  const deliver = t.mock.fn(async (_content: unknown, _options: unknown) => {});
  // Capture eve's delivery operation at the session boundary without running a model.
  const from = t.mock.fn((_id: string) => new Proxy(
    {} as ReturnType<Parameters<typeof httpRoute.handler>[1]["from"]>,
    { get(_target, key) { assert.equal(typeof key, "symbol"); return deliver; } },
  ));
  const neverDispatch = t.mock.fn(() => { throw new Error("Must not dispatch model work"); });
  const pending: Promise<unknown>[] = [];
  const args = {
    from, to: neverDispatch, resolveSession: neverDispatch, attachSession: neverDispatch,
    params: {}, requestIp: null, waitUntil: (task: Promise<unknown>) => { pending.push(task); },
  };
  let eventCount = 0;
  async function send(eventType = "message.received", signed = true) {
    const id = `blocked-event-${eventCount++}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const data = eventType === "message.received" ? message(bob, id).raw : {
      chat_id: "chat-a", message_id: id, reaction_type: "like", is_from_me: false,
      from_handle: { id: "handle-1", handle: bob, is_me: false },
    };
    const body = JSON.stringify({ event_type: eventType, data });
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    const headers = signed ? {
      "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`,
    } : undefined;
    const response = await route.handler(new Request("https://example.com/eve/v1/linq", {
      method: "POST", body, headers,
    }), args);
    await Promise.all(pending.splice(0));
    assert.ok(response instanceof Response);
    assert.equal(response.status, signed ? 200 : 401);
  }
  await send("message.received", false);
  for (const value of [alice, "", bob + ",*", "   "]) {
    process.env.LINQ_ALLOWED_NUMBERS = value;
    await send();
  }
  delete process.env.LINQ_ALLOWED_NUMBERS;
  await send();
  await send("reaction.added");
  await send("reaction.removed");
  assert.deepEqual(logs.mock.calls.filter((call) => call.arguments[0] === "[linq] inbound rejected")
    .map((call) => call.arguments[1]), [
    { reason: "sender_not_allowlisted" }, { reason: "responses_disabled" },
    { reason: "response_allowlist_invalid" }, { reason: "responses_disabled" },
    { reason: "responses_disabled" },
  ]);
  assert.equal(outbound.length, 0);
  assert.equal(from.mock.callCount(), 0);
  assert.equal(neverDispatch.mock.callCount(), 0);
  assert.equal(errors.mock.calls.filter((call) => call.arguments[0] === "[chat-sdk] Message processing error").length, 0);

  // Enable this sender, then revoke them in the same chat and running process.
  process.env.LINQ_ALLOWED_NUMBERS = bob;
  allowSideEffects = true;
  network.get("https://teststore.private.blob.vercel-storage.com")
    .intercept({ path: `/app-private/linq/chat-owners/${identity.chatKey}.json?cache=0`, method: "GET" })
    .reply(() => {
      outbound.push("owner-read");
      return { statusCode: 200, data: JSON.stringify({ userScope: identity.auth.principalId }) };
    });
  await send();
  assert.equal(errors.mock.calls.filter((call) => call.arguments[0] === "[chat-sdk] Message processing error").length, 0);
  assert.deepEqual(outbound, ["owner-read", "mark-read"]);
  assert.equal(from.mock.callCount(), 1);
  assert.equal(deliver.mock.callCount(), 1);
  assert.partialDeepStrictEqual(deliver.mock.calls[0].arguments[1], { auth: identity.auth });
  process.env.LINQ_ALLOWED_NUMBERS = alice;
  allowSideEffects = false;
  await send();
  assert.deepEqual(outbound, ["owner-read", "mark-read"]);
  assert.equal(from.mock.callCount(), 1);
  assert.equal(errors.mock.calls.filter((call) => call.arguments[0] === "[chat-sdk] Message processing error").length, 0);
  network.assertNoPendingInterceptors();
});
