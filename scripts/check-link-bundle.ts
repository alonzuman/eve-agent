import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "eve-link-bundle-"));
try {
  const cli = resolve(".output/server/node_modules/@stripe/link-cli/dist/cli.js");
  const stdout = execFileSync(process.execPath, [cli, "auth", "status", "--interval", "1", "--max-attempts", "1",
    "--auth", join(dir, "auth.json"), "--format", "json"], {
    cwd: dir, timeout: 15_000, encoding: "utf8",
    env: { HOME: dir, XDG_CONFIG_HOME: dir, NO_UPDATE_NOTIFIER: "1" },
  });
  const [status] = JSON.parse(stdout);
  assert.equal(status.authenticated, false);
  console.info("Bundled Link CLI runs with an isolated empty auth file.");
} finally { await rm(dir, { recursive: true, force: true }); }
