import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import channel from "../agent/channels/linq.js";
import presentCards from "../agent/tools/present_cards.js";
import { visualCardsState } from "../src/visual/card-state.js";
import { cardsSchema, type CardSet } from "../src/visual/cards.js";
import { messageStore } from "../src/messaging/message-store.js";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { buildCallbackContext } from "../node_modules/eve/dist/src/context/build-callback-context.js";
import { registerDefinitionSource, stampDefinitionKey } from "../node_modules/eve/dist/src/internal/authored-definition/source-identity.js";

const identity = { authenticator: "linq-private", issuer: "linq:test", principalType: "user" as const, principalId: "a".repeat(64), attributes: {} };
const set = cardsSchema.parse({ introduction: "Four ideas. Reply with a number.", cards: [1, 2, 3, 4].map(number => ({
  html: '<div style="width:100%;height:100%;background:#eae4d3;display:flex;font-size:64px;padding:48px">{{TITLE}}</div>',
  props: { TITLE: `Idea ${number}` }, label: `Idea ${number}`, sourceUrl: `https://example.com/${number}`,
})) });
function freshContext(id: string, authenticated = true) {
  const context = new ContextContainer();
  context.set(SessionKey, { sessionId: id, auth: { current: authenticated ? identity : null, initiator: authenticated ? identity : null }, turn: { id: "turn-1", sequence: 1 } });
  return context;
}
function nextStep(previous: ContextContainer) {
  const next = new ContextContainer();
  for (const [key, value] of previous.entries()) next.set(key, JSON.parse(JSON.stringify(value)));
  return next;
}
function toolContext(callId: string) {
  return { ...buildCallbackContext(), callId, toolName: "present_cards", abortSignal: new AbortController().signal,
    async getToken(): Promise<never> { throw new Error("Unexpected token request"); }, requireAuth(): never { throw new Error("Unexpected auth request"); } };
}
stampDefinitionKey(presentCards, "test.present-cards");
registerDefinitionSource("test.present-cards", { kind: "tool", name: "present_cards" });

test("local card tools render a gallery, retain numbered references and never send to Linq", async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.EVE_DEV = "1";
  delete process.env.VERCEL_ENV;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Local previews must not send or upload"); });
  const local = { authenticator: "local-dev", principalType: "local-dev" as const, principalId: "local-dev", attributes: {} };
  let context = freshContext("local-session");
  context.set(SessionKey, { sessionId: "local-session", auth: { current: local, initiator: local }, turn: { id: "turn-1", sequence: 1 } });
  const execute = async (input: Parameters<NonNullable<typeof presentCards.execute>>[0]) => contextStorage.run(context, () => presentCards.execute!(input, toolContext("local-preview-test")));
  const result = await execute({ action: "present", ...set });
  assert.ok(result && "path" in result);
  t.after(() => rm(dirname(result.path), { recursive: true, force: true }));
  assert.equal(result.status, "preview_ready");
  assert.match(await readFile(result.path, "utf8"), /card-1.png/);
  assert.equal((await readFile(result.cards[0].path)).subarray(1, 4).toString(), "PNG");
  assert.equal(result.cards[1].sourceUrl, "https://example.com/2");
  context = nextStep(context);
  assert.deepEqual(await execute({ action: "status" }), result);
  assert.deepEqual(await execute({ action: "retry" }), result);
  await contextStorage.run(context, () => assert.equal(visualCardsState.get().lastSent, null));
});

test("real Linq adapter sends a rendered batch once, preserves references and retries failed sets", async t => {
  const recorded = t.mock.method(messageStore, "record", async (...[_scope, input]: Parameters<typeof messageStore.record>) =>
    input.map((message, index) => ({ ...message, ref: `m${index + 1}` })));
  const previousKey = process.env.LINQ_API_KEY;
  const previousSecret = process.env.LINQ_WEBHOOK_SECRET;
  process.env.LINQ_API_KEY = "test-api-key";
  process.env.LINQ_WEBHOOK_SECRET = "test-signing-secret";
  t.after(() => {
    if (previousKey === undefined) delete process.env.LINQ_API_KEY; else process.env.LINQ_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.LINQ_WEBHOOK_SECRET; else process.env.LINQ_WEBHOOK_SECRET = previousSecret;
  });
  let uploads = 0, sends = 0, rejectSend = false;
  const sendKeys: string[] = [];
  const attachments: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/chats/chat-a/typing")) return new Response(null, { status: 204 });
    if (request.url.endsWith("/attachments")) {
      const body = await request.json() as { filename: string; content_type: string; size_bytes: number };
      assert.equal(body.content_type, "image/png"); assert.ok(body.size_bytes > 100);
      attachments.push(body.filename);
      return Response.json({ attachment_id: `attachment-${attachments.length}`, upload_url: `https://uploads.example.test/${attachments.length}`, http_method: "PUT", required_headers: { "Content-Type": "image/png" } });
    }
    if (request.url.startsWith("https://uploads.example.test/")) {
      uploads++;
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      return new Response(null, { status: 200 });
    }
    if (request.url.endsWith("/chats/chat-a/messages")) {
      sends++;
      const body = await request.json() as { message: { parts: { type: string; attachment_id?: string }[]; idempotency_key: string } };
      assert.equal(body.message.parts.filter(part => part.type === "media").length, 4);
      assert.deepEqual(body.message.parts.filter(part => part.type === "media").map(part => part.attachment_id), attachments.slice(-4).map((_, index) => `attachment-${attachments.length - 3 + index}`));
      sendKeys.push(body.message.idempotency_key);
      if (rejectSend) return Response.json({ error: "test rejection" }, { status: 403 });
      return Response.json({ message: { id: `message-${sends}` }, chat_id: "chat-a" });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });
  const { adapter } = channel as unknown as { adapter: {
    createAdapterContext(input: unknown): object;
    "turn.started"(data: unknown, context: unknown): Promise<void>;
    "action.result"(data: unknown, context: unknown): Promise<void>;
  } };
  const channelContext = adapter.createAdapterContext({ state: { thread: {
    _type: "chat:Thread", adapterName: "linq", channelId: "linq:chat-a", id: "linq:chat-a", isDM: true,
  } } });
  let context = freshContext("session-a");
  const coordinates = { turnId: "turn-1", sequence: 1, stepIndex: 0 };
  await contextStorage.run(context, () => adapter["turn.started"](coordinates, channelContext));
  const execute = async (input: Parameters<NonNullable<typeof presentCards.execute>>[0], callId: string) =>
    await contextStorage.run(context, () => presentCards.execute!(input, toolContext(callId))) as { status: string; lastSent?: { set: CardSet; messageId: string } | null };
  const dispatch = (output: unknown, callId: string, destination = channelContext) => contextStorage.run(context, () => adapter["action.result"]({ ...coordinates, result: { kind: "tool-result", callId, toolName: "present_cards", output } }, destination));
  const queued = await execute({ action: "present", ...set }, "present-1");
  assert.equal(queued.status, "queued"); assert.equal(sends, 0);
  await assert.rejects(dispatch(queued, "present-1", { ...channelContext, thread: { id: "linq:group", isDM: false } }), /private Linq chat/);
  await assert.rejects(dispatch(queued, "present-1", { ...channelContext, thread: { id: "linq:chat-b", isDM: true } }), /another conversation/);
  assert.equal(uploads, 0, "foreign chats must be rejected before uploading private card images");
  const preparedStatus = await execute({ action: "status" }, "status-0");
  assert.equal(preparedStatus.status, "prepared");
  await dispatch(preparedStatus, "status-0");
  assert.equal(sends, 0, "status is read-only");
  context = nextStep(context);
  await dispatch(queued, "present-1");
  context = nextStep(context);
  const receipt = await execute({ action: "status" }, "status-1");
  assert.equal(receipt.status, "sent", JSON.stringify({ uploads, sends, attachments, receipt }));
  if (!("lastSent" in receipt)) throw new Error("Missing last sent set");
  assert.equal(receipt.lastSent?.set.cards[1].sourceUrl, "https://example.com/2");
  await contextStorage.run(context, () => assert.deepEqual(visualCardsState.get().current?.images, []));
  await dispatch(queued, "present-1");
  assert.equal(sends, 1); assert.equal(uploads, 4);
  assert.deepEqual(recorded.mock.calls[0].arguments[1].map(part => [part.messageId, part.partIndex, part.partType]), [
    ["message-1", 0, "text"], ["message-1", 1, "media"], ["message-1", 2, "media"], ["message-1", 3, "media"], ["message-1", 4, "media"],
  ]);
  assert.equal(recorded.mock.calls[0].arguments[1][2].content, "[visual card attachment: Idea 2]");
  assert.deepEqual(attachments, ["card-1.png", "card-2.png", "card-3.png", "card-4.png"]);
  const bad = { ...set, cards: [set.cards[0], { ...set.cards[1], html: "<div>{{MISSING}}</div>" }] };
  await assert.rejects(execute({ action: "present", ...bad }, "bad-layout"), /card 2/);
  assert.equal(sends, 1, "partial render cannot send");
  rejectSend = true;
  const replacement = await execute({ action: "present", ...set }, "present-2");
  await dispatch(replacement, "present-2");
  const failed = await execute({ action: "status" }, "status-2");
  assert.equal(failed.status, "failed");
  if (!("lastSent" in failed)) throw new Error("Missing last sent set");
  assert.equal(failed.lastSent?.messageId, "message-1", "failure must not replace the delivered choices");
  const retry = await execute({ action: "retry" }, "retry-1");
  rejectSend = false;
  await dispatch(retry, "retry-1");
  assert.equal(sendKeys[1], sendKeys[2]); assert.notEqual(sendKeys[0], sendKeys[1]);
  context = freshContext("session-b");
  assert.equal((await execute({ action: "status" }, "other-status")).status, "not_sent");
  await assert.rejects(execute({ action: "retry" }, "other-retry"), /No prepared cards/);
  context = freshContext("anonymous", false);
  await assert.rejects(execute({ action: "present", ...set }, "anonymous"), /verified private Linq conversation/);
});
