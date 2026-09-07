import { defineTool } from "eve/tools";
import { z } from "zod";
import { manageWallet } from "../../src/payments/wallet-service.js";

export default defineTool({
  description: "Check only the current verified user's Link wallet connection. Can complete a pending authorization. Reports connection status without revealing credentials or payment methods. Connected does not mean a purchase was approved or completed.",
  inputSchema: z.object({}).strict(),
  execute: (_input, ctx) => manageWallet("status", ctx),
});
