import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: "anthropic/claude-sonnet-5" },
  maxConcurrency: 2,
  timeoutMs: 60_000,
});
