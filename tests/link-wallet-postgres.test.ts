import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../src/database/schema.js";
import { createWalletStore } from "../src/payments/wallet-store.js";
import { createWalletService } from "../src/payments/wallet-service.js";
import { decryptWallet } from "../src/payments/wallet-crypto.js";
import { walletOwner } from "../src/payments/wallet-types.js";
import { context, fakeLinkCli } from "./fixtures/link-wallet.js";
import { migrateTestDatabase } from "./fixtures/migrate-postgres.js";

test("Postgres wallets isolate users, serialize first connection, and fence stale authorization", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
  const db = drizzle(pool, { schema });
  const ids = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  t.after(async () => {
    await db.delete(schema.linkWallets).where(inArray(schema.linkWallets.principalId, ids));
    await pool.end();
  });
  await migrateTestDatabase(pool);
  await migrateTestDatabase(pool);
  let now = Date.now();
  const key = randomBytes(32), fake = fakeLinkCli(() => now), store = createWalletStore(() => db, () => key);
  const service = createWalletService({ store, cli: fake.cli, configured: () => true, now: () => now });
  const alice = context(ids[0]), bob = context(ids[1]);
  const attempts = await Promise.all(Array.from({ length: 12 }, () => service("connect", alice)));
  const aliceStarted = attempts.find(result => result.status === "awaiting_authorization")!;
  assert.ok(aliceStarted);
  assert.equal(fake.calls.filter(call => call.command === "login").length, 1);
  await service("connect", bob);
  const rows = await db.select().from(schema.linkWallets).where(inArray(schema.linkWallets.principalId, ids));
  assert.equal(rows.length, 2);
  const aliceRow = rows.find(row => row.principalId === ids[0])!;
  const stored = decryptWallet(walletOwner(alice), aliceRow.ciphertext, key);
  assert.ok(!aliceRow.ciphertext.includes(stored.auth.pendingDeviceAuth!.device_code));
  fake.approved.add(stored.auth.pendingDeviceAuth!.device_code);
  now += 10_000;
  assert.equal((await service("status", alice)).status, "connected");
  assert.equal((await service("status", bob)).status, "awaiting_authorization");
  assert.equal((await service("disconnect", alice)).status, "disconnected");
  // A new service instance represents another server/cold start.
  const restored = createWalletService({ store: createWalletStore(() => db, () => key), cli: fake.cli,
    configured: () => true, now: () => now });
  assert.equal((await restored("status", alice, aliceStarted.connectionId)).status, "superseded");
  const [after] = await db.select().from(schema.linkWallets).where(eq(schema.linkWallets.principalId, ids[0]!));
  assert.equal(decryptWallet(walletOwner(alice), after!.ciphertext, key).auth.auth, null);
  assert.equal((await restored("status", bob)).status, "awaiting_authorization");
});
