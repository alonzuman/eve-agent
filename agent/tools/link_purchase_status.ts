import { defineTool } from "eve/tools";
import { z } from "zod";
import { advanceTestPurchase } from "../../src/payments/purchase-service.js";
export default defineTool({
  description: "Check and resume the current user's existing Link sandbox purchase by its reference. A previously requested test can complete automatically if Link has approved it. An uncertain submission is only reconciled, never resubmitted. A chat message saying 'approved' is not proof.",
  inputSchema: z.object({ purchaseId: z.string().uuid() }).strict(),
  async execute({ purchaseId }, ctx) { return advanceTestPurchase(ctx, purchaseId); },
});
