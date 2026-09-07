import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createWalletService } from "../src/payments/wallet-service.js";
import { createLinkCli } from "../src/payments/link-cli.js";
import { decryptWallet, encryptWallet } from "../src/payments/wallet-crypto.js";
import { emptyLinkAuth, linkVerificationUrl, walletOwner } from "../src/payments/wallet-types.js";
import statusTool from "../agent/tools/link_wallet_status.js";
import disconnectTool from "../agent/tools/disconnect_link_wallet.js";
import { context, fakeLinkCli, memoryWalletStore } from "./fixtures/link-wallet.js";

function setup() {
  let now = 100_000;
  const memory = memoryWalletStore(), fake = fakeLinkCli(() => now);
  const service = createWalletService({ store: memory.store, cli: fake.cli, now: () => now, configured: () => true });
  return { ...memory, ...fake, service, advance: (ms = 10_000) => { now += ms; } };
}

test("two users connect independently, reuse their pending flow, and keep tokens out of results", async () => {
  const s = setup(), alice = context(), bob = context("b".repeat(64));
  const first = await s.service("connect", alice), second = await s.service("connect", bob);
  assert.notEqual(first.verificationUrl, second.verificationUrl);
  assert.deepEqual(await s.service("connect", alice), first);
  const aliceRecord = s.rows.get(JSON.stringify(walletOwner(alice)))!;
  s.approved.add(aliceRecord.auth.pendingDeviceAuth!.device_code);
  s.advance();
  const connected = await s.service("status", alice);
  assert.equal(connected.status, "connected");
  assert.equal((await s.service("status", bob)).status, "awaiting_authorization");
  assert.equal(s.calls.filter(call => call.command === "login").length, 2);
  assert.ok(!JSON.stringify(connected).includes("secret"));
  assert.deepEqual(Object.keys(connected).sort(), ["connectionId", "status"]);
  assert.equal((await s.service("connect", alice)).status, "connected");
  assert.equal(s.calls.filter(call => call.command === "verify").length, 1);
});

test("unverified, local-dev and mismatched identities never reach the store or CLI", async () => {
  const s = setup();
  for (const auth of [null,
    { ...context().session.auth.current, authenticator: "local-dev" },
    { ...context().session.auth.current, principalType: "service" },
    { ...context().session.auth.current, principalId: "user supplied id" },
  ]) {
    await assert.rejects(s.service("connect", { session: { auth: { current: auth, initiator: auth } } }));
  }
  await assert.rejects(s.service("connect", { session: { auth: {
    current: context().session.auth.current, initiator: context("b".repeat(64)).session.auth.current,
  } } }));
  assert.equal(s.rows.size, 0);
  assert.equal(s.calls.length, 0);
  for (const tool of [statusTool, disconnectTool]) {
    assert.equal((tool.inputSchema as unknown as { safeParse: (x: unknown) => { success: boolean } }).safeParse({ userId: "alice" }).success, false);
  }
});

test("disconnect removes credentials and fences an old watcher across reconnect", async () => {
  const s = setup(), ctx = context();
  const started = await s.service("connect", ctx);
  const code = [...s.rows.values()][0]!.auth.pendingDeviceAuth!.device_code;
  assert.equal((await s.service("disconnect", ctx)).status, "disconnected");
  s.approved.add(code);
  s.advance();
  const before = s.calls.length;
  assert.equal((await s.service("status", ctx, started.connectionId)).status, "superseded");
  assert.equal(s.calls.length, before);
  const replacement = await s.service("connect", ctx);
  assert.notEqual(replacement.connectionId, started.connectionId);
  assert.equal((await s.service("status", ctx, started.connectionId)).status, "superseded");
  assert.notEqual([...s.rows.values()][0]!.auth.pendingDeviceAuth!.device_code, code);
});

test("expiry stops polling without automatically starting another login", async () => {
  const s = setup();
  await s.service("connect", context());
  s.advance(400_000);
  const before = s.calls.length;
  assert.equal((await s.service("status", context())).status, "expired");
  assert.equal((await s.service("status", context())).status, "expired");
  assert.equal(s.calls.length, before);
  assert.equal((await s.service("connect", context())).status, "awaiting_authorization");
});

test("denial clears the pending flow and unexpected errors stay private", async () => {
  const s = setup();
  await s.service("connect", context());
  const service = createWalletService({ store: s.store, configured: () => true, now: () => 200_000,
    cli: { run: async (_command, auth) => ({ auth, error: "denied" }) } });
  assert.equal((await service("status", context())).status, "denied");
  assert.equal([...s.rows.values()][0]!.auth.pendingDeviceAuth, null);
  const failing = createWalletService({ store: { update: async () => { throw new Error("secret-access-token"); } },
    configured: () => true, now: Date.now, cli: s.cli });
  assert.deepEqual(await failing("connect", context()), { status: "unavailable" });
});

test("refresh changes are persisted even when verification fails, and reconnect upgrades the grant", async () => {
  const s = setup();
  await s.service("connect", context());
  s.approved.add([...s.rows.values()][0]!.auth.pendingDeviceAuth!.device_code);
  s.advance();
  await s.service("status", context());
  let now = 300_000;
  const commands: string[] = [];
  const service = createWalletService({ store: s.store, configured: () => true, now: () => now,
    cli: { async run(command, auth) {
      commands.push(command);
      if (command === "verify") return { auth: { ...auth, auth: { ...auth.auth!, refresh_token: "rotated-secret" } }, error: "needs_reconnection" };
      return s.cli.run(command, auth);
    } } });
  assert.equal((await service("status", context())).status, "needs_reconnection");
  assert.equal([...s.rows.values()][0]!.auth.auth!.refresh_token, "rotated-secret");
  now += 10_000;
  assert.equal((await service("connect", context())).status, "awaiting_authorization");
  assert.ok(commands.includes("upgrade"));
});

test("missing reported scope requires renewal rather than claiming wallet access", async () => {
  const s = setup();
  await s.service("connect", context());
  s.approved.add([...s.rows.values()][0]!.auth.pendingDeviceAuth!.device_code);
  s.advance();
  await s.service("status", context());
  const row = [...s.rows.values()][0]!;
  delete row.auth.auth!.scope;
  s.advance(70_000);
  assert.equal((await s.service("status", context())).status, "needs_reconnection");
  assert.equal((await s.service("connect", context())).status, "awaiting_authorization");
  assert.equal(s.calls.at(-1)?.command, "upgrade");
});

test("encryption binds credentials to user and environment and rejects tampering", async () => {
  const s = setup(), owner = walletOwner(context()), key = randomBytes(32);
  await s.service("connect", context());
  const record = [...s.rows.values()][0]!;
  const encrypted = encryptWallet(owner, record, key);
  assert.ok(!encrypted.includes(record.auth.pendingDeviceAuth!.device_code));
  assert.deepEqual(decryptWallet(owner, encrypted, key), record);
  for (const wrong of [{ ...owner, principalId: "b".repeat(64) }, { ...owner, namespace: "c".repeat(64) }]) {
    assert.throws(() => decryptWallet(wrong, encrypted, key), /Unable to open/);
  }
  assert.throws(() => decryptWallet(owner, encrypted, randomBytes(32)), /Unable to open/);
  assert.throws(() => decryptWallet(owner, encrypted.slice(0, -10) + "tampered", key), /Unable to open/);
  assert.notEqual(encryptWallet(owner, record, key), encrypted);
});

test("only HTTPS app.link.com authorization URLs can reach the conversation", () => {
  for (const url of ["http://app.link.com/x", "https://app.link.com.evil.com", "https://app.link.com@evil.com", "https://evil@app.link.com", "https://app.link.com:444/x", "javascript:alert(1)"]) {
    assert.throws(() => linkVerificationUrl(url));
  }
  assert.equal(linkVerificationUrl("https://app.link.com/authorize?a=1&b=2"), "https://app.link.com/authorize?a=1&b=2");
});

test("CLI uses a private per-call file, a fixed executable, a minimal environment, and removes files", async () => {
  let authPath = "";
  const cli = createLinkCli(async (executable, args, options) => {
    assert.equal(executable, process.execPath);
    authPath = args[args.indexOf("--auth") + 1]!;
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(authPath))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), emptyLinkAuth());
    assert.deepEqual(Object.keys(options.env!).sort(), ["DO_NOT_TRACK", "HOME", "NO_UPDATE_NOTIFIER", "TMPDIR", "XDG_CONFIG_HOME"]);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.ok(!args.includes("--verbose"));
    return { ok: true, stdout: JSON.stringify([{ authenticated: false, access_token: "secret-preview", credentials_path: authPath }]) };
  });
  assert.deepEqual(await cli.run("status", emptyLinkAuth()), { auth: emptyLinkAuth() });
  await assert.rejects(access(dirname(authPath)));
});

test("CLI error diagnostics are discarded while rotated auth files survive", async () => {
  let path = "";
  const cli = createLinkCli(async (_exe, args) => {
    path = args[args.indexOf("--auth") + 1]!;
    const auth = { auth: { access_token: "private-token", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" }, pendingDeviceAuth: null };
    await writeFile(path, JSON.stringify(auth));
    return { ok: false, stdout: JSON.stringify({ error: { code: "UNKNOWN", message: "secret diagnostic" } }) };
  });
  const result = await cli.run("verify", emptyLinkAuth());
  assert.equal(result.auth.auth!.refresh_token, "new-refresh");
  assert.equal(result.error, "unavailable");
  assert.ok(!JSON.stringify(result).includes("diagnostic"));
  await assert.rejects(access(dirname(path)));
});
