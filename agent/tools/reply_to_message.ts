import { defineTool } from "eve/tools";
import { z } from "zod";
import { messageTargetSchema, performMessageAction, replyTextSchema } from "../../src/messaging/linq-message-actions.js";

export default defineTool({
  description: "Send a threaded iMessage reply to a specific message part in the current private conversation. Prefer this for answers, clarifying questions, and useful progress updates; target the specific user request you are addressing, even when it is the latest message. Use a provided message reference and the exact user-facing plain text. Blank lines split the reply into bubbles with the same typing pauses as ordinary messages; single line breaks stay within a bubble. Every bubble replies to the same target. The tool awaits Linq acceptance of all bubbles and returns the final bubble's message reference. Do not write this text as ordinary assistant prose before or after the call. Use ordinary prose for standalone conversation or when no reliable target is available. An accepted result confirms provider acceptance, not handset delivery.",
  inputSchema: z.object({ target: messageTargetSchema, text: replyTextSchema }),
  execute(input, ctx) { return performMessageAction({ kind: "reply", ...input }, ctx); },
});
