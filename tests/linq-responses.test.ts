import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { evaluate, Reason, type DatafileInput, type Packed } from "@vercel/flags-core";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import channel from "../agent/channels/linq.js";
import { assessLinqResponseAccess, LINQ_RESPONSES_FLAG, type EvaluateLinqResponseFlag } from "../src/flags/linq-responses.js";
import { admitLinqMessage } from "../src/identity/linq-admission.js";
import { privateLinqIdentity } from "../src/identity/linq-policy.js";

const line = "+12025550100", alice = "+12025550101", bob = "+12025550102";
const sdkKey = "vf_server_test_only";

function flagsData(numbers = [alice], config?: Packed.EnvironmentConfig): DatafileInput {
  return {
    projectId: "prj_test", environment: "production",
    definitions: {
      [LINQ_RESPONSES_FLAG]: {
        variants: [false, true],
        environments: { production: config ?? { targets: [{}, { user: { id: numbers } }], fallthrough: 0 } },
      },
    },
  };
}

function evaluateData(data = flagsData()): EvaluateLinqResponseFlag {
  return async (sender) => evaluate({
    definition: data.definitions[LINQ_RESPONSES_FLAG], environment: data.environment,
    entities: { user: { id: sender } }, defaultValue: false,
  });
}

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

test("Vercel Flags direct targets allow only exact phone numbers", async () => {
  const evaluateFlag = evaluateData(flagsData([alice, bob, alice]));
  for (const sender of [alice, bob]) {
    assert.deepEqual(await assessLinqResponseAccess(sender, evaluateFlag), { accepted: true });
  }
  for (const sender of [line, "alice@example.com", "12025550101", alice + " ", alice + "\n", alice + "0"]) {
    assert.deepEqual(await assessLinqResponseAccess(sender, evaluateFlag), {
      accepted: false, reason: "sender_not_allowlisted",
    });
  }
  // Even explicitly targeted email identities must not bypass the phone allowlist.
  assert.equal((await assessLinqResponseAccess("alice@example.com", evaluateData(flagsData(["alice@example.com"])))).accepted, false);
});

test("paused flags, empty targets and broadly enabled defaults never admit a sender", async () => {
  for (const variant of [0, 1]) {
    assert.deepEqual(await assessLinqResponseAccess(alice, evaluateData(flagsData([alice], variant))), {
      accepted: false, reason: "responses_disabled",
    });
  }
  for (const data of [flagsData([]), flagsData([], { fallthrough: 1 }), flagsData(["*", alice.slice(1)])]) {
    assert.deepEqual(await assessLinqResponseAccess(alice, evaluateData(data)), {
      accepted: false, reason: "sender_not_allowlisted",
    });
  }
  // Only direct targets grant access; rules, rollouts, and fallthrough cannot expand the allowlist.
  assert.deepEqual(await assessLinqResponseAccess(alice, async () => ({
    reason: Reason.RULE_MATCH, value: true, variantId: null,
  })), { accepted: false, reason: "sender_not_allowlisted" });
});

test("invalid flag values and evaluation errors fail closed", async () => {
  for (const value of [undefined, null, "true", 1, {}, [alice]]) {
    assert.deepEqual(await assessLinqResponseAccess(alice, async () => ({
      reason: Reason.TARGET_MATCH, value, variantId: null,
    })), { accepted: false, reason: "response_flag_invalid" });
  }
  assert.deepEqual(await assessLinqResponseAccess(alice, async () => ({
    reason: Reason.ERROR, value: true, errorMessage: "Private provider details", variantId: null,
  })), { accepted: false, reason: "response_flag_unavailable" });
  assert.deepEqual(await assessLinqResponseAccess(alice, async () => {
    throw new Error("Provider failed with secret token and private phone number");
  }), { accepted: false, reason: "response_flag_unavailable" });
});

test("rejected senders never reach owner storage, even if it is unavailable", async (t) => {
  const bindChat = t.mock.fn(async () => { throw new Error("Storage unavailable"); });
  t.mock.method(console, "info", () => {});
  for (const data of [flagsData(), flagsData([bob], 0), flagsData([])]) {
    assert.equal(await admitLinqMessage(message(bob), true, line, {
      evaluateResponseFlag: evaluateData(data), bindChat,
    }), null);
  }
  assert.equal(bindChat.mock.callCount(), 0);
});

test("allowlisted senders must still pass identity and conversation ownership checks", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  const evaluateResponseFlag = t.mock.fn(evaluateData());
  const bindChat = t.mock.fn(async () => true);
  const deps = { evaluateResponseFlag, bindChat };
  const group = message(); group.raw.chat.is_group = true;
  const contradiction = message(bob); contradiction.author.userName = alice;
  for (const incoming of [group, contradiction]) {
    assert.equal(await admitLinqMessage(incoming, true, line, deps), null);
  }
  assert.equal(await admitLinqMessage(message(), true, bob, deps), null);
  assert.equal(evaluateResponseFlag.mock.callCount(), 0);
  assert.equal(bindChat.mock.callCount(), 0);

  const identity = privateLinqIdentity(message(), true, line)!;
  assert.deepEqual(await admitLinqMessage(message(), true, line, deps), { auth: identity.auth });
  assert.deepEqual(evaluateResponseFlag.mock.calls[0].arguments, [alice]);
  assert.deepEqual(bindChat.mock.calls[0].arguments, [identity.chatKey, identity.auth.principalId]);
  assert.ok(!JSON.stringify(identity.auth).includes(alice));
  assert.equal(await admitLinqMessage(message(), true, line, {
    evaluateResponseFlag, bindChat: async () => false,
  }), null);
});

test("removing a target or pausing the flag blocks the next message in an existing chat", async (t) => {
  t.mock.method(console, "info", () => {});
  let data = flagsData();
  const bindChat = t.mock.fn(async () => true);
  const deps = { evaluateResponseFlag: (sender: string) => evaluateData(data)(sender), bindChat };
  assert.ok(await admitLinqMessage(message(), true, line, deps));
  data = flagsData([]);
  assert.equal(await admitLinqMessage(message(), true, line, deps), null);
  data = flagsData([alice], 0);
  assert.equal(await admitLinqMessage(message(), true, line, deps), null);
  data = flagsData();
  assert.ok(await admitLinqMessage(message(), true, line, deps));
  assert.equal(bindChat.mock.callCount(), 2);
});

test("Vercel Flags refreshes every evaluation and denies outages after a successful read", async (t) => {
  const original = process.env.FLAGS;
  t.after(() => {
    if (original === undefined) delete process.env.FLAGS;
    else process.env.FLAGS = original;
  });
  for (const key of [undefined, "invalid"]) {
    if (key) process.env.FLAGS = key;
    else delete process.env.FLAGS;
    assert.deepEqual(await assessLinqResponseAccess(alice), {
      accepted: false, reason: "response_flag_unavailable",
    });
  }
  process.env.FLAGS = sdkKey;
  let data: unknown = flagsData();
  let outage = false;
  t.mock.method(console, "error", () => {});
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), "https://flags.vercel.com/v1/datafile");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${sdkKey}`);
    assert.ok(!JSON.stringify(init).includes(alice));
    return outage ? new Response("Unavailable", { status: 503 }) : Response.json(data);
  });
  assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: true });
  data = flagsData([]);
  assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: false, reason: "sender_not_allowlisted" });
  data = flagsData();
  assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: true });
  outage = true;
  assert.deepEqual(await assessLinqResponseAccess(alice), {
    accepted: false, reason: "response_flag_unavailable",
  });
  outage = false;
  for (const invalid of [{ definitions: {}, environment: "production", projectId: "prj_test" }, null, {}]) {
    data = invalid;
    assert.deepEqual(await assessLinqResponseAccess(alice), { accepted: false, reason: "response_flag_unavailable" });
  }
  assert.equal(fetchMock.mock.callCount(), 7);
});

test("a stalled flag refresh is denied and the outstanding request is canceled", async (t) => {
  const original = process.env.FLAGS;
  process.env.FLAGS = sdkKey;
  t.after(() => {
    if (original === undefined) delete process.env.FLAGS;
    else process.env.FLAGS = original;
  });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = Promise.withResolvers<AbortSignal>();
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init!.signal!;
    started.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  });
  const pending = assessLinqResponseAccess(alice);
  const signal = await started.promise;
  t.mock.timers.tick(2_001);
  assert.deepEqual(await pending, { accepted: false, reason: "response_flag_unavailable" });
  assert.equal(signal.aborted, true);
});

test("application route ignores blocked webhooks and dispatches only allowlisted senders", async (t) => {
  const key = Buffer.from("test-signature-secret-32-bytes-123");
  const env = {
    LINQ_API_KEY: "test-api-key",
    LINQ_WEBHOOK_SECRET: `whsec_${key.toString("base64")}`,
    LINQ_PHONE_NUMBER: line,
    FLAGS: sdkKey,
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
  let data: unknown = flagsData();
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
    if (url.hostname === "flags.vercel.com") {
      if (unavailable) throw new Error("Config unavailable");
      return Response.json(data);
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
  for (const value of [flagsData(), flagsData([bob], 0), {}, flagsData([])]) {
    data = value;
    await send();
  }
  unavailable = true;
  await send();
  delete process.env.FLAGS;
  await send();
  await send("reaction.added");
  await send("reaction.removed");
  assert.deepEqual(logs.mock.calls.filter((call) => call.arguments[0] === "[linq] inbound rejected")
    .map((call) => call.arguments[1]), [
    { reason: "sender_not_allowlisted" }, { reason: "responses_disabled" },
    { reason: "response_flag_unavailable" }, { reason: "sender_not_allowlisted" },
    { reason: "response_flag_unavailable" }, { reason: "response_flag_unavailable" },
  ]);
  assert.equal(outbound.length, 0);
  assert.equal(from.mock.callCount(), 0);
  assert.equal(neverDispatch.mock.callCount(), 0);
  assert.equal(errors.mock.calls.filter((call) => call.arguments[0] === "[chat-sdk] Message processing error").length, 0);

  // Enable this sender, then revoke them in the same chat and running process.
  process.env.FLAGS = env.FLAGS;
  unavailable = false;
  data = flagsData([bob]);
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
  data = flagsData();
  allowSideEffects = false;
  await send();
  assert.deepEqual(outbound, ["owner-read", "mark-read"]);
  assert.equal(from.mock.callCount(), 1);
  assert.equal(errors.mock.calls.filter((call) => call.arguments[0] === "[chat-sdk] Message processing error").length, 0);
  network.assertNoPendingInterceptors();
});
