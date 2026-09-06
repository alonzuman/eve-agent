import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserOperation, browserScopeName, userBrowser } from "../src/browser/sandbox.js";

const runId = randomUUID();
const users = [`browser-eval-a-${runId}`, `browser-eval-b-${runId}`];
assert.notEqual(browserScopeName(users[0]), browserScopeName(users[1]));
const sandboxes = [];
try {
  for (const user of users) sandboxes.push(await userBrowser(user));
  const first = await browserOperation(users[0], "navigate-a", { action: "navigate", url: "https://example.com" });
  assert.equal(first.title, "Example Domain");
  const second = await browserOperation(users[1], "navigate-b", { action: "navigate", url: "https://example.org" });
  assert.equal(second.title, "Example Domain");
  const firstAgain = await browserOperation(users[0], "read-a", { action: "read" });
  assert.equal(new URL(firstAgain.url!).hostname, "example.com");
  assert.equal(new URL(second.url!).hostname, "example.org");
  const repeat = await browserOperation(users[0], "navigate-a", { action: "navigate", url: "https://example.org" });
  assert.deepEqual(repeat, first, "An existing operation receipt must prevent re-execution.");
  const screenshot = await browserOperation(users[0], "screenshot-a", { action: "screenshot" });
  assert.ok(screenshot.screenshotBase64 && screenshot.screenshotBase64.length > 1000);
  for (const sandbox of sandboxes) {
    const control = await sandbox.runCommand("node", ["-e", "fetch('http://127.0.0.1:8787/operation',{method:'POST',body:JSON.stringify({operationId:'unauthorized',action:'read'})}).then(r=>console.log(r.status))"]);
    assert.equal((await control.stdout()).trim(), "403", "Untrusted pages cannot control the browser.");
    const secrets = await sandbox.runCommand("node", ["-e", "console.log(Boolean(process.env.BLOB_READ_WRITE_TOKEN||process.env.LINQ_API_TOKEN||process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_TOKEN))"]);
    assert.equal((await secrets.stdout()).trim(), "false", "Application credentials must stay out of the browser VM.");
  }
  console.log("PASS: two private browser contexts, read/navigation/screenshots, retry receipts, authenticated control, and application credential isolation.");
} finally {
  for (const sandbox of sandboxes) await sandbox.delete().catch(() => sandbox.stop());
}
