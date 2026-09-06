import { createHash, randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { browserClient, browserRunner } from "./runner.js";

export function browserScopeName(userKey: string): string {
  if (!userKey) throw new Error("A verified user is required for browser access.");
  const environment = process.env.VERCEL_ENV || "development";
  const branch = environment === "preview" ? process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_URL || "local-preview" : "";
  return `eve-browser-${createHash("sha256").update(JSON.stringify([environment, branch, userKey])).digest("hex").slice(0, 40)}`;
}

export function sandboxCredentials() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

async function startBrowser(sandbox: Sandbox) {
  const health = await sandbox.runCommand("node", ["-e", "fetch('http://127.0.0.1:8787/health').then(async r=>{if((await r.text())!=='eve-browser-v2')process.exit(2)}).catch(()=>process.exit(1))"]);
  if (health.exitCode === 0) return;
  if (health.exitCode === 2) {
    await sandbox.runCommand("node", ["-e", "(async()=>{const fs=require('node:fs/promises');const token=await fs.readFile('/vercel/sandbox/browser-data/control-token','utf8');await fetch('http://127.0.0.1:8787/shutdown',{method:'POST',headers:{authorization:'Bearer '+token}})})()"]);
  }
  await sandbox.writeFiles([
    { path: "/vercel/sandbox/browser-runner.mjs", content: Buffer.from(browserRunner) },
    { path: "/vercel/sandbox/browser-client.mjs", content: Buffer.from(browserClient) },
  ]);
  await sandbox.runCommand({ cmd: "flock", args: ["-n", "/vercel/sandbox/browser.lock", "node", "/vercel/sandbox/browser-runner.mjs"], detached: true });
  const ready = await sandbox.runCommand("node", ["-e", "(async()=>{for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:8787/health');if(r.ok&&(await r.text())==='eve-browser-v2')return}catch{}await new Promise(r=>setTimeout(r,250))}process.exit(1)})()"]);
  if (ready.exitCode !== 0) throw new Error("Browser could not start. Rebuild the browser snapshot and check Sandbox logs.");
}

export async function userBrowser(userKey: string): Promise<Sandbox> {
  const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;
  if (!snapshotId) throw new Error("Browser setup is incomplete: AGENT_BROWSER_SNAPSHOT_ID is missing. Run npm run browser:snapshot and configure the resulting snapshot ID.");
  const sandbox = await Sandbox.getOrCreate({
    ...sandboxCredentials(),
    name: browserScopeName(userKey),
    source: { type: "snapshot", snapshotId },
    persistent: true,
    timeout: 10 * 60_000,
    keepLastSnapshots: { count: 1, expiration: 30 * 24 * 60 * 60_000, deleteEvicted: true },
    onCreate: startBrowser,
    onResume: startBrowser,
    resume: true,
    // No exposed ports, application environment, Blob token, or payment credentials.
    env: {},
    networkPolicy: { allow: ["*"], subnets: { deny: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "0.0.0.0/8", "100.64.0.0/10"] } },
  });
  await startBrowser(sandbox);
  return sandbox;
}

export type BrowserInput = { action: "navigate" | "read" | "click" | "fill" | "select" | "press" | "screenshot"; url?: string; selector?: string; frameSelector?: string; value?: string; key?: string };
export type BrowserResult = { url?: string; title?: string; frames?: unknown[]; error?: string; screenshotBase64?: string; ambiguous?: boolean };

export async function browserOperation(userKey: string, operationId: string, input: BrowserInput): Promise<BrowserResult> {
  const sandbox = await userBrowser(userKey);
  const path = `/vercel/sandbox/browser-request-${randomUUID()}.json`;
  await sandbox.writeFiles([{ path, content: Buffer.from(JSON.stringify({ ...input, operationId })) }]);
  const command = await sandbox.runCommand("node", ["/vercel/sandbox/browser-client.mjs", path]);
  if (command.exitCode !== 0) throw new Error("Browser operation interrupted. Read the current page before repeating any state-changing action.");
  return JSON.parse(await command.stdout()) as BrowserResult;
}
