import { createHash } from "node:crypto";
import { isLocalToolSession, requireToolScope, type UserScopedContext } from "../identity/user-scope.js";

export function kernelApiKey(): string {
  const key = process.env.KERNEL_API_KEY?.trim();
  if (!key) throw new Error("Browser service is not configured. The app owner must connect Kernel.");
  return key;
}

export function kernelProjectName(ctx: UserScopedContext, env = process.env): string {
  const user = requireToolScope(ctx, env);
  const local = isLocalToolSession(ctx, env);
  const environment = local ? "local-development" : env.VERCEL_ENV || "development";
  const branch = environment === "production" ? "" : env.VERCEL_GIT_COMMIT_REF || "local";
  const scope = [env.VERCEL_PROJECT_ID || "eve-personal-agent", environment, branch, user, ...(local ? [process.cwd()] : [])];
  return `eve-${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
}

// Only the verified sender and deployment select the project, never tool input.
// Names are unique in Kernel, so concurrent first requests converge on one project.
export async function ensureKernelProject(
  ctx: UserScopedContext,
  options: { apiKey?: string; request?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const name = kernelProjectName(ctx, options.env);
  const key = options.apiKey ?? kernelApiKey();
  const request = options.request ?? fetch;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const url = `https://api.onkernel.com/org/projects/${encodeURIComponent(name)}`;
  const get = () => request(url, { headers, signal: AbortSignal.timeout(15_000) });
  let response = await get();
  if (response.status === 404) {
    // Projects-disabled is not a missing project. Never fall back to shared state.
    const body = await response.json().catch(() => null);
    if (body?.code === "projects_disabled") throw new Error("Browser isolation is unavailable. The app owner must enable Kernel projects.");
    response = await request("https://api.onkernel.com/org/projects", {
      method: "POST", headers, body: JSON.stringify({ name }), signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 409) response = await get();
  }
  if (!response.ok) throw new Error(`Browser project setup failed (${response.status}).`);
  const project = await response.json();
  if (typeof project.id !== "string" || !project.id || project.name !== name || project.status !== "active") {
    throw new Error("Browser project setup returned an invalid or inactive project.");
  }
  return project.id;
}
