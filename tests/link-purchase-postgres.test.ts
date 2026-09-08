import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { inArray } from "drizzle-orm";
import * as schema from "../src/database/schema.js";
import { createPurchaseStore, openPurchase, sealPurchase, type Purchase } from "../src/payments/purchase-store.js";
import { createPurchaseService } from "../src/payments/purchase-service.js";
import { withWallet, createWalletStore } from "../src/payments/wallet-store.js";
import { runSpend, type PaymentCard } from "../src/payments/link-spend.js";
import { paymentScopes, walletOwner } from "../src/payments/wallet-types.js";
import { context } from "./fixtures/link-wallet.js";
import { migrateTestDatabase } from "./fixtures/migrate-postgres.js";

test("purchase ciphertext binds owner, purchase reference and revision", () => {
  const owner = { namespace: "a".repeat(64), principalId: "b".repeat(64) }, key = randomBytes(32);
  const p: Purchase = { id: randomUUID(), revision: 0, mode: "test", connectionId: randomUUID(), phase: "pending_approval",
    cancelRequested: false, approvalUrl: "https://app.link.com/private-approval", createdAt: Date.now() };
  const row = { id: p.id, revision: p.revision, ciphertext: sealPurchase(owner, p, key) };
  assert.ok(!row.ciphertext.includes("private-approval"));
  assert.deepEqual(openPurchase(owner, row, key), p);
  assert.throws(() => openPurchase({ ...owner, principalId: "c".repeat(64) }, row, key));
  assert.throws(() => openPurchase(owner, { ...row, id: randomUUID() }, key));
  assert.throws(() => openPurchase(owner, { ...row, revision: 1 }, key));
});

test("Postgres purchases: user isolation, replay, concurrent execution, cancellation, disconnect, ambiguous submission", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12 });
  const db = drizzle(pool, { schema });
  const key = randomBytes(32);
  const ids = Array.from({ length: 6 }, () => randomBytes(32).toString("hex"));
  t.after(async () => {
    await db.delete(schema.linkPurchases).where(inArray(schema.linkPurchases.principalId, ids));
    await db.delete(schema.linkWallets).where(inArray(schema.linkWallets.principalId, ids));
    await pool.end();
  });
  await migrateTestDatabase(pool);
  const wallets = createWalletStore(() => db, () => key), store = createPurchaseStore(() => db, () => key);
  for (const id of ids) await wallets.update(walletOwner(context(id)), async () => ({
    record: { version: 1, connectionId: randomUUID(), status: "connected", nextCheckAt: 0,
      auth: { pendingDeviceAuth: null, auth: { access_token: `access-${id}`, refresh_token: `refresh-${id}`,
        expires_in: 3600, token_type: "Bearer", scope: paymentScopes } } }, result: { status: "connected" },
  }));
  let approval = false, payments = 0, creations = 0, cancellations = 0, ambiguous = false;
  const paid = new Set<string>();
  const card: PaymentCard = { number: "4242424242424242", cvc: "123", exp_month: 12, exp_year: 2030,
    valid_until: Date.now(), billing_address: { name: "Test", country: "US", postal_code: "10001" } };
  const fakeSpend: typeof runSpend = async (auth, command, consume) => {
    assert.ok(auth.auth?.access_token.startsWith("access-"));
    if (command.action === "create") { creations++; return { auth, spend: { id: `spr_${command.purchaseId}`, status: "created" } }; }
    if (command.action === "approval") return { auth, spend: { id: command.id, status: "pending_approval", approval_url: "https://app.link.com/approve/test" } };
    if (command.action === "cancel") { cancellations++; return { auth, spend: { id: command.id, status: "canceled" } }; }
    if (command.action === "pay") {
      try { return { auth, receipt: await consume!(card) }; } catch { return { auth, error: "unavailable" }; }
    }
    return { auth, spend: { id: command.id, status: approval ? "approved" : "pending_approval" } };
  };
  const deps = {
    purchaseStore: store, withWallet: ((owner, change) => withWallet(owner, change, () => db, () => key)) as typeof withWallet,
    runSpend: fakeSpend, configured: () => true,
    createTestCheckout: async (id: string) => `cs_test_${id}`, inspectTestCheckout: async () => {},
    testCheckoutStatus: async (id: string) => paid.has(id) ? "paid" as const : "open" as const,
    payTestCheckout: async (_owner: unknown, id: string) => { payments++; paid.add(id); if (ambiguous) throw new Error("lost response"); return "paid" as const; },
  };
  const service = createPurchaseService(deps);
  const alice = context(ids[0]), bob = context(ids[1]);
  const start = await service.startTestPurchase(alice, "one-call");
  assert.ok(start.purchaseId);
  const id = start.purchaseId!;
  assert.equal((await service.startTestPurchase(alice, "one-call")).purchaseId, id);
  assert.equal((await service.startTestPurchase(alice, "different-call")).purchaseId, id);
  assert.equal((await service.advanceTestPurchase(bob, id)).status, "not_found");
  assert.equal((await service.cancelTestPurchase(bob, id)).status, "not_found");
  assert.equal(await store.get(walletOwner(bob), id), null);
  for (const expected of ["ready", "created", "pending_approval", "pending_approval"]) {
    assert.equal((await service.advanceTestPurchase(alice, id)).status, expected);
  }
  assert.equal(creations, 1); assert.equal(payments, 0);
  approval = true;
  await Promise.all(Array.from({ length: 8 }, () => service.advanceTestPurchase(alice, id)));
  assert.equal((await service.advanceTestPurchase(alice, id)).status, "succeeded");
  assert.equal(payments, 1);
  assert.equal((await service.startTestPurchase(alice, "one-call")).purchaseId, id, "replayed creation cannot start again after completion");
  assert.equal((await service.cancelTestPurchase(alice, id)).status, "succeeded");

  approval = false;
  const pending = await service.startTestPurchase(bob, "cancel-call");
  for (let i = 0; i < 3; i++) await service.advanceTestPurchase(bob, pending.purchaseId!);
  assert.equal((await service.cancelTestPurchase(bob, pending.purchaseId!)).status, "canceled");
  approval = true;
  assert.equal((await service.advanceTestPurchase(bob, pending.purchaseId!)).status, "canceled");
  assert.equal(cancellations, 1); assert.equal(payments, 1);

  const disconnected = context(ids[2]);
  const old = await service.startTestPurchase(disconnected, "old-wallet");
  await wallets.update(walletOwner(disconnected), async wallet => ({ record: { ...wallet!, connectionId: randomUUID() }, result: { status: "connected" } }));
  assert.equal((await service.advanceTestPurchase(disconnected, old.purchaseId!)).status, "wallet_changed");
  assert.equal(payments, 1);
  assert.equal((await service.cancelTestPurchase(disconnected, old.purchaseId!)).status, "canceled_locally");
  assert.equal((await service.advanceTestPurchase(disconnected, old.purchaseId!)).status, "canceled_locally");
  assert.notEqual((await service.startTestPurchase(disconnected, "new-wallet")).purchaseId, old.purchaseId);

  const interrupted = context(ids[3]);
  const stopped = await service.startTestPurchase(interrupted, "interrupted-call");
  await service.advanceTestPurchase(interrupted, stopped.purchaseId!);
  const prepared = (await store.get(walletOwner(interrupted), stopped.purchaseId!))!;
  await store.save(walletOwner(interrupted), prepared, { phase: "submitting" });
  const restarted = createPurchaseService(deps);
  assert.equal((await restarted.advanceTestPurchase(interrupted, stopped.purchaseId!)).status, "unknown");
  assert.equal((await restarted.startTestPurchase(interrupted, "replacement-call")).purchaseId, stopped.purchaseId);
  assert.equal(payments, 1, "a committed submission is never executed again after restart");

  const lost = context(ids[4]);
  const lostStart = await service.startTestPurchase(lost, "lost-response");
  for (let i = 0; i < 3; i++) await service.advanceTestPurchase(lost, lostStart.purchaseId!);
  ambiguous = true;
  assert.equal((await service.advanceTestPurchase(lost, lostStart.purchaseId!)).status, "unknown");
  assert.equal((await restarted.advanceTestPurchase(lost, lostStart.purchaseId!)).status, "succeeded");
  assert.equal(payments, 2, "merchant API reconciles success without a second submission");
  const rows = await db.select().from(schema.linkPurchases).where(inArray(schema.linkPurchases.principalId, ids));
  assert.ok(rows.every(row => !row.ciphertext.includes("access-") && !row.ciphertext.includes("app.link.com")));
});
