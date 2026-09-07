import { z } from "zod";
import { messageNamespace } from "../messaging/message-references.js";
import { requireUserScope, type UserScopedContext } from "../identity/user-scope.js";

export const paymentScopes = "userinfo:read payment_methods.agentic";
export interface WalletOwner { namespace: string; principalId: string }
export function walletOwner(ctx: UserScopedContext): WalletOwner {
  return { namespace: messageNamespace(), principalId: requireUserScope(ctx) };
}

const tokens = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive(), expires_at: z.number().positive().optional(),
  token_type: z.string(), scope: z.string().optional(),
  authorization_details: z.array(z.unknown()).optional(),
});
const pending = z.object({
  device_code: z.string().min(1), interval: z.number().nonnegative(),
  expires_at: z.number().positive(), verification_url: z.string(), phrase: z.string(),
  replaces_existing_session: z.boolean().optional(),
});
// Exact storage contract of @stripe/link-cli 0.17.1. Never serialize this into an Eve step result.
export const linkAuthSchema = z.object({ auth: tokens.nullable(), pendingDeviceAuth: pending.nullable() });
export type LinkAuth = z.infer<typeof linkAuthSchema>;
export const emptyLinkAuth = (): LinkAuth => ({ auth: null, pendingDeviceAuth: null });

export const walletRecordSchema = z.object({
  version: z.literal(1), connectionId: z.string().uuid(), auth: linkAuthSchema,
  status: z.enum(["disconnected", "awaiting_authorization", "connected", "needs_reconnection", "denied", "expired"]),
  nextCheckAt: z.number(),
});
export type WalletRecord = z.infer<typeof walletRecordSchema>;
export type WalletStatus = {
  status: WalletRecord["status"] | "unavailable" | "not_configured" | "busy" | "superseded";
  connectionId?: string;
  verificationUrl?: string;
  phrase?: string;
  expiresAt?: number;
  pollAfterSeconds?: number;
};

export function linkVerificationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "app.link.com" || url.port || url.username || url.password) {
    throw new Error("Unexpected Link authorization URL.");
  }
  return url.toString();
}

export function hasPaymentScopes(auth: LinkAuth): boolean {
  const granted = new Set(auth.auth?.scope?.split(/\s+/) ?? []);
  return paymentScopes.split(" ").every(scope => granted.has(scope));
}

export function publicWalletStatus(record: WalletRecord, now: number): WalletStatus {
  const result: WalletStatus = { status: record.status, connectionId: record.connectionId };
  const pending = record.auth.pendingDeviceAuth;
  if (record.status === "awaiting_authorization" && pending) {
    return { ...result, verificationUrl: linkVerificationUrl(pending.verification_url),
      phrase: z.string().min(1).max(200).regex(/^[\p{L}\p{N} -]+$/u).parse(pending.phrase),
      expiresAt: pending.expires_at,
      pollAfterSeconds: Math.max(5, Math.ceil((record.nextCheckAt - now) / 1000)),
    };
  }
  return result;
}
