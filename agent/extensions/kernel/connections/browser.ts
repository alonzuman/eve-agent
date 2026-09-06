import { defineMcpClientConnection } from "eve/connections";
import { ensureKernelProject, kernelApiKey } from "../../../../src/browser/kernel-project.js";
import { requireUserScope } from "../../../../src/identity/user-scope.js";

export default defineMcpClientConnection({
  url: "https://mcp.onkernel.com/mcp",
  description: "Kernel browser, already connected by the app. Create browser sessions, navigate with Playwright, and use computer controls to take screenshots. Browser resources are private to the current user.",
  auth: (ctx) => {
    requireUserScope(ctx);
    return {
      principalType: "user",
      getToken: async () => ({ token: kernelApiKey() }),
    };
  },
  tools: { allow: ["manage_browsers", "execute_playwright_code", "computer_action", "manage_profiles"] },
  toolCall: {
    providedArguments: {
      // Kernel accepts either selector, preferring project. Own both so a model
      // cannot select another user's resources, including by guessing a session ID.
      project: (ctx) => ensureKernelProject(ctx),
      project_id: (ctx) => ensureKernelProject(ctx),
    },
  },
});
