import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireUserScope } from "../../src/identity/user-scope.js";
import { screenshotState } from "../../src/browser/screenshot-state.js";

export default defineTool({
  description: "Send the latest Kernel computer_action screenshot to the current user's iMessage chat as an actual image attachment. Use action=send only when the user asks to receive an image. Then call action=status to check the Linq send receipt before claiming it was sent. The browser capture must finish before calling this tool. No recipient, URL, or image data is accepted from the model.",
  inputSchema: z.object({ action: z.enum(["send", "status"]) }),
  execute({ action }, ctx) {
    requireUserScope(ctx);
    const { screenshot, receipt } = screenshotState.get();
    if (action === "status") return receipt ?? { status: "not_sent" };
    if (!screenshot) throw new Error("No screenshot is available. First capture the page with Kernel computer_action screenshot.");
    if (receipt?.screenshotCallId === screenshot.callId && receipt.status === "sent") return receipt;
    return { status: "queued", screenshotCallId: screenshot.callId };
  },
});
