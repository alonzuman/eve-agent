import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runSpend, testQuote } from "../src/payments/link-spend.js";
import { paymentScopes, type LinkAuth } from "../src/payments/wallet-types.js";
import type { CliExecutor } from "../src/payments/link-cli.js";

test("real pinned CLI creates test-only spend, relays approval, and confines card data to a private callback", async t => {
  const id = "spr_test_fixture";
  const card = { number: "4242424242424242", cvc: "123", exp_month: 12, exp_year: 2030,
    valid_until: Math.floor(Date.now() / 1000) + 3600, billing_address: { name: "Sandbox Test", postal_code: "10001", country: "US" } };
  let phase = "created";
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: req.method!, path: req.url!, body });
    let output: unknown;
    if (req.url?.endsWith("/request_approval")) { phase = "pending_approval"; output = { id, approval_link: "https://app.link.com/approve/test" }; }
    else {
      if (req.url?.endsWith("/cancel")) phase = "canceled";
      output = { id, status: phase, amount: 500, currency: "usd", merchant_url: testQuote.merchantUrl,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        ...(req.url?.includes("include") ? { card } : {}) };
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(output));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const directories: string[] = [];
  const run: CliExecutor = async (executable, args, options) => {
    const dir = String(options.cwd); directories.push(dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const authPath = args[args.indexOf("--auth") + 1]!;
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.ok((await readFile(authPath, "utf8")).includes("test-access"));
    assert.deepEqual(Object.keys(options.env!).sort(), ["DO_NOT_TRACK", "HOME", "NO_UPDATE_NOTIFIER", "TMPDIR", "XDG_CONFIG_HOME"]);
    assert.ok(!args.includes("--approve"));
    return new Promise(resolve => execFile(executable, args, { ...options,
      env: { ...options.env, LINK_API_BASE_URL: url, LINK_AUTH_BASE_URL: url } },
    (error, stdout) => resolve({ ok: !error, stdout: String(stdout) })));
  };
  const auth: LinkAuth = { pendingDeviceAuth: null, auth: { access_token: "test-access", refresh_token: "test-refresh",
    expires_at: Date.now() + 3_600_000, expires_in: 3600, token_type: "Bearer", scope: paymentScopes } };
  const purchaseId = randomUUID();
  const created = await runSpend(auth, { action: "create", purchaseId }, undefined, run);
  assert.equal(created.error, undefined);
  assert.equal(created.spend?.status, "created");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.body.test, true);
  assert.equal(requests[0]!.body.amount, 500);
  assert.equal(requests[0]!.body.approve, undefined);
  assert.notEqual(requests[0]!.body.request_approval, true);
  assert.equal(requests[0]!.body.metadata.eve_purchase_id, purchaseId);
  const approval = await runSpend(auth, { action: "approval", id }, undefined, run);
  assert.equal(approval.spend?.approval_url, "https://app.link.com/approve/test");
  assert.equal((await runSpend(auth, { action: "retrieve", id }, undefined, run)).spend?.status, "pending_approval");
  let consumed = 0;
  const consume = async (value: typeof card) => { assert.deepEqual(value, card); consumed++; return "paid" as const; };
  assert.equal((await runSpend(auth, { action: "pay", id }, consume, run)).error, "unavailable");
  assert.equal(consumed, 0);
  phase = "approved";
  const paid = await runSpend(auth, { action: "pay", id }, consume, run);
  assert.equal(paid.receipt, "paid");
  assert.equal(consumed, 1);
  assert.ok(!JSON.stringify(paid).includes(card.number));
  assert.ok(!JSON.stringify(paid).includes("card_output_file"));
  const failed = await runSpend(auth, { action: "pay", id }, async () => { throw new Error(card.number); }, run);
  assert.equal(failed.error, "unavailable");
  assert.ok(!JSON.stringify(failed).includes(card.number));
  assert.equal((await runSpend(auth, { action: "cancel", id }, undefined, run)).spend?.status, "canceled");
  for (const dir of directories) await assert.rejects(stat(dir));
});
