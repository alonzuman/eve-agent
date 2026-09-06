import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { byPrincipal } from "eve/memory/scope";
import { accountAddress, accountPrincipal, prepareLinqAccount, type LinqAccountStore, type StoredLinqAccount } from "../src/identity/linq-account.js";
import { admitLinqMessage } from "../src/identity/linq-admission.js";
import { kernelProjectName } from "../src/browser/kernel-project.js";
import { isResetCommand, resettableLinqChannel } from "../src/messaging/resettable-linq-channel.js";

function memoryStore() {
  const accounts = new Map<string, StoredLinqAccount>();
  let revision = 0;
  const store: LinqAccountStore = {
    async read(id) { return structuredClone(accounts.get(id) ?? null); },
    async write(id, state, etag) {
      if ((accounts.get(id)?.etag ?? null) !== etag) return false;
      accounts.set(id, { state: structuredClone(state), etag: String(++revision) });
      return true;
    },
  };
  return { store, accounts };
}

const aliceId = "a".repeat(64), bobId = "b".repeat(64);
const chatA = "linq:chat-a", chatB = "linq:chat-b";

test("only a standalone !reset text message is a reset command", () => {
  for (const text of ["!reset", " \n!reset\t"]) assert.ok(isResetCommand({ text, attachments: [] }));
  for (const text of ["!RESET", "!reset please", "please !reset", "what does !reset do?", "!reset\nhello", ""]) {
    assert.equal(isResetCommand({ text, attachments: [] }), false);
  }
  assert.equal(isResetCommand({ text: "!reset", attachments: [{}] }), false);
});

test("reset retires every registered chat and replaces only that user's scopes", async () => {
  const { store, accounts } = memoryStore();
  const retired: string[] = [];
  const retire = async (address: string) => { retired.push(address); };
  const input = { principalId: aliceId, threadId: chatA, retire };
  assert.equal(await prepareLinqAccount(input, store), null);
  await prepareLinqAccount({ ...input, threadId: chatB }, store);
  await prepareLinqAccount({ ...input, principalId: bobId, threadId: "linq:bob" }, store);
  const bobBefore = structuredClone(accounts.get(bobId));
  const generation = await prepareLinqAccount({ ...input, resetMessageId: "reset-1" }, store);
  assert.ok(generation);
  assert.deepEqual(retired, [chatA, chatB]);
  assert.deepEqual(accounts.get(bobId), bobBefore);
  assert.equal(accounts.get(aliceId)!.state.pendingReset, null);
  assert.equal(await prepareLinqAccount(input, store), generation);
  assert.equal(await prepareLinqAccount({ ...input, threadId: chatB }, store), generation);
  assert.notEqual(accountPrincipal(aliceId, generation), aliceId);
  assert.notEqual(accountAddress(chatA, generation), chatA);
  assert.equal(accountPrincipal(aliceId, null), aliceId);
  assert.equal(accountAddress(chatA, null), chatA);
});

test("replayed reset webhooks, including older commands, never reset a fresh account again", async () => {
  const { store } = memoryStore();
  const retired: string[] = [];
  const input = { principalId: aliceId, threadId: chatA, retire: async (address: string) => { retired.push(address); } };
  const first = await prepareLinqAccount({ ...input, resetMessageId: "reset-1" }, store);
  await prepareLinqAccount(input, store);
  assert.equal(await prepareLinqAccount({ ...input, resetMessageId: "reset-1" }, store), first);
  const second = await prepareLinqAccount({ ...input, resetMessageId: "reset-2" }, store);
  assert.notEqual(first, second);
  await prepareLinqAccount(input, store);
  assert.equal(await prepareLinqAccount({ ...input, resetMessageId: "reset-1" }, store), second);
  assert.deepEqual(retired, [chatA, accountAddress(chatA, first)]);
});

test("concurrent first messages and duplicate resets converge through conditional writes", async () => {
  const { store, accounts } = memoryStore();
  const input = { principalId: aliceId, threadId: chatA, retire: async () => {} };
  await Promise.all([prepareLinqAccount(input, store), prepareLinqAccount({ ...input, threadId: chatB }, store)]);
  assert.deepEqual(new Set(accounts.get(aliceId)!.state.chats), new Set([chatA, chatB]));
  const resets = await Promise.all(Array.from({ length: 3 }, () =>
    prepareLinqAccount({ ...input, resetMessageId: "same-reset" }, store)));
  assert.equal(new Set(resets).size, 1);
  assert.equal(accounts.get(aliceId)!.state.resetIds.length, 1);
});

test("partial reset failure stays durable and blocks fresh turns until cleanup can complete", async () => {
  const { store, accounts } = memoryStore();
  const input = { principalId: aliceId, threadId: chatA, retire: async () => {} };
  await prepareLinqAccount(input, store);
  await prepareLinqAccount({ ...input, threadId: chatB }, store);
  const failing = { ...input, retire: async () => { throw new Error("Reset unavailable"); } };
  await assert.rejects(prepareLinqAccount({ ...failing, resetMessageId: "reset-1" }, store), /Reset unavailable/);
  const pending = accounts.get(aliceId)!.state;
  assert.ok(pending.pendingReset);
  await assert.rejects(prepareLinqAccount(failing, store), /Reset unavailable/);
  assert.equal(await prepareLinqAccount(input, store), pending.generation);
  assert.equal(accounts.get(aliceId)!.state.pendingReset, null);
  assert.deepEqual(accounts.get(aliceId)!.state.chats, [chatA]);
});

test("storage errors never fall back to the original account or retire sessions before recording reset", async () => {
  const retire = async () => { assert.fail("Must not retire before persisting reset"); };
  const input = { principalId: aliceId, threadId: chatA, resetMessageId: "reset-1", retire };
  const unavailable: LinqAccountStore = {
    async read() { throw new Error("Storage unavailable"); },
    async write() { throw new Error("Storage unavailable"); },
  };
  await assert.rejects(prepareLinqAccount(input, unavailable), /Storage unavailable/);
  await assert.rejects(prepareLinqAccount(input, { ...unavailable, async read() { return null; } }), /Storage unavailable/);
});

test("signed Linq reset bypasses model dispatch and the next message starts with isolated history, memory and browser state", async (t) => {
  const { store, accounts } = memoryStore();
  const line = "+12025550100", alice = "+12025550101", bob = "+12025550102";
  const key = Buffer.from("test-signature-secret-32-bytes-123");
  const owners = new Map<string, string>();
  const admittedPrincipals: string[] = [];
  const channel = resettableLinqChannel({
    credentials: { apiKey: "test-api-key", signingSecret: `whsec_${key.toString("base64")}` },
    onMessage: ({ thread }, message) => admitLinqMessage(message, thread.isDM, line, {
      allowedNumbers: `${alice},${bob}`,
      async bindChat(chat, owner) {
        const existing = owners.get(chat);
        if (existing && existing !== owner) return false;
        owners.set(chat, owner);
        return true;
      },
    }),
    async onAdmittedMessage(_ctx, _message, admission) {
      admittedPrincipals.push(admission.auth!.principalId);
      return admission;
    },
  }, store);
  const replies: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "api.linqapp.com");
    if (url.pathname.endsWith("/read")) return new Response(null, { status: 204 });
    assert.ok(url.pathname.endsWith("/messages"));
    const body = JSON.parse(String(init?.body));
    replies.push(body.message.parts[0].value);
    return Response.json({ message: { id: `reply-${replies.length}` } });
  });
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  const route = channel.routes.find(route => route.method === "POST")!;
  if (route.transport === "websocket") throw new Error("Expected HTTP");
  const httpRoute = route;
  type Args = Parameters<typeof httpRoute.handler>[1];
  const delivered: { address: string; content: unknown; options: { auth: {
    authenticator: string; issuer: string; principalType: string; principalId: string; attributes: {};
  }; state: { thread: { id: string; isDM: boolean } } } }[] = [];
  const retired: string[] = [];
  let resetFails = false;
  const pending: Promise<unknown>[] = [];
  const never = () => { throw new Error("Unexpected session operation"); };
  const args: Args = {
    from: address => new Proxy({} as ReturnType<Args["from"]>, {
      get(_target, prop) {
        if (prop === "reset") return async () => {
          if (resetFails) throw new Error("Reset unavailable");
          retired.push(address);
          return { status: "no_active_session" };
        };
        assert.equal(typeof prop, "symbol");
        return async (content: unknown, options: typeof delivered[number]["options"]) => {
          delivered.push({ address, content, options });
        };
      },
    }),
    to: never, resolveSession: never, attachSession: never, params: {}, requestIp: null,
    waitUntil: promise => { pending.push(promise); },
  };
  let messageCount = 0;
  async function send(text: string, sender = alice, chatId = "chat-a", options: {
    signed?: boolean; group?: boolean;
  } = {}) {
    const id = `message-${messageCount++}`;
    const body = JSON.stringify({ event_type: "message.received", data: {
      id, direction: "inbound", parts: [{ type: "text", value: text }],
      chat: { id: chatId, is_group: options.group ?? false, owner_handle: { handle: line, is_me: true } },
      sender_handle: { id: sender, handle: sender, is_me: false },
    } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    const response = await httpRoute.handler(new Request("https://example.com/eve/v1/linq", {
      method: "POST", body, headers: options.signed === false ? {} : {
        "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`,
      },
    }), args);
    await Promise.all(pending.splice(0));
    assert.equal(response.status, options.signed === false ? 401 : 200);
  }
  await send("remember my favorite flower is a rose");
  await send("another chat", alice, "chat-a2");
  await send("remember my favorite flower is a tulip", bob, "chat-b");
  assert.equal(delivered.length, 3);
  assert.equal(admittedPrincipals.length, 3);
  const oldAlice = delivered[0]!, oldBob = delivered[2]!;
  const accountsBefore = structuredClone(accounts);
  await send("!reset", alice, "chat-a", { signed: false });
  await send("!reset", alice, "group", { group: true });
  await send("!reset", "+12025550103", "blocked");
  await send("!reset", bob, "chat-a"); // Cannot take over Alice's chat.
  assert.deepEqual(accounts, accountsBefore);
  assert.deepEqual(replies, []);
  assert.deepEqual(retired, []);
  assert.equal(delivered.length, 3);

  await send(" \n!reset\t");
  assert.equal(delivered.length, 3);
  assert.deepEqual(retired, ["linq:chat-a", "linq:chat-a2"]);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /starting fresh/);
  await send("what do you know about me?");
  const freshAlice = delivered.at(-1)!;
  assert.equal(admittedPrincipals.at(-1), freshAlice.options.auth.principalId,
    "message persistence sees the new reset generation, not the original sender scope");
  assert.notEqual(freshAlice.address, oldAlice.address);
  assert.notEqual(freshAlice.options.auth.principalId, oldAlice.options.auth.principalId);
  assert.deepEqual(freshAlice.content, { message: "what do you know about me?", context: [] });
  assert.notEqual(freshAlice.address, oldBob.address);
  const context = (entry: typeof oldAlice) => ({
    session: { id: entry.address, auth: { current: entry.options.auth, initiator: entry.options.auth } },
    channel: {}, abortSignal: new AbortController().signal,
  });
  assert.notEqual(byPrincipal(context(freshAlice)), byPrincipal(context(oldAlice)));
  assert.notEqual(kernelProjectName(context(freshAlice)), kernelProjectName(context(oldAlice)));
  await send("hello again", bob, "chat-b");
  assert.equal(delivered.at(-1)!.address, oldBob.address);
  assert.deepEqual(delivered.at(-1)!.options.auth, oldBob.options.auth);
  await send("hello from my other chat", alice, "chat-a2");
  assert.equal(delivered.at(-1)!.options.auth.principalId, freshAlice.options.auth.principalId);
  assert.notEqual(delivered.at(-1)!.address, delivered[1]!.address);
  await send("what does !reset do?");
  assert.equal(delivered.at(-1)!.address, freshAlice.address);

  const count = delivered.length;
  resetFails = true;
  await send("!reset");
  assert.equal(delivered.length, count);
  assert.match(replies.at(-1)!, /couldn't finish/);
  resetFails = false;
  await send("hi after recovery");
  assert.equal(delivered.length, count + 1);
  assert.notEqual(delivered.at(-1)!.address, freshAlice.address);
  const overlapStart = delivered.length;
  await Promise.all([send("overlapping Alice", alice, "chat-a"), send("overlapping Bob", bob, "chat-b")]);
  const overlapping = delivered.slice(overlapStart);
  assert.equal(overlapping.length, 2);
  const aliceDelivery = overlapping.find(entry => entry.options.state.thread.id === "linq:chat-a")!;
  const bobDelivery = overlapping.find(entry => entry.options.state.thread.id === "linq:chat-b")!;
  assert.deepEqual(aliceDelivery.content, { message: "overlapping Alice", context: [] });
  assert.deepEqual(bobDelivery.content, { message: "overlapping Bob", context: [] });
  assert.notEqual(aliceDelivery.address, bobDelivery.address);
  assert.notEqual(aliceDelivery.options.auth.principalId, bobDelivery.options.auth.principalId);
  assert.equal(bobDelivery.address, oldBob.address);
  assert.equal(aliceDelivery.options.state.thread.isDM, true);
  assert.equal(bobDelivery.options.state.thread.isDM, true);
  assert.equal(errors.mock.calls.filter(call => call.arguments[0] === "[chat-sdk] Message processing error").length, 0);
});
