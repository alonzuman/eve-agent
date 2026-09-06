import { defineEvalConfig } from "eve/evals";
import { gateway, wrapLanguageModel } from "ai";
import { judgeMiddleware } from "./judge-model.js";

export default defineEvalConfig({
  judge: { model: wrapLanguageModel({ model: gateway("anthropic/claude-sonnet-5"), middleware: judgeMiddleware }) },
  maxConcurrency: 2,
  timeoutMs: 60_000,
});
