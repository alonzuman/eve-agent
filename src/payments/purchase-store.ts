import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, type Database } from "../database/postgres.js";
import { linkPurchases } from "../database/schema.js";
import { walletEncryptionKey } from "./wallet-crypto.js";
import type { WalletOwner } from "./wallet-types.js";

export const purchaseSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(), mode: z.literal("test"),
  connectionId: z.string().uuid(),
  phase: z.enum(["preparing", "ready", "creating", "created", "requesting_approval", "pending_approval", "approved", "submitting", "succeeded", "denied", "expired", "canceled", "failed", "requires_action", "unknown"]),
  checkoutId: z.string().optional(), spendId: z.string().optional(), approvalUrl: z.string().optional(),
  cancelRequested: z.boolean().default(false), createdAt: z.number(),
  cancellationKind: z.enum(["local_only", "link_revoked"]).optional(),
});
export type Purchase = z.infer<typeof purchaseSchema>;
export const terminalPurchase = (p: Purchase) => ["succeeded", "denied", "expired", "canceled", "failed"].includes(p.phase);

export function sealPurchase(owner: WalletOwner, purchase: Purchase, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["eve-link-purchase", owner.namespace, owner.principalId, purchase.id, purchase.revision])));
  const body = Buffer.concat([cipher.update(JSON.stringify(purchaseSchema.parse(purchase))), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
export function openPurchase(owner: WalletOwner, row: { id: string; revision: number; ciphertext: string }, key: Buffer): Purchase {
  try {
    const [version, iv, tag, body, extra] = row.ciphertext.split(".");
    if (version !== "v1" || !iv || !tag || !body || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify(["eve-link-purchase", owner.namespace, owner.principalId, row.id, row.revision])));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const p = purchaseSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString()));
    if (p.id !== row.id || p.revision !== row.revision) throw new Error();
    return p;
  } catch { throw new Error("Unable to open this user's purchase."); }
}

export function createPurchaseStore(database: () => Database = getDatabase, key = walletEncryptionKey) {
  const where = (owner: WalletOwner) => and(eq(linkPurchases.namespace, owner.namespace), eq(linkPurchases.principalId, owner.principalId));
  return {
    async start(owner: WalletOwner, callId: string, connectionId: string): Promise<Purchase> {
      const callKey = createHash("sha256").update(callId).digest("hex");
      return database().transaction(async tx => {
        const lock = createHash("sha256").update(JSON.stringify(["link-purchase", owner])).digest().readBigInt64BE();
        await tx.execute(sql`select pg_advisory_xact_lock(${lock.toString()}::bigint)`);
        const rows = await tx.select().from(linkPurchases).where(where(owner));
        const same = rows.find(r => r.callKey === callKey);
        if (same) return openPurchase(owner, same, key());
        // Separate calls cannot start another checkout while an outcome is unresolved.
        const active = rows.map(r => openPurchase(owner, r, key())).find(p => !terminalPurchase(p));
        if (active) return active;
        const p: Purchase = { id: randomUUID(), revision: 0, mode: "test", connectionId,
          phase: "preparing", cancelRequested: false, createdAt: Date.now() };
        await tx.insert(linkPurchases).values({ ...owner, id: p.id, callKey, ciphertext: sealPurchase(owner, p, key()) });
        return p;
      });
    },
    async get(owner: WalletOwner, id: string): Promise<Purchase | null> {
      const [row] = await database().select().from(linkPurchases).where(and(where(owner), eq(linkPurchases.id, id)));
      return row ? openPurchase(owner, row, key()) : null;
    },
    async save(owner: WalletOwner, previous: Purchase, patch: Partial<Pick<Purchase, "phase" | "checkoutId" | "spendId" | "approvalUrl" | "cancelRequested" | "cancellationKind">>): Promise<Purchase | null> {
      const next = purchaseSchema.parse({ ...previous, ...patch, revision: previous.revision + 1 });
      const rows = await database().update(linkPurchases).set({ revision: next.revision, ciphertext: sealPurchase(owner, next, key()) })
        .where(and(where(owner), eq(linkPurchases.id, previous.id), eq(linkPurchases.revision, previous.revision))).returning({ id: linkPurchases.id });
      return rows.length ? next : null;
    },
  };
}
export const purchaseStore = createPurchaseStore();
