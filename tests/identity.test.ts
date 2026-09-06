import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { linqChannel } from "eve/channels/linq";
import { bindPrivateChat, type ChatOwnerStore } from "../src/identity/chat-owner.js";
import { assessPrivateLinqIdentity, canonicalHandle, privateLinqIdentity } from "../src/identity/linq-policy.js";
import { requireUserScope } from "../src/identity/user-scope.js";

const line = "+12025550100";
function message(sender = "+12025550101", chatId = "chat-a") {
  return {
    id: "message-1", threadId: `linq:${chatId}`,
    author: { userId: "handle-1", userName: sender, isBot: false, isMe: false },
    raw: {
      id: "message-1", direction: "inbound",
      chat: { id: chatId, is_group: false, owner_handle: { handle: line, is_me: true } },
      sender_handle: { id: "handle-1", handle: sender, is_me: false },
    },
  };
}

test("two verified senders have distinct scopes; same sender survives chat changes", () => {
  const alice = privateLinqIdentity(message(), true, line)!;
  const bob = privateLinqIdentity(message("+12025550102", "chat-b"), true, line)!;
  const aliceNewChat = privateLinqIdentity(message("+12025550101", "chat-c"), true, line)!;
  assert.notEqual(alice.auth.principalId, bob.auth.principalId);
  assert.equal(alice.auth.principalId, aliceNewChat.auth.principalId);
  assert.notEqual(alice.chatKey, aliceNewChat.chatKey);
  assert.equal(requireUserScope({ session: { auth: { current: alice.auth, initiator: alice.auth } } }), alice.auth.principalId);
  assert.throws(() => requireUserScope({ session: { auth: { current: bob.auth, initiator: alice.auth } } }));
});

test("reject groups, wrong lines, ambiguous authors and contradictory signed data", () => {
  assert.equal(privateLinqIdentity(message(), false, line), null);
  assert.equal(privateLinqIdentity(message(), true, "+12025550999"), null);
  const group = message(); group.raw.chat.is_group = true;
  assert.equal(privateLinqIdentity(group, true, line), null);
  const bot = message(); bot.author.isBot = true;
  assert.equal(privateLinqIdentity(bot, true, line), null);
  const mismatched = message(); mismatched.author.userId = "someone-else";
  assert.equal(privateLinqIdentity(mismatched, true, line), null);
  const noSender = message(); noSender.raw.sender_handle.handle = "unknown";
  assert.equal(privateLinqIdentity(noSender, true, line), null);
  const missingGroupFlag = message();
  Reflect.deleteProperty(missingGroupFlag.raw.chat, "is_group");
  assert.equal(privateLinqIdentity(missingGroupFlag, true, line), null);
});

test("scope cannot come from anonymous, local-dev or service identities", () => {
  const auth = privateLinqIdentity(message(), true, line)!.auth;
  for (const current of [null, { ...auth, authenticator: "local-dev" }, { ...auth, principalType: "service" }]) {
    assert.throws(() => requireUserScope({ session: { auth: { current, initiator: auth } } }));
  }
  assert.equal(canonicalHandle("12025550101"), null);
  assert.equal(canonicalHandle("Alice@EXAMPLE.COM"), "Alice@example.com");
});

test("rejection diagnostics identify missing flags and bad configuration without exposing identity", () => {
  assert.deepEqual(assessPrivateLinqIdentity(message(), true, "12025550100"), {
    accepted: false, reason: "configured_line_invalid",
  });
  assert.deepEqual(assessPrivateLinqIdentity(message(), true, "+12025550999"), {
    accepted: false, reason: "owner_line_mismatch",
  });
  const missingOwner = message();
  Reflect.deleteProperty(missingOwner.raw.chat, "owner_handle");
  assert.deepEqual(assessPrivateLinqIdentity(missingOwner, true, line), {
    accepted: false, reason: "owner_handle_missing",
  });
  const missingOwnerFlag = message();
  Reflect.deleteProperty(missingOwnerFlag.raw.chat.owner_handle, "is_me");
  assert.deepEqual(assessPrivateLinqIdentity(missingOwnerFlag, true, line), {
    accepted: false, reason: "owner_self_flag_missing_or_false",
  });
  const missingSenderFlag = message();
  Reflect.deleteProperty(missingSenderFlag.raw.sender_handle, "is_me");
  assert.deepEqual(assessPrivateLinqIdentity(missingSenderFlag, true, line), {
    accepted: false, reason: "sender_self_flag_missing_or_true",
  });
});

test("racing first senders cannot claim one durable conversation twice", async () => {
  const data = new Map<string, string>();
  const store: ChatOwnerStore = {
    async read(key) { return data.get(key) ?? null; },
    async create(key, owner) {
      if (data.has(key)) throw new Error("Already exists");
      data.set(key, owner);
    },
  };
  const a = "a".repeat(64), b = "b".repeat(64), chat = "c".repeat(64);
  const results = await Promise.all([bindPrivateChat(chat, a, store), bindPrivateChat(chat, b, store)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await bindPrivateChat(chat, data.get(chat)!, store), true);
  assert.equal(await bindPrivateChat(chat, data.get(chat) === a ? b : a, store), false);
});

test("owner storage failure fails closed", async () => {
  const store: ChatOwnerStore = {
    async read() { return null; },
    async create() { throw new Error("Storage unavailable"); },
  };
  await assert.rejects(bindPrivateChat("c".repeat(64), "a".repeat(64), store), /Storage unavailable/);
});

test("eve's actual Linq route rejects unsigned, tampered and expired webhook bodies", async () => {
  const key = Buffer.from("test-signature-secret-32-bytes-123");
  const channel = linqChannel({ credentials: { apiKey: "test-not-a-real-api-key", signingSecret: `whsec_${key.toString("base64")}` } });
  const route = channel.routes.find((route) => route.method === "POST")!;
  if (route.transport === "websocket") throw new Error("Expected HTTP");
  const neverDispatch = () => { throw new Error("Should not dispatch any model work"); };
  const args = { from: neverDispatch, to: neverDispatch, resolveSession: neverDispatch, attachSession: neverDispatch, params: {}, waitUntil: neverDispatch, requestIp: null };
  const body = JSON.stringify({ event_type: "message.delivered", data: {} });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = "event-test";
  const signature = (stamp: string) => createHmac("sha256", key).update(`${id}.${stamp}.${body}`).digest("base64");
  const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature(timestamp)}` };
  const send = (data: string, requestHeaders: Record<string, string>) => route.handler(new Request("https://example.com/eve/v1/linq", { method: "POST", headers: requestHeaders, body: data }), args);
  assert.equal((await send(body, {})).status, 401);
  assert.equal((await send(body + " ", headers)).status, 401);
  assert.equal((await send(body, { ...headers, "webhook-timestamp": "1", "webhook-signature": `v1,${signature("1")}` })).status, 401);
  assert.equal((await send(body, headers)).status, 200);
});
