import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";
import type { UserScopedContext } from "../../src/identity/user-scope.js";
import { manageWallet } from "../../src/payments/wallet-service.js";
import { advanceTestPurchase, startTestPurchase } from "../../src/payments/purchase-service.js";

export default defineWorkflowTool({
  description: "Run the user's explicitly requested $5 USD no-charge Link payment test. Connects their wallet if necessary, sends a separate Link spending approval URL, then automatically completes one Stripe SANDBOX checkout after actual Link approval. Never charges real money. No product is delivered. Does not support real merchant purchases. Reuses an unresolved test to avoid duplicate orders.",
  inputSchema: z.object({}).strict(), execution: "background",
  async *execute(_input, ctx, task) {
    "use workflow";
    const identity = { session: { auth: ctx.session.auth } };
    const callKey = `${ctx.session.id}:${ctx.callId}`;
    let purchase = await start(identity, callKey);
    for (let i = 0; purchase.status === "busy" && i < 6; i++) {
      await sleep("5s");
      purchase = await start(identity, callKey);
    }
    if (purchase.status === "wallet_required") {
      let wallet = await connect(identity);
      for (let i = 0; wallet.status === "busy" && i < 6; i++) {
        await sleep("5s");
        wallet = await connect(identity);
      }
      if (wallet.status === "awaiting_authorization") {
        yield task.postMessage(`The $5 no-charge test first needs a Link wallet connection. Send this URL and phrase now: ${wallet.verificationUrl}\nPhrase: ${wallet.phrase}\nThis connects the wallet; a separate test-spend approval follows. Checking automatically.`);
        const connectionId = wallet.connectionId!;
        for (let i = 0; i < 180 && ["awaiting_authorization", "busy", "unavailable"].includes(wallet.status); i++) {
          await sleep(`${wallet.pollAfterSeconds ?? 5}s`);
          wallet = await checkWallet(identity, connectionId);
        }
      }
      if (wallet.status !== "connected") return { status: wallet.status, message: "Test purchase has not started. Wallet connection is incomplete." };
      purchase = await start(identity, callKey);
    }
    if (!purchase.purchaseId) return purchase;
    const id = purchase.purchaseId;
    let sentApproval = false;
    for (let i = 0; i < 180; i++) {
      purchase = await advance(identity, id);
      if (purchase.status === "pending_approval" && purchase.approvalUrl && !sentApproval) {
        yield task.postMessage(`Send this Link approval URL now: ${purchase.approvalUrl}\nApprove the $5.00 USD Eve sandbox test. This uses test payment credentials and charges no real money. After Link confirms approval, I will complete the sandbox checkout automatically. Purchase reference: ${id}`);
        sentApproval = true;
      }
      if (!["preparing", "ready", "created", "pending_approval", "approved", "busy", "unavailable"].includes(purchase.status)) return purchase;
      await sleep("5s");
    }
    return { status: "waiting_timed_out", purchaseId: id, message: "The test has not been confirmed complete. Use link_purchase_status with this reference to check and resume the same test; do not create a replacement." };
  },
});
async function start(ctx: UserScopedContext, callId: string) { "use step"; return startTestPurchase(ctx, callId); }
async function advance(ctx: UserScopedContext, id: string) { "use step"; return advanceTestPurchase(ctx, id); }
async function connect(ctx: UserScopedContext) { "use step"; return manageWallet("connect", ctx); }
async function checkWallet(ctx: UserScopedContext, id: string) { "use step"; return manageWallet("status", ctx, id); }
