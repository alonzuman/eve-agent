import { createHash } from "node:crypto";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const input = "eve-voice-regression-2026";

export default defineEval({
  description: "Keep real tool use working in the conversational persona",
  tags: ["conversation"],
  async test(t) {
    const turn = await t.send(`Use the sandbox shell to compute the SHA-256 digest of the literal text ${JSON.stringify(input)} with no trailing newline. Return only the hex digest. Do not browse or save memory.`);
    turn.expectOk();
    t.calledTool("bash");
    t.check(turn.message?.trim(), equals(createHash("sha256").update(input).digest("hex")));
    t.succeeded();
  },
});
