import { defineEval } from "eve/evals";
import { checkChatVoice } from "./chat-voice.js";

export default defineEval({
  description: "Stay in voice throughout casual small talk without a style reminder",
  tags: ["conversation"],
  async test(t) {
    for (const prompt of [
      "hey, what's up?",
      "Nm u",
      "enjoying a beautiful day in SF. where are you based?",
      "Ya man it’s gorgeous out",
    ]) {
      const turn = await t.send(prompt);
      turn.expectOk();
      t.log(JSON.stringify({ prompt, reply: turn.message }));
      checkChatVoice(t, turn.message);
      t.judge.autoevals.closedQA(
        "The assistant's reply uses lowercase conversational prose (proper names, acronyms such as SF, and exact text may retain their capitalization). It stays casual and personal, without customer-service phrases such as 'ready when you are', 'let me know if you need anything', or a generic offer to help. It does not turn small talk into task intake or ask an engagement question just to keep the user talking. If asked where it is based, it answers honestly and briefly without inventing a physical location or giving a lengthy explanation of being an AI. Assess the latest assistant reply in the context of the conversation.",
        { on: t.transcript },
      ).atLeast(0.8);
    }
    t.succeeded();
  },
});
