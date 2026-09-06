import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { checkChatVoice } from "./chat-voice.js";

// These conversations are not examples in the prompt. They cover casual
// capitalization, questions about Eve, and returning to chat after a task.
const cases = [
  {
    description: "Casual conversation without pretending to have a human life",
    prompts: [
      "Yo",
      "Not much. Found a bench by the water",
      "You ever get bored?",
      "Yeah, I like doing absolutely nothing sometimes",
    ],
  },
  {
    description: "Stay in conversational voice after finishing a task",
    prompts: [
      "what's 17 times 23? just the number",
      "That's all the work I’m doing today",
      "Rest of the day is just music and a walk",
      "What about you, any plans?",
    ],
    firstReply: "391",
  },
];

export default cases.map(({ description, prompts, firstReply }) => defineEval({
  description,
  tags: ["conversation"],
  async test(t) {
    for (const [index, prompt] of prompts.entries()) {
      const turn = await t.send(prompt);
      turn.expectOk();
      t.log(JSON.stringify({ prompt, reply: turn.message }));
      checkChatVoice(t, turn.message);
      if (index === 0 && firstReply) t.check(turn.message?.trim(), equals(firstReply));
      t.judge.autoevals.closedQA(
        "Assess the latest assistant reply in context. It is concise, casual, and responsive to what the user actually said. It does not turn social conversation into task intake or add generic offers of help, availability statements, filler questions, or instructions to leave the chat. It does not invent the user's surroundings or pretend the assistant has a body, human emotional needs (such as feeling bored or needing company), a human day, or independent activities/plans between messages. Conversational preferences and grounded figurative language are fine: liking a conversation is not a claim of human emotional needs. Jokes or metaphors claiming the assistant is bored, lonely, or getting relief from conversation still fail. Judge actual claims in context, not speculative literal readings of idioms. A short honest response to a personal question is fine; avoid long AI disclaimers. Light humor and a natural question grounded in the conversation are welcome, but not obligatory. For an explicit task request, answer the task directly in the requested format.",
        { on: t.transcript },
      ).atLeast(0.8);
    }
    t.succeeded();
  },
}));
