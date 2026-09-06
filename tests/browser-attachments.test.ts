import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverScreenshot, extractKernelScreenshot, screenshotIdempotencyKey } from "../src/browser/attachments.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=";
const capture = { callId: "capture-1", data: png, mimeType: "image/png" as const };
const result = (output: unknown) => ({ kind: "tool-result", callId: capture.callId, toolName: "kernel__browser__computer_action", output });
const content = [{ type: "text", text: "Viewport: 1280x900" }, { type: "image", data: png, mimeType: "image/png" }];

test("captures native Kernel MCP screenshot bytes, ignoring accompanying text", () => {
  assert.deepEqual(extractKernelScreenshot(result({ content })), capture);
});

test("handles a realistic large screenshot without recursive base64 validation", () => {
  const bytes = Buffer.alloc(1024 * 1024);
  Buffer.from(png, "base64").copy(bytes);
  const data = bytes.toString("base64");
  assert.equal(extractKernelScreenshot(result({ content: [{ type: "image", mimeType: "image/png", data }] }))?.data, data);
});

test("does not accept images from unrelated tools or failed results", () => {
  assert.equal(extractKernelScreenshot({ ...result({ content }), toolName: "read_file" }), null);
  assert.equal(extractKernelScreenshot({ ...result({ content }), isError: true }), null);
  assert.equal(extractKernelScreenshot(result({ content, isError: true })), null);
});

test("rejects remote URLs, invalid bytes, oversized and unsupported images", () => {
  for (const part of [
    { type: "image", data: "https://example.com/image.png", mimeType: "image/png" },
    { type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" },
    { type: "image", data: png, mimeType: "image/svg+xml" },
    { type: "image", data: "A".repeat(14 * 1024 * 1024), mimeType: "image/png" },
  ]) assert.equal(extractKernelScreenshot(result({ content: [part] })), null);
});

test("uploads original bytes as a named attachment and returns the provider receipt", async () => {
  const receipt = await deliverScreenshot(capture, "session-a", async (message, options) => {
    assert.equal(message.files.length, 1);
    assert.equal(message.files[0].filename, "screenshot.png");
    assert.equal(message.files[0].mimeType, "image/png");
    assert.deepEqual(message.files[0].data, Buffer.from(png, "base64"));
    assert.equal(options.idempotencyKey, screenshotIdempotencyKey("session-a", capture.callId));
    return { id: "linq-message-1" };
  });
  assert.deepEqual(receipt, { status: "sent", screenshotCallId: "capture-1", messageId: "linq-message-1" });
});

test("retry uses the same idempotency key; other captures and sessions use different keys", () => {
  const key = screenshotIdempotencyKey("session-a", "capture-1");
  assert.equal(key, screenshotIdempotencyKey("session-a", "capture-1"));
  assert.notEqual(key, screenshotIdempotencyKey("session-b", "capture-1"));
  assert.notEqual(key, screenshotIdempotencyKey("session-a", "capture-2"));
});

test("upload or send failure cannot produce a successful delivery claim or leak provider errors", async () => {
  const receipt = await deliverScreenshot(capture, "session-a", async () => { throw new Error("secret upstream URL"); });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.messageId, undefined);
  assert.ok(!receipt.error?.includes("secret"));
});
