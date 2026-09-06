import assert from "node:assert/strict";
import test from "node:test";
import { wrapLanguageModel } from "ai";
import { judgeMiddleware } from "../evals/judge-model.js";

function fixture(inputs: string[]) {
  let calls = 0;
  const model = wrapLanguageModel({
    middleware: judgeMiddleware,
    model: {
      specificationVersion: "v4",
      provider: "test",
      modelId: "judge",
      supportedUrls: {},
      async doGenerate(params) {
        assert.equal(params.tools?.[0]?.type === "function" && params.tools[0].strict, true);
        const input = inputs[Math.min(calls++, inputs.length - 1)]!;
        return {
          content: [{ type: "tool-call", toolCallId: "choice", toolName: "select_choice", input }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
      doStream() { throw new Error("judge does not stream"); },
    },
  });
  return {
    calls: () => calls,
    generate: () => model.doGenerate({
      prompt: [],
      tools: [{
        type: "function",
        name: "select_choice",
        inputSchema: {
          type: "object",
          properties: { choice: { type: "string", enum: ["Y", "N"] }, reasons: { type: "string" } },
          required: ["choice", "reasons"],
        },
      }],
      toolChoice: { type: "tool", toolName: "select_choice" },
    }),
  };
}

test("a valid negative judge grade is preserved without retrying for a pass", async () => {
  const input = JSON.stringify({ choice: "N", reasons: "The assistant invented a physical location." });
  const run = fixture([input]);
  const result = await run.generate();
  assert.equal(run.calls(), 1);
  assert.equal(result.content[0]?.type === "tool-call" && result.content[0].input, input);
});

test("malformed JSON and missing required fields retry before returning the valid grade", async () => {
  const input = JSON.stringify({ choice: "Y", reasons: "Meets the criterion." });
  const run = fixture(["{", JSON.stringify({ choice: "Y" }), input]);
  const result = await run.generate();
  assert.equal(run.calls(), 3);
  assert.equal(result.content[0]?.type === "tool-call" && result.content[0].input, input);
});

test("invalid judge choices fail after the bounded retry limit", async () => {
  const run = fixture([JSON.stringify({ choice: "maybe", reasons: "Not a permitted classification." })]);
  await assert.rejects(async () => run.generate(), /after 3 attempts/);
  assert.equal(run.calls(), 3);
});
