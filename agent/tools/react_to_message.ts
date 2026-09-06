import { defineTool } from "eve/tools";
import { z } from "zod";
import { messageTargetSchema, performMessageAction, reactionEmojiSchema } from "../../src/messaging/linq-message-actions.js";

export default defineTool({
  description: "React to a specific message part in the current private iMessage conversation. Use a provided message reference and one Unicode emoji. Common tapbacks: ❤️ 👍 👎 😂 ‼️ ❓; other emoji are sent as custom reactions. The tool awaits Linq acceptance. A reaction can be the entire response; do not narrate or repeat it. An accepted result confirms provider acceptance, not handset delivery.",
  inputSchema: z.object({ target: messageTargetSchema, emoji: reactionEmojiSchema }),
  execute(input, ctx) { return performMessageAction({ kind: "reaction", ...input }, ctx); },
});
