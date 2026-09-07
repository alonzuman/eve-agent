import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelTestPurchase } from "../../src/payments/purchase-service.js";
export default defineTool({
  description: "Cancel the current user's pending Link sandbox purchase. Record cancellation before revoking its Link spend request. Does not undo a submitted or completed payment. If busy or cancel_pending, cancellation is not yet confirmed; check the same reference again.",
  inputSchema: z.object({ purchaseId: z.string().uuid() }).strict(),
  async execute({ purchaseId }, ctx) { return cancelTestPurchase(ctx, purchaseId); },
});
