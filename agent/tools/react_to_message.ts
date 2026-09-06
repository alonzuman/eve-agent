import { defineTool } from "eve/tools";
import { z } from "zod";
import { messageTargetSchema, performMessageAction, reactionEmojiSchema } from "../../src/messaging/linq-message-actions.js";

export default defineTool({
  description: "React to a specific message part in the current private iMessage conversation. Use liberally for quick acknowledgments: react to the user's request before substantive work with one fitting, playful Unicode emoji such as 👀 🔎 🫡 🌸 🎯. Use a provided message reference. Common tapbacks: ❤️ 👍 👎 😂 ‼️ ❓; other emoji are sent as custom reactions. Match the tone and the user's preferences. The tool awaits Linq acceptance. A reaction can fully answer a thanks or shared moment, but an acknowledgment of a task must be followed by the work and answer. Do not narrate or repeat it. An accepted result confirms provider acceptance, not handset delivery.",
  inputSchema: z.object({ target: messageTargetSchema, emoji: reactionEmojiSchema }),
  execute(input, ctx) { return performMessageAction({ kind: "reaction", ...input }, ctx); },
});
