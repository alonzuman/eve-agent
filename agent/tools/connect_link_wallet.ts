import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";
import { manageWallet } from "../../src/payments/wallet-service.js";
import type { UserScopedContext } from "../../src/identity/user-scope.js";

export default defineWorkflowTool({
  description: "Connect the current verified user's own Link wallet. Sends a Link verification URL and phrase, then checks for authorization in the background and reports completion. Reuses an existing connection. Only connects a wallet; does not approve spending or place orders. Never ask for card details in chat.",
  inputSchema: z.object({}).strict(),
  execution: "background",
  async *execute(_input, ctx, task) {
    "use workflow";
    const identity = { session: { auth: ctx.session.auth } };
    let status = await connect(identity);
    // Lock contention is transient; do not drop a concurrent connection request.
    for (let attempt = 0; status.status === "busy" && attempt < 6; attempt++) {
      await sleep("5s");
      status = await connect(identity);
    }
    if (status.status !== "awaiting_authorization") return status;
    const connectionId = status.connectionId!;
    yield task.postMessage(`Link wallet connection needs user authorization. Send this Link URL and phrase to the user now: ${status.verificationUrl}\nPhrase: ${status.phrase}\nThey sign in or create a Link account and authorize Eve. Wallet connection alone does not approve a purchase. I am checking for completion automatically.`);
    for (let attempt = 0; attempt < 180; attempt++) {
      await sleep(`${status.pollAfterSeconds ?? 5}s`);
      status = await check(identity, connectionId);
      if (!["awaiting_authorization", "busy", "unavailable"].includes(status.status)) return status;
    }
    return { status: "waiting_timed_out", message: "Automatic checking stopped. Use link_wallet_status to check this connection; do not create a new flow without the user's request." };
  },
});

async function connect(ctx: UserScopedContext) {
  "use step";
  return manageWallet("connect", ctx);
}

async function check(ctx: UserScopedContext, connectionId: string) {
  "use step";
  return manageWallet("status", ctx, connectionId);
}
