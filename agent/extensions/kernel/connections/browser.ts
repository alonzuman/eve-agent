import { defineMcpClientConnection } from "eve/connections";
import { ensureKernelProject, kernelApiKey } from "../../../../src/browser/kernel-project.js";
import { isLocalToolSession, requireToolScope } from "../../../../src/identity/user-scope.js";

export default defineMcpClientConnection({
  url: "https://mcp.onkernel.com/mcp",
  description: "Your private remote browser, already connected by the app and isolated for the current user. The user cannot see or operate it. Navigate with Playwright, inspect pages, and use computer controls for screenshots. Share public product/page URLs in chat; these do not share browser sessions or carts. Never send live-view URLs or ask the user to take over.",
  auth: (ctx) => {
    requireToolScope(ctx);
    return {
      // eve's local-dev identity cannot resolve a user-scoped credential.
      // The server-owned project selectors still isolate all browser state.
      principalType: isLocalToolSession(ctx) ? "app" : "user",
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
