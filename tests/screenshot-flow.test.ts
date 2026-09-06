import assert from "node:assert/strict";
import { test } from "node:test";
import channel from "../agent/channels/linq.js";
import sendScreenshot from "../agent/tools/send_browser_screenshot.js";
import { screenshotState } from "../src/browser/screenshot-state.js";
// Test-only access to the pinned Eve runtime: exercise real channel handlers,
// tool source matching, and serialization between steps, without a model call.
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { buildCallbackContext } from "../node_modules/eve/dist/src/context/build-callback-context.js";
import { registerDefinitionSource, stampDefinitionKey } from "../node_modules/eve/dist/src/internal/authored-definition/source-identity.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=";
const identity = { authenticator: "linq-private", issuer: "linq:test", principalType: "user" as const, principalId: "a".repeat(64), attributes: {} };
function toolContext(callId: string) {
  return {
    ...buildCallbackContext(), callId, toolName: "send_browser_screenshot", abortSignal: new AbortController().signal,
    async getToken(): Promise<never> { throw new Error("Unexpected token lookup"); },
    requireAuth(): never { throw new Error("Unexpected authorization request"); },
  };
}
function freshContext(id: string) {
  const context = new ContextContainer();
  context.set(SessionKey, { sessionId: id, auth: { current: identity, initiator: identity }, turn: { id: "turn-1", sequence: 1 } });
  return context;
}
function nextStep(previous: ContextContainer) {
  const next = new ContextContainer();
  for (const [key, value] of previous.entries()) next.set(key, JSON.parse(JSON.stringify(value)));
  return next;
}
stampDefinitionKey(sendScreenshot, "test.send-browser-screenshot");
registerDefinitionSource("test.send-browser-screenshot", { kind: "tool", name: "send_browser_screenshot" });

test("Kernel capture -> durable state -> send tool -> actual Linq upload and attachment message -> receipt", async (t) => {
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
  let uploads = 0, sends = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/attachments")) {
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), { filename: "screenshot.png", content_type: "image/png", size_bytes: Buffer.from(png, "base64").length });
      return Response.json({ attachment_id: "attachment-1", upload_url: "https://uploads.example.test/screenshot", http_method: "PUT", required_headers: { "Content-Type": "image/png" } });
    }
    if (request.url === "https://uploads.example.test/screenshot") {
      uploads++;
      assert.equal(request.method, "PUT");
      assert.deepEqual(Buffer.from(await request.arrayBuffer()), Buffer.from(png, "base64"));
      return new Response(null, { status: 200 });
    }
    if (request.url.endsWith("/chats/chat-a/messages")) {
      sends++;
      const body = await request.json() as { message: { parts: unknown[]; idempotency_key: string } };
      assert.ok(body.message.parts.some((part) => JSON.stringify(part) === JSON.stringify({ type: "media", attachment_id: "attachment-1" })));
      assert.match(body.message.idempotency_key, /^[a-f0-9]{64}$/);
      return Response.json({ message: { id: "linq-message-1" }, chat_id: "chat-a" });
    }
    throw new Error(`Unexpected test request: ${request.method} ${request.url}`);
  });

  const { adapter } = channel as unknown as { adapter: {
    createAdapterContext(input: unknown): object;
    "action.result"(data: unknown, context: unknown): Promise<void>;
  } };
  const channelContext = {
    ...adapter.createAdapterContext!({ state: { thread: null } } as never),
    thread: { id: "linq:chat-a:dm", isDM: true },
  };
  let context = freshContext("session-a");
  await contextStorage.run(context, () => adapter["action.result"]!({ result: {
    kind: "tool-result", callId: "capture-1", toolName: "kernel__browser__computer_action",
    output: { content: [{ type: "image", mimeType: "image/png", data: png }] },
  } }, channelContext as never));
  assert.equal(sends, 0, "internal browser screenshots must not be sent automatically");

  context = nextStep(context);
  const send = await contextStorage.run(context, () => sendScreenshot.execute!({ action: "send" }, toolContext("send-1")));
  assert.equal((send as { status: string }).status, "queued");
  const sendResult = { kind: "tool-result" as const, callId: "send-1", toolName: "send_browser_screenshot", output: send };
  await contextStorage.run(context, () => adapter["action.result"]!({ result: sendResult } as never, channelContext as never));

  context = nextStep(context);
  const receipt = await contextStorage.run(context, () => sendScreenshot.execute!({ action: "status" }, toolContext("status-1")));
  assert.deepEqual(receipt, { status: "sent", screenshotCallId: "capture-1", messageId: "linq-message-1" });
  await contextStorage.run(context, () => adapter["action.result"]!({ result: sendResult } as never, channelContext as never));
  assert.equal(uploads, 1);
  assert.equal(sends, 1, "replaying the send event must not post again after receipt persistence");
  await contextStorage.run(freshContext("session-b"), () => {
    assert.equal(screenshotState.get().screenshot, null, "another session must not see this screenshot");
    assert.throws(() => sendScreenshot.execute!({ action: "send" }, toolContext("send-b")), /No screenshot/);
  });
});
