import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createLinkCli, type CliExecutor } from "../src/payments/link-cli.js";
import { emptyLinkAuth, paymentScopes } from "../src/payments/wallet-types.js";

// Runs the real pinned CLI against a local protocol fixture. No Link account,
// live token, purchase, or external network request is used.
test("pinned Link CLI: device authorization, pending/approved, refresh, verify, denial and logout", async t => {
  let mode: "pending" | "approved" | "denied" | "expired" = "pending";
  const requests: { path: string; body: URLSearchParams; authorization?: string }[] = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += chunk;
    const body = new URLSearchParams(data);
    requests.push({ path: request.url!, body, authorization: request.headers.authorization });
    let status = 200, output: unknown = {};
    if (request.url === "/device/code") output = {
      device_code: "test-private-device", user_code: "silver river", verification_uri: "https://app.link.com/verify",
      verification_uri_complete: "https://app.link.com/verify?phrase=silver-river", expires_in: 300, interval: 5,
    };
    else if (request.url === "/device/token" && body.get("grant_type") === "refresh_token") output = {
      access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer", scope: paymentScopes,
    };
    else if (request.url === "/device/token") {
      if (mode === "approved") output = {
        access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer", scope: paymentScopes,
      };
      else { status = 400; output = { error: mode === "pending" ? "authorization_pending" : mode === "denied" ? "access_denied" : "expired_token" }; }
    } else if (request.method === "GET") output = { email: "test@example.com", name: "Test User" };
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(output));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  // Endpoint overrides exist only in this test executor, never the production environment.
  const execute: CliExecutor = (executable, args, options) => new Promise(resolve => {
    execFile(executable, args, { ...options, env: { ...options.env, LINK_AUTH_BASE_URL: url, LINK_API_BASE_URL: url } },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });
  const cli = createLinkCli(execute);
  assert.deepEqual(await cli.run("status", emptyLinkAuth()), { auth: emptyLinkAuth() });
  const start = await cli.run("login", emptyLinkAuth());
  assert.equal(start.error, undefined);
  assert.equal(start.auth.pendingDeviceAuth!.device_code, "test-private-device");
  assert.equal(requests[0]!.body.get("scope"), paymentScopes);
  const pending = await cli.run("status", start.auth);
  assert.equal(pending.error, undefined);
  assert.equal(pending.auth.auth, null);
  mode = "approved";
  const approved = await cli.run("status", pending.auth);
  assert.equal(approved.auth.pendingDeviceAuth, null);
  assert.equal(approved.auth.auth!.access_token, "private-access");
  const verified = await cli.run("verify", approved.auth);
  assert.equal(verified.error, undefined);
  assert.equal(requests.at(-1)!.authorization, "Bearer private-access");
  const expiredAccess = { ...verified.auth, auth: { ...verified.auth.auth!, expires_at: 1 } };
  const refreshed = await cli.run("verify", expiredAccess);
  assert.equal(refreshed.error, undefined);
  assert.equal(refreshed.auth.auth!.refresh_token, "rotated-refresh");
  assert.equal(requests.at(-1)!.authorization, "Bearer refreshed-access");
  const disconnected = await cli.run("logout", refreshed.auth);
  assert.deepEqual(disconnected, { auth: emptyLinkAuth() });
  assert.equal(requests.at(-1)!.path, "/device/revoke");
  assert.equal(requests.at(-1)!.body.get("token"), "rotated-refresh");
  for (const value of ["denied", "expired"] as const) {
    mode = value;
    const result = await cli.run("status", start.auth);
    assert.equal(result.error, value);
  }
  assert.ok(requests.every(request => !request.path.includes("spend")));
});
