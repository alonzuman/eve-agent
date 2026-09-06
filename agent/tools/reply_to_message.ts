import { defineTool } from "eve/tools";
import { z } from "zod";
import { messageTargetSchema, performMessageAction, replyTextSchema } from "../../src/messaging/linq-message-actions.js";

export default defineTool({
  description: "Send one threaded iMessage bubble replying to a specific message part in the current private conversation. Prefer this for answers, clarifying questions, and useful progress updates; target the specific user request you are addressing, even when it is the latest message. Use a provided message reference and the exact user-facing plain text. Line breaks stay within this bubble; use separate calls with the same target when multiple bubbles are useful. The tool awaits Linq acceptance and returns the new message reference. Do not write this text as ordinary assistant prose before or after the call. Use ordinary prose for standalone conversation or when no reliable target is available. An accepted result confirms provider acceptance, not handset delivery.",
  inputSchema: z.object({ target: messageTargetSchema, text: replyTextSchema }),
  execute(input, ctx) { return performMessageAction({ kind: "reply", ...input }, ctx); },
});
