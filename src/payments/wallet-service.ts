import { randomUUID } from "node:crypto";
import { linkCli, type LinkCli } from "./link-cli.js";
import { walletStore, type WalletStore } from "./wallet-store.js";
import {
  emptyLinkAuth, hasPaymentScopes, publicWalletStatus, walletOwner,
  type WalletRecord, type WalletStatus,
} from "./wallet-types.js";
import type { UserScopedContext } from "../identity/user-scope.js";

type Operation = "connect" | "status" | "disconnect";
export interface WalletDependencies { store: WalletStore; cli: LinkCli; now: () => number; configured: () => boolean }
const defaults: WalletDependencies = {
  store: walletStore, cli: linkCli, now: Date.now,
  configured: () => /^[a-fA-F0-9]{64}$/.test(process.env.LINK_WALLET_ENCRYPTION_KEY ?? "") && Boolean(process.env.DATABASE_URL),
};

export function createWalletService(deps: WalletDependencies = defaults) {
  return async (operation: Operation, ctx: UserScopedContext, expectedConnectionId?: string): Promise<WalletStatus> => {
    // Authorize before touching storage or launching a process. Local/dev, groups,
    // service principals and delegated identities cannot select a wallet.
    const owner = walletOwner(ctx);
    if (!deps.configured()) return { status: "not_configured" };
    try {
      return await deps.store.update(owner, async stored => {
        const now = deps.now();
        let record: WalletRecord = stored ?? {
          version: 1, connectionId: randomUUID(), auth: emptyLinkAuth(), status: "disconnected", nextCheckAt: 0,
        };
        const result = (status?: WalletStatus) => ({ record, result: status ?? publicWalletStatus(record, now) });
        if (expectedConnectionId && expectedConnectionId !== record.connectionId) return result({ status: "superseded" });
        if (operation === "disconnect") {
          // Serialize with polling. Fence all old workflows even if Link revocation fails.
          // CLI revocation is best-effort: only local disconnection is promised.
          const checked = await deps.cli.run("status", record.auth);
          await deps.cli.run("logout", checked.auth);
          record = { version: 1, connectionId: randomUUID(), auth: emptyLinkAuth(), status: "disconnected", nextCheckAt: 0 };
          return result();
        }
        const pending = record.auth.pendingDeviceAuth;
        if (pending && now >= pending.expires_at) {
          record = { ...record, status: "expired", auth: { ...record.auth, pendingDeviceAuth: null }, nextCheckAt: 0 };
          // An explicit later connect starts a new flow; a polling run never does.
          if (operation === "status") return result();
        }
        if (now < record.nextCheckAt && (record.status === "awaiting_authorization" || record.status === "connected")) {
          return result();
        }
        if (operation === "status" && !record.auth.auth && !record.auth.pendingDeviceAuth) return result();

        const checked = await deps.cli.run("status", record.auth);
        record = { ...record, auth: checked.auth, nextCheckAt: now + Math.max(5, checked.auth.pendingDeviceAuth?.interval ?? 5) * 1000 };
        if (checked.error) {
          if (checked.error === "unavailable") {
            record.nextCheckAt = 0;
            return result({ status: "unavailable" });
          }
          record.status = checked.error;
          record.auth.pendingDeviceAuth = null;
          return result();
        }
        if (record.auth.pendingDeviceAuth) {
          record.status = "awaiting_authorization";
          return result();
        }
        if (record.auth.auth && !(operation === "connect" && record.status === "needs_reconnection")) {
          // auth status checks local storage only. This read validates the grant
          // with Link and refreshes expired tokens within the same owner lock.
          const verified = await deps.cli.run("verify", record.auth);
          record.auth = verified.auth;
          if (verified.error) {
            if (verified.error === "unavailable") {
              record.nextCheckAt = 0;
              return result({ status: "unavailable" });
            }
            record.status = "needs_reconnection";
            return result();
          }
          if (hasPaymentScopes(record.auth)) {
            record.status = "connected";
            record.nextCheckAt = now + 60_000;
            return result();
          }
          record.status = "needs_reconnection";
          if (operation === "status") return result();
        }
        if (operation === "connect") {
          const started = await deps.cli.run(record.auth.auth ? "upgrade" : "login", record.auth);
          record = { ...record, connectionId: randomUUID(), auth: started.auth, nextCheckAt: now + Math.max(5, started.auth.pendingDeviceAuth?.interval ?? 5) * 1000 };
          if (started.error) {
            record.status = started.error === "unavailable" ? "disconnected" : started.error;
            return result({ status: started.error });
          }
          record.status = record.auth.pendingDeviceAuth ? "awaiting_authorization" : "needs_reconnection";
          return result();
        }
        return result();
      });
    } catch {
      // Database queries, parsed credential files and subprocess errors contain secrets.
      return { status: "unavailable" };
    }
  };
}

export const manageWallet = createWalletService();
