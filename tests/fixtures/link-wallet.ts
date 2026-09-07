import { randomUUID } from "node:crypto";
import type { LinkCli } from "../../src/payments/link-cli.js";
import { emptyLinkAuth, paymentScopes, type WalletOwner, type WalletRecord } from "../../src/payments/wallet-types.js";
import type { WalletStore } from "../../src/payments/wallet-store.js";

export const context = (id = "a".repeat(64)) => {
  const identity = { authenticator: "linq-private", principalType: "user", principalId: id, issuer: "linq:test" };
  return { session: { auth: { current: identity, initiator: identity } } };
};
export function memoryWalletStore() {
  const rows = new Map<string, WalletRecord>();
  const key = (owner: WalletOwner) => JSON.stringify(owner);
  const store: WalletStore = {
    async update(owner, change) {
      const next = await change(structuredClone(rows.get(key(owner)) ?? null));
      rows.set(key(owner), structuredClone(next.record));
      return next.result;
    },
  };
  return { rows, store };
}
export function fakeLinkCli(now: () => number) {
  const approved = new Set<string>();
  const calls: { command: string; device?: string; token?: string }[] = [];
  const cli: LinkCli = {
    async run(command, input) {
      const auth = structuredClone(input);
      calls.push({ command, device: auth.pendingDeviceAuth?.device_code, token: auth.auth?.access_token });
      if (command === "login" || command === "upgrade") {
        const code = randomUUID();
        auth.pendingDeviceAuth = { device_code: code, expires_at: now() + 300_000, interval: 5,
          verification_url: `https://app.link.com/authorize?code=${code}`, phrase: "blue sky", replaces_existing_session: command === "upgrade" };
      }
      if (command === "status" && auth.pendingDeviceAuth && approved.has(auth.pendingDeviceAuth.device_code)) {
        auth.auth = { access_token: `secret-access-${auth.pendingDeviceAuth.device_code}`, refresh_token: "secret-refresh",
          token_type: "Bearer", expires_in: 3600, scope: paymentScopes };
        auth.pendingDeviceAuth = null;
      }
      return { auth: command === "logout" ? emptyLinkAuth() : auth };
    },
  };
  return { cli, approved, calls };
}
