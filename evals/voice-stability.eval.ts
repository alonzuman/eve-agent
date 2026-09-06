import { defineEval } from "eve/evals";
import smallTalk from "./small-talk.eval.js";

// Separate fresh sessions catch failures hidden by a single favorable sample.
// Opt in with `eve eval --tag voice-stability --strict` while tuning the prompt.
export default Array.from({ length: 5 }, (_, index) => defineEval({
  ...smallTalk,
  description: `Small-talk consistency, fresh session ${index + 1}`,
  tags: ["voice-stability"],
}));
