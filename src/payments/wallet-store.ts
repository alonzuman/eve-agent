import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDatabase, type Database } from "../database/postgres.js";
import { linkWallets } from "../database/schema.js";
import { decryptWallet, encryptWallet, walletEncryptionKey } from "./wallet-crypto.js";
import type { WalletOwner, WalletRecord, WalletStatus } from "./wallet-types.js";

export interface WalletStore {
  update(owner: WalletOwner, change: (record: WalletRecord | null) => Promise<{
    record: WalletRecord; result: WalletStatus;
  }>): Promise<WalletStatus>;
}

export function createWalletStore(database: () => Database = getDatabase, key = walletEncryptionKey): WalletStore {
  return {
    async update(owner, change) {
      return withWallet(owner, change, database, key);
    },
  };
}

/** Server-only critical section shared by wallet refresh, disconnect and spending. */
export async function withWallet<T>(owner: WalletOwner, change: (record: WalletRecord | null) => Promise<{
  record: WalletRecord; result: T;
}>, database: () => Database = getDatabase, key = walletEncryptionKey): Promise<T | { status: "busy" }> {
  const encryptionKey = key();
  const lock = createHash("sha256").update(JSON.stringify(["link-wallet", owner.namespace, owner.principalId])).digest().readBigInt64BE();
  return database().transaction(async tx => {
    // Cross-instance lock also covers the first connection and refresh-token rotation.
    // Try rather than queue so multiple polling workflows cannot exhaust the pool.
    const acquired = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(${lock.toString()}::bigint) as acquired`);
    if (!acquired.rows[0]?.acquired) return { status: "busy" };
    const where = and(eq(linkWallets.namespace, owner.namespace), eq(linkWallets.principalId, owner.principalId));
    const [row] = await tx.select().from(linkWallets).where(where);
    const current = row ? decryptWallet(owner, row.ciphertext, encryptionKey) : null;
    const { record, result } = await change(current);
    const ciphertext = encryptWallet(owner, record, encryptionKey);
    await tx.insert(linkWallets).values({ ...owner, ciphertext }).onConflictDoUpdate({
      target: [linkWallets.namespace, linkWallets.principalId],
      set: { ciphertext, updatedAt: new Date() },
    });
    return result;
  });
}

export const walletStore = createWalletStore();
