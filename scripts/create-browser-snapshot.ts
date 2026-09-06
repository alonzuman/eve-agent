import { Sandbox } from "@vercel/sandbox";
import { sandboxCredentials } from "../src/browser/sandbox.js";

// An empty reusable image only: never snapshot a user's authenticated browser.
const sandbox = await Sandbox.create({ ...sandboxCredentials(), runtime: "node24", persistent: false, timeout: 300_000 });
async function run(cmd: string, args: string[]) {
  const result = await sandbox.runCommand(cmd, args);
  if (result.exitCode !== 0) throw new Error(`Snapshot preparation failed at ${cmd}: ${(await result.stderr()).slice(-2000)}`);
}
try {
  const libraries = ["nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core", "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor", "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm", "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo", "gtk3", "dbus-libs"];
  await run("sudo", ["dnf", "install", "-y", ...libraries]);
  await run("mkdir", ["-p", "/vercel/sandbox/browser-runtime"]);
  await run("npm", ["install", "--prefix", "/vercel/sandbox/browser-runtime", "--save-exact", "playwright@1.58.2"]);
  await run("/vercel/sandbox/browser-runtime/node_modules/.bin/playwright", ["install", "chromium"]);
  await run("node", ["--input-type=module", "-e", "import {chromium} from '/vercel/sandbox/browser-runtime/node_modules/playwright/index.mjs'; const b=await chromium.launch({headless:true,args:['--no-sandbox']}); const p=await b.newPage(); await p.goto('https://example.com'); if(!((await p.title()).includes('Example Domain')))throw new Error('Browser smoke test failed'); await b.close();"]);
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  console.log(`AGENT_BROWSER_SNAPSHOT_ID=${snapshot.snapshotId}`);
} catch (error) {
  await sandbox.stop().catch(() => {});
  throw error;
}
