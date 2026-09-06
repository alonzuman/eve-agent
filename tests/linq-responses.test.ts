import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import channel from "../agent/channels/linq.js";
import { assessLinqResponseAccess, readLinqResponsePolicy } from "../src/flags/linq-responses.js";
import { admitLinqMessage } from "../src/identity/linq-admission.js";
import { privateLinqIdentity } from "../src/identity/linq-policy.js";

const line = "+12025550100", alice = "+12025550101", bob = "+12025550102";
const enabledPolicy = { enabled: true, allowedNumbers: [alice] };

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

test("response flag requires an exact allowlisted phone number", async () => {
  const read = async () => ({ enabled: true, allowedNumbers: [alice, bob, alice] });
  for (const sender of [alice, bob]) {
    assert.deepEqual(await assessLinqResponseAccess(sender, read), { accepted: true });
  }
  for (const sender of [line, "alice@example.com", "12025550101", alice + " ", alice + "0"]) {
    assert.deepEqual(await assessLinqResponseAccess(sender, read), {
      accepted: false, reason: "sender_not_allowlisted",
    });
  }
});

test("disabled, empty, missing and malformed policies never enable responses", async () => {
  const invalidPolicies: unknown[] = [
    undefined, null, true, [], {}, JSON.stringify(enabledPolicy),
    { allowedNumbers: [alice] }, { enabled: true },
    { enabled: "true", allowedNumbers: [alice] },
    { enabled: true, allowedNumbers: alice },
    ...["*", "alice@example.com", "12025550101", "+1 (202) 555-0101", alice + "\n", "", 12025550101]
      .map((entry) => ({ enabled: true, allowedNumbers: [alice, entry] })),
  ];
  for (const value of invalidPolicies) {
    assert.deepEqual(await assessLinqResponseAccess(alice, async () => value), {
      accepted: false, reason: "response_policy_invalid",
    });
  }
  assert.deepEqual(await assessLinqResponseAccess(alice, async () => ({ ...enabledPolicy, enabled: false })), {
    accepted: false, reason: "responses_disabled",
  });
  assert.deepEqual(await assessLinqResponseAccess(alice, async () => ({ enabled: true, allowedNumbers: [] })), {
    accepted: false, reason: "sender_not_allowlisted",
  });
});

test("provider failures are denied without returning sensitive errors", async () => {
  assert.deepEqual(await assessLinqResponseAccess(alice, async () => {
    throw new Error("Provider failed with secret token and private phone number");
  }), { accepted: false, reason: "response_policy_unavailable" });
});

test("rejected senders never reach owner storage, even if it is unavailable", async (t) => {
  const bindChat = t.mock.fn(async () => { throw new Error("Storage unavailable"); });
  t.mock.method(console, "info", () => {});
  for (const value of [enabledPolicy, undefined, { ...enabledPolicy, enabled: false }]) {
    assert.equal(await admitLinqMessage(message(bob), true, line, {
      readResponsePolicy: async () => value, bindChat,
    }), null);
  }
  assert.equal(bindChat.mock.callCount(), 0);
});

test("allowlisted senders must still pass identity and conversation ownership checks", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  const readResponsePolicy = t.mock.fn(async () => enabledPolicy);
  const bindChat = t.mock.fn(async () => true);
  const deps = { readResponsePolicy, bindChat };
  const group = message(); group.raw.chat.is_group = true;
  const contradiction = message(bob); contradiction.author.userName = alice;
  for (const incoming of [group, contradiction]) {
    assert.equal(await admitLinqMessage(incoming, true, line, deps), null);
  }
  assert.equal(await admitLinqMessage(message(), true, bob, deps), null);
  assert.equal(readResponsePolicy.mock.callCount(), 0);
  assert.equal(bindChat.mock.callCount(), 0);

  const identity = privateLinqIdentity(message(), true, line)!;
  assert.deepEqual(await admitLinqMessage(message(), true, line, deps), { auth: identity.auth });
  assert.deepEqual(bindChat.mock.calls[0].arguments, [identity.chatKey, identity.auth.principalId]);
  assert.ok(!JSON.stringify(identity.auth).includes(alice));
  assert.equal(await admitLinqMessage(message(), true, line, {
    readResponsePolicy, bindChat: async () => false,
  }), null);
});

test("removing a sender or disabling the flag blocks the next message in an existing chat", async (t) => {
  t.mock.method(console, "info", () => {});
  let policy = enabledPolicy;
  const bindChat = t.mock.fn(async () => true);
  const deps = { readResponsePolicy: async () => policy, bindChat };
  assert.ok(await admitLinqMessage(message(), true, line, deps));
  policy = { enabled: true, allowedNumbers: [] };
  assert.equal(await admitLinqMessage(message(), true, line, deps), null);
  policy = { ...enabledPolicy, enabled: false };
  assert.equal(await admitLinqMessage(message(), true, line, deps), null);
  policy = enabledPolicy;
  assert.ok(await admitLinqMessage(message(), true, line, deps));
  assert.equal(bindChat.mock.callCount(), 2);
});

test("Global Config reads updates and fails closed after a previously successful read", async (t) => {
  const original = process.env.GLOBAL_CONFIG;
  t.after(() => {
    if (original === undefined) delete process.env.GLOBAL_CONFIG;
    else process.env.GLOBAL_CONFIG = original;
  });
  delete process.env.GLOBAL_CONFIG;
  assert.equal(await readLinqResponsePolicy(), undefined);
  process.env.GLOBAL_CONFIG = "invalid";
  assert.deepEqual(await assessLinqResponseAccess(alice), {
    accepted: false, reason: "response_policy_unavailable",
  });
  process.env.GLOBAL_CONFIG = "https://global-config.vercel.com/ecfg_policy_test?token=test-token";
  let policy = enabledPolicy;
  let outage = false;
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).has("cache-control"), false);
    return outage ? new Response("Unavailable", { status: 503 }) : Response.json(policy, {
      headers: { etag: JSON.stringify(policy) },
    });
  });
  assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: true });
  policy = { enabled: true, allowedNumbers: [] };
  assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: false, reason: "sender_not_allowlisted" });
  policy = enabledPolicy;
  assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: true });
  outage = true;
  assert.deepEqual(await assessLinqResponseAccess(alice), {
    accepted: false, reason: "response_policy_unavailable",
  });
  assert.equal(fetchMock.mock.callCount(), 4);
});

test("application route ignores blocked webhooks and dispatches only allowlisted senders", async (t) => {
  const key = Buffer.from("test-signature-secret-32-bytes-123");
  const env = {
    LINQ_API_KEY: "test-api-key",
    LINQ_WEBHOOK_SECRET: `whsec_${key.toString("base64")}`,
    LINQ_PHONE_NUMBER: line,
    GLOBAL_CONFIG: "https://global-config.vercel.com/ecfg_route_test?token=test-token",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_testsecret",
  };
  for (const [name, value] of Object.entries(env)) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
  let policy: unknown = enabledPolicy;
  let unavailable = false;
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
    if (url.hostname === "global-config.vercel.com") {
      if (unavailable) throw new Error("Config unavailable");
      return Response.json(policy);
    }
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
  for (const value of [enabledPolicy, { enabled: false, allowedNumbers: [bob] }, null, { enabled: true, allowedNumbers: [] }]) {
    policy = value;
    await send();
  }
  unavailable = true;
  await send();
  delete process.env.GLOBAL_CONFIG;
  await send();
  await send("reaction.added");
  await send("reaction.removed");
  assert.deepEqual(logs.mock.calls.filter((call) => call.arguments[0] === "[linq] inbound rejected")
    .map((call) => call.arguments[1]), [
    { reason: "sender_not_allowlisted" }, { reason: "responses_disabled" },
    { reason: "response_policy_invalid" }, { reason: "sender_not_allowlisted" },
    { reason: "response_policy_unavailable" }, { reason: "response_policy_invalid" },
  ]);
  assert.equal(outbound.length, 0);
  assert.equal(from.mock.callCount(), 0);
  assert.equal(neverDispatch.mock.callCount(), 0);
  assert.equal(errors.mock.callCount(), 0);

  // Enable this sender, then revoke them in the same chat and running process.
  process.env.GLOBAL_CONFIG = env.GLOBAL_CONFIG;
  unavailable = false;
  policy = { enabled: true, allowedNumbers: [bob] };
  allowSideEffects = true;
  network.get("https://teststore.private.blob.vercel-storage.com")
    .intercept({ path: `/app-private/linq/chat-owners/${identity.chatKey}.json?cache=0`, method: "GET" })
    .reply(() => {
      outbound.push("owner-read");
      return { statusCode: 200, data: JSON.stringify({ userScope: identity.auth.principalId }) };
    });
  await send();
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments), []);
  assert.deepEqual(outbound, ["owner-read", "mark-read"]);
  assert.equal(from.mock.callCount(), 1);
  assert.equal(deliver.mock.callCount(), 1);
  assert.partialDeepStrictEqual(deliver.mock.calls[0].arguments[1], { auth: identity.auth });
  policy = enabledPolicy;
  allowSideEffects = false;
  await send();
  assert.deepEqual(outbound, ["owner-read", "mark-read"]);
  assert.equal(from.mock.callCount(), 1);
  assert.equal(errors.mock.callCount(), 0);
  network.assertNoPendingInterceptors();
});
