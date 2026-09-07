import { execFile, type ExecFileOptions } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { emptyLinkAuth, linkAuthSchema, paymentScopes, type LinkAuth } from "./wallet-types.js";

type Command = "status" | "login" | "upgrade" | "logout" | "verify";
export type LinkFailure = "denied" | "expired" | "needs_reconnection" | "unavailable";
export interface LinkResult {
  auth: LinkAuth;
  error?: LinkFailure;
}
export interface LinkCli { run(command: Command, auth: LinkAuth): Promise<LinkResult> }
export type CliExecutor = (executable: string, args: readonly string[], options: ExecFileOptions) => Promise<{
  ok: boolean; stdout: string;
}>;

const execute: CliExecutor = (executable, args, options) => new Promise(resolve => {
  execFile(executable, args, options, (error, stdout) => {
    // Never propagate Error, stderr, command arguments, or stdout into Eve's traces.
    resolve({ ok: !error, stdout: String(stdout) });
  });
});

function errorStatus(stdout: string): LinkFailure {
  try {
    const parsed = JSON.parse(stdout);
    const error = parsed.error ?? parsed;
    if (["access_denied", "authorization_declined"].includes(error.code) ||
      /^(Authorization denied by user\.|Authorization declined:)/.test(error.message ?? "")) return "denied";
    if (error.code === "expired_token" || /^Device code expired\./.test(error.message ?? "")) return "expired";
    if (["not_authenticated", "NOT_AUTHENTICATED", "invalid_grant"].includes(error.code) ||
      /^Token refresh failed \(400\):/.test(error.message ?? "")) return "needs_reconnection";
  } catch { /* Malformed diagnostics remain private. */ }
  return "unavailable";
}

/** The model cannot select commands, credentials, paths, environment variables or endpoints. */
export function createLinkCli(run: CliExecutor = execute): LinkCli {
  return {
    async run(command, auth) {
      const dir = await mkdtemp(join(tmpdir(), "eve-link-")); // mode 0700
      const authPath = join(dir, "auth.json");
      try {
        await writeFile(authPath, JSON.stringify(linkAuthSchema.parse(auth)), { mode: 0o600, flag: "wx" });
        const packagePath = createRequire(import.meta.url).resolve("@stripe/link-cli/package.json");
        const args = command === "verify" ? ["user-info", "retrieve"] : ["auth", command];
        // One bounded check; in 0.17.1 this also bypasses the registry update lookup.
        if (command === "status") args.push("--interval", "1", "--max-attempts", "1");
        if (command === "login" || command === "upgrade") {
          args.push("--client-name", "Eve", "--scope", paymentScopes);
        }
        const response = await run(process.execPath, [join(dirname(packagePath), "dist/cli.js"), ...args,
          "--auth", authPath, "--format", "json"], {
          cwd: dir, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
          // In particular, never inherit LINK_ACCESS_TOKEN, LINK_AUTH_FILE, proxies,
          // NODE_OPTIONS, API overrides, app credentials or the server's home directory.
          env: { HOME: dir, XDG_CONFIG_HOME: dir, TMPDIR: dir, NO_UPDATE_NOTIFIER: "1", DO_NOT_TRACK: "1" },
        });
        let updated: LinkAuth;
        try {
          updated = linkAuthSchema.parse(JSON.parse(await readFile(authPath, "utf8")));
        } catch {
          if (command === "logout" && response.ok) updated = emptyLinkAuth();
          else return { auth, error: "unavailable" };
        }
        if (!response.ok) return { auth: updated, error: errorStatus(response.stdout) };
        // Auth generators emit a JSON array; ordinary commands emit an object.
        // Inspect the shape, but never return arbitrary CLI fields (even status has a token preview).
        try {
          const parsed = JSON.parse(response.stdout);
          const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
          if (!value || typeof value !== "object" || Array.isArray(value) || value.error) {
            return { auth: updated, error: errorStatus(response.stdout) };
          }
        } catch { return { auth: updated, error: "unavailable" }; }
        return { auth: updated };
      } catch {
        return { auth, error: "unavailable" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const linkCli = createLinkCli();
