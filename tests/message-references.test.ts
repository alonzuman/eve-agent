import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundMessageParts, messageNamespace, renderMessageReferences } from "../src/messaging/message-references.js";
import { reactionEmojiSchema, reactionPayload } from "../src/messaging/linq-message-actions.js";

test("inbound references preserve multipart indexes and reply parents without retaining attachment URLs", () => {
  const parts = inboundMessageParts({ id: "incoming", raw: {
    parts: [{ type: "text", value: "this one?" }, { type: "media", url: "https://private.example/image" }],
    reply_to: { message_id: "parent", part_index: 2 },
  } });
  assert.deepEqual(parts.map(part => [part.partIndex, part.content]), [[0, "this one?"], [1, "[media attachment]"]]);
  assert.deepEqual(parts[1]!.replyTo, { messageId: "parent", partIndex: 2 });
  assert.ok(!JSON.stringify(parts).includes("https://"));
  const rendered = JSON.parse(renderMessageReferences([
    { ...parts[0]!, ref: "m2" }, { ...parts[0]!, ref: "m1", messageId: "parent", partIndex: 2, replyTo: null },
  ]));
  assert.equal(rendered[0].replyTo, "m1");
  assert.ok(!("messageId" in rendered[0]));
});

test("message namespaces isolate projects, environments and preview branches", () => {
  const base = { VERCEL_PROJECT_ID: "project", VERCEL_ENV: "production" };
  const production = messageNamespace(base);
  assert.equal(production, messageNamespace({ ...base, VERCEL_GIT_COMMIT_REF: "main" }));
  for (const env of [
    { ...base, VERCEL_PROJECT_ID: "other" }, { ...base, VERCEL_ENV: "development" },
    { ...base, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" },
  ]) assert.notEqual(production, messageNamespace(env));
  assert.notEqual(messageNamespace({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "a" }),
    messageNamespace({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "b" }));
});

test("reactions validate one Unicode sequence and distinguish tapbacks from custom emoji", () => {
  for (const emoji of ["❤️", "👍🏽", "🇺🇸", "👨‍👩‍👧‍👦", "1️⃣", "🎉", "❤", "‼️"]) assert.equal(reactionEmojiSchema.parse(emoji), emoji);
  for (const invalid of ["", "heart", ":heart:", "hello", "👍👍", "a🎉", " "]) assert.equal(reactionEmojiSchema.safeParse(invalid).success, false);
  assert.deepEqual(reactionPayload("❤️", 2), { operation: "add", part_index: 2, type: "love" });
  assert.deepEqual(reactionPayload("👍🏽", 1), { operation: "add", part_index: 1, type: "custom", custom_emoji: "👍🏽" });
});
