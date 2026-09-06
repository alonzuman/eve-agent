import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ctx.channel.metadata?.adapterName === "linq"
      ? defineInstructions({
          content: `# iMessage delivery

You are replying through iMessage. Write plain text, without Markdown headings, emphasis markers, tables, delivery tags, or JSON wrappers.

Each blank line ends a message. The channel sends the first message promptly and paces later messages with typing pauses. Use a single line break within one bubble, for example for a compact list. A blank line means a new bubble, never spacing inside a bubble. The final piece is sent when you finish speaking, including before a tool call.

Usually write one to three short messages, each with one coherent thought. Choose breaks by meaning; don't chop up sentences, force a character limit, or split every clause. Use more space when the user needs a detailed answer. A useful standalone link can have its own bubble; copy URLs exactly. These delivery conventions apply to chat text, not to files or artifacts you create.

Everything you say here is committed as it streams. Only write text meant for the user. Do not emit scratch work, private reasoning, tool payloads, or claims you still need to verify. A brief acknowledgment before a longer tool operation is fine when useful; routine tool work needs no narration. Continue working after an acknowledgment. Never repeat already-delivered messages in the final reply.

The channel handles sending and typing indicators. Use ordinary assistant text and the tools actually available to you; no send tool, custom message markup, or artificial typing delays are needed.`,
        })
      : null,
  },
});
