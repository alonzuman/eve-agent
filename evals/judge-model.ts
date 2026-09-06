import type { LanguageModelMiddleware } from "ai";

// Eve 0.52.2 loses invalid tool inputs before autoevals can report the cause,
// yielding "Unknown score choice undefined". Retry malformed classifications
// only; a valid negative grade must reach the assertions without a retry.
export const judgeMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async transformParams({ params }) {
    return {
      ...params,
      tools: params.tools?.map(tool => tool.type === "function" && tool.name === "select_choice"
        ? { ...tool, strict: true }
        : tool),
    };
  },
  async wrapGenerate({ doGenerate, params }) {
    const tool = params.tools?.find(tool => tool.type === "function" && tool.name === "select_choice");
    if (!tool || tool.type !== "function") return doGenerate();
    const schema = tool.inputSchema;
    const choiceSchema = schema.properties?.choice;
    const choices = typeof choiceSchema === "object" ? choiceSchema.enum : undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await doGenerate();
      const call = result.content.find(part => part.type === "tool-call");
      if (call?.type === "tool-call" && call.toolName === "select_choice") {
        try {
          const input = JSON.parse(call.input);
          if (typeof input?.choice === "string" && choices?.includes(input.choice)
            && (!schema.required?.includes("reasons") || typeof input.reasons === "string")) {
            return result;
          }
        } catch {
          // A malformed JSON payload has no score; retry within the same bound.
        }
      }
      if (attempt < 3) console.warn(`[eval judge] malformed classification; retry ${attempt}/2`);
    }
    throw new Error("Judge returned malformed select_choice arguments after 3 attempts");
  },
};
