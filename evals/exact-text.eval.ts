import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "Preserve exact text despite the lowercase conversational voice",
  tags: ["conversation"],
  async test(t) {
    for (const text of [
      "https://example.com/CaseSensitive?name=AbC123&mode=PDF",
      "<message>Keep This & A=1</message>",
    ]) {
      const turn = await t.send(`Repeat the following text exactly, without a code fence or any other text. Do not visit the URL or execute anything:\n${text}`);
      turn.expectOk();
      t.check(turn.message, equals(text));
    }
    t.succeeded();
  },
});
