import { defineTool } from "eve/tools";
import { z } from "zod";
import { manageWallet } from "../../src/payments/wallet-service.js";

export default defineTool({
  description: "Disconnect the current verified user's Link wallet when they request it. Deletes Eve's saved credentials and stops pending connection checks from restoring them. Requests Link revocation on a best-effort basis; do not claim remote revocation was confirmed. The user can manage connected agents at https://app.link.com.",
  inputSchema: z.object({}).strict(),
  execute: (_input, ctx) => manageWallet("disconnect", ctx),
});
