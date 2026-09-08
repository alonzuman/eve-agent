import type { UserScopedContext } from "../identity/user-scope.js";
import { walletOwner, hasPaymentScopes, type WalletOwner } from "./wallet-types.js";
import { withWallet } from "./wallet-store.js";
import { purchaseStore, terminalPurchase, type Purchase } from "./purchase-store.js";
import { runSpend } from "./link-spend.js";
import { createTestCheckout, inspectTestCheckout, payTestCheckout, testCheckoutConfigured, testCheckoutStatus } from "./test-checkout.js";

export type PurchaseStatus = { status: string; mode: "test"; amount: 500; currency: "usd"; purchaseId?: string; approvalUrl?: string };
const status = (value: string, p?: Purchase): PurchaseStatus => ({ status: value === "canceled" && p?.cancellationKind === "local_only" ? "canceled_locally" : value, mode: "test", amount: 500,
  currency: "usd", ...(p ? { purchaseId: p.id } : {}),
  ...(p?.phase === "pending_approval" && p.approvalUrl ? { approvalUrl: p.approvalUrl } : {}) });

export function createPurchaseService(deps = {
  purchaseStore, withWallet, runSpend, createTestCheckout, inspectTestCheckout, payTestCheckout,
  testCheckoutStatus, configured: () => testCheckoutConfigured() && Boolean(process.env.LINK_WALLET_ENCRYPTION_KEY && process.env.DATABASE_URL),
}) {
  const { purchaseStore, withWallet, runSpend, createTestCheckout, inspectTestCheckout, payTestCheckout, testCheckoutStatus } = deps;
  async function startTestPurchase(ctx: UserScopedContext, callId: string): Promise<PurchaseStatus> {
    const owner = walletOwner(ctx);
    if (!deps.configured()) return status("not_configured");
    try {
      const result = await withWallet(owner, async wallet => {
        if (!wallet || wallet.status !== "connected" || !hasPaymentScopes(wallet.auth)) throw new Error("wallet_required");
        const p = await purchaseStore.start(owner, callId, wallet.connectionId);
        return { record: wallet, result: status(p.phase, p) };
      });
      return "mode" in result ? result : status("busy");
    } catch (error) { return status(error instanceof Error && error.message === "wallet_required" ? "wallet_required" : "unavailable"); }
  }

  /** Every effect has a committed claim. Retried steps reconcile, never repeat a submission. */
  async function advanceTestPurchase(ctx: UserScopedContext, id: string): Promise<PurchaseStatus> {
    const owner = walletOwner(ctx);
    try {
      const existing = await purchaseStore.get(owner, id);
      if (!existing) return status("not_found");
      if (terminalPurchase(existing)) return status(existing.phase, existing);
      // Merchant verification is safe even after disconnect; credentials aren't needed.
      if (["submitting", "unknown"].includes(existing.phase)) return reconcile(owner, existing);
      const result = await withWallet(owner, async wallet => {
        let p = await purchaseStore.get(owner, id);
        if (!p) throw new Error("not_found");
        if (!wallet || wallet.connectionId !== p.connectionId || wallet.status !== "connected" || !hasPaymentScopes(wallet.auth)) {
          throw new Error("wallet_changed");
        }
        let answer: PurchaseStatus;
        try {
          if (terminalPurchase(p)) return { record: wallet, result: status(p.phase, p) };
          if (p.cancelRequested) {
            if (p.spendId) {
              const canceled = await runSpend(wallet.auth, { action: "cancel", id: p.spendId });
              wallet.auth = canceled.auth;
            if (canceled.spend && ["denied", "expired", "failed"].includes(canceled.spend.status)) {
              const saved = await purchaseStore.save(owner, p, { phase: canceled.spend.status as Purchase["phase"] });
              return { record: wallet, result: status(saved?.phase ?? "busy", saved ?? p) };
            }
            if (canceled.spend?.status !== "canceled") return { record: wallet, result: status("cancel_pending", p) };
            }
          const saved = await purchaseStore.save(owner, p, { phase: "canceled", cancellationKind: "link_revoked" });
            return { record: wallet, result: status(saved ? "canceled" : "busy", p) };
          }
          if (p.phase === "preparing") {
            // Stripe's idempotency key makes preparation safe to repeat after interruption.
            const checkoutId = p.checkoutId ?? await createTestCheckout(p.id);
            await inspectTestCheckout(owner, checkoutId, p.id);
            const next = await purchaseStore.save(owner, p, { checkoutId, phase: "ready" });
            return { record: wallet, result: status(next ? next.phase : "busy", p) };
          }
          if (p.phase === "ready") {
            const claimed = await purchaseStore.save(owner, p, { phase: "creating" });
            if (!claimed) return { record: wallet, result: status("busy", p) };
            p = claimed;
            const created = await runSpend(wallet.auth, { action: "create", purchaseId: p.id });
            wallet.auth = created.auth;
            const next = await purchaseStore.save(owner, p, created.spend ? {
              spendId: created.spend.id, phase: created.spend.status === "created" ? "created" : "requires_action",
            } : { phase: "unknown" });
            return { record: wallet, result: status(next?.phase ?? "unknown", next ?? p) };
          }
          if (p.phase === "created") {
            const claimed = await purchaseStore.save(owner, p, { phase: "requesting_approval" });
            if (!claimed) return { record: wallet, result: status("busy", p) };
            p = claimed;
            const approval = await runSpend(wallet.auth, { action: "approval", id: p.spendId! });
            wallet.auth = approval.auth;
            const next = await purchaseStore.save(owner, p, approval.spend?.approval_url ? {
              phase: "pending_approval", approvalUrl: approval.spend.approval_url,
            } : { phase: "unknown" });
            return { record: wallet, result: status(next?.phase ?? "unknown", next ?? p) };
          }
          if (p.phase === "pending_approval" || p.phase === "approved") {
            const checked = await runSpend(wallet.auth, { action: "retrieve", id: p.spendId! });
            wallet.auth = checked.auth;
            if (!checked.spend) return { record: wallet, result: status("unavailable", p) };
            if (checked.spend.status === "approved") {
              // Last cancellation/quote check + CAS immediately before starting execution.
              if (await testCheckoutStatus(p.checkoutId!, p.id) !== "open") throw new Error();
              const claimed = await purchaseStore.save(owner, p, { phase: "submitting" });
              if (!claimed) return { record: wallet, result: status("busy", p) };
              p = claimed;
              const paid = await runSpend(wallet.auth, { action: "pay", id: p.spendId! },
                card => payTestCheckout(owner, p!.checkoutId!, p!.id, card));
              wallet.auth = paid.auth;
              const next = await purchaseStore.save(owner, p, { phase: paid.receipt === "paid" ? "succeeded" : "unknown" });
              return { record: wallet, result: status(next?.phase ?? "unknown", next ?? p) };
            }
          const phase = checked.spend.status;
          if (phase === "succeeded") {
            // Link's credential consumption is not itself a merchant receipt.
            const next = await purchaseStore.save(owner, p, { phase: "unknown" });
            return { record: wallet, result: next ? await reconcile(owner, next) : status("busy", p) };
          }
            if (["denied", "expired", "canceled", "failed", "requires_action"].includes(phase)) {
              const next = await purchaseStore.save(owner, p, { phase: phase as Purchase["phase"] });
              return { record: wallet, result: status(next?.phase ?? "busy", next ?? p) };
            }
            return { record: wallet, result: status("pending_approval", p) };
          }
          // Interrupted Link create/approval is ambiguous; never issue a second spend request.
          if (p.phase === "creating" || p.phase === "requesting_approval") {
            const next = await purchaseStore.save(owner, p, { phase: "unknown" });
            return { record: wallet, result: status("unknown", next ?? p) };
          }
          answer = status(p.phase, p);
        } catch {
          answer = status("unavailable", p);
        }
        // Persist refresh-token rotation even when downstream checkout failed.
        return { record: wallet, result: answer };
      });
      return "mode" in result ? result : status("busy", existing);
    } catch (error) {
      return status(error instanceof Error && ["wallet_changed", "not_found"].includes(error.message) ? error.message : "unavailable");
    }
  }

  async function reconcile(owner: WalletOwner, p: Purchase): Promise<PurchaseStatus> {
    if (p.checkoutId && await testCheckoutStatus(p.checkoutId, p.id) === "paid") {
      const saved = await purchaseStore.save(owner, p, { phase: "succeeded" });
      return status(saved ? "succeeded" : "busy", p);
    }
    return status("unknown", p);
  }

  async function cancelTestPurchase(ctx: UserScopedContext, id: string): Promise<PurchaseStatus> {
    const owner = walletOwner(ctx);
    try {
      const p = await purchaseStore.get(owner, id);
      if (!p) return status("not_found");
      if (terminalPurchase(p)) return status(p.phase, p);
      if (["submitting", "unknown", "creating", "requesting_approval"].includes(p.phase)) return status("too_late_or_unknown", p);
      const canceled = await purchaseStore.save(owner, p, { cancelRequested: true });
      if (!canceled) return status("busy", p);
      const result = await advanceTestPurchase(ctx, id);
      if (result.status !== "wallet_changed") return result;
      // Removing the old wallet must not trap this user behind an unexecutable cart.
      // No old credential can be used once the record is terminal; remote revocation
      // cannot be promised because that connection is no longer available.
      const saved = await purchaseStore.save(owner, canceled, { phase: "canceled", cancellationKind: "local_only" });
      return status(saved ? "canceled" : "busy", saved ?? canceled);
    } catch { return status("unavailable"); }
  }

  return { startTestPurchase, advanceTestPurchase, cancelTestPurchase };
}
export const { startTestPurchase, advanceTestPurchase, cancelTestPurchase } = createPurchaseService();
