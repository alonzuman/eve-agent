import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { executeLinkProcess, type CliExecutor } from "./link-cli.js";
import { linkAuthSchema, linkVerificationUrl, type LinkAuth } from "./wallet-types.js";

export const testQuote = {
  amount: 500, currency: "usd", merchant: "eve-payment-test-checkout",
  merchantUrl: "https://checkout.stripe.com", product: "Eve $5 sandbox purchase",
} as const;
const spendId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const spendSchema = z.object({
  id: spendId,
  status: z.enum(["created", "pending_approval", "approved", "denied", "expired", "canceled", "succeeded", "failed", "requires_action"]),
  approval_url: z.string().optional(),
});
export type Spend = z.infer<typeof spendSchema>;
export const cardSchema = z.object({
  number: z.string().regex(/^\d{12,19}$/), cvc: z.string().regex(/^\d{3,4}$/),
  exp_month: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().min(1).max(12)),
  exp_year: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().min(2026).max(2200)),
  valid_until: z.number().positive(),
  billing_address: z.object({ name: z.string(), postal_code: z.string(), country: z.string().length(2),
    line1: z.string().optional(), line2: z.string().nullable().optional(), city: z.string().optional(), state: z.string().optional() }),
});
export type PaymentCard = z.infer<typeof cardSchema>;
type Command = { action: "create"; purchaseId: string } | { action: "approval" | "retrieve" | "cancel" | "pay"; id: string };

/** Only app code calls this. Raw provider output and cards never cross an Eve step boundary. */
export async function runSpend<T = never>(auth: LinkAuth, command: Command,
  consume?: (card: PaymentCard) => Promise<T>, run: CliExecutor = executeLinkProcess,
): Promise<{ auth: LinkAuth; spend?: Spend; receipt?: T; error?: "unavailable" }> {
  const dir = await mkdtemp(join(tmpdir(), "eve-link-spend-"));
  const authPath = join(dir, "auth.json");
  const cardPath = join(dir, "card.json");
  let updated = auth;
  try {
    await writeFile(authPath, JSON.stringify(linkAuthSchema.parse(auth)), { mode: 0o600, flag: "wx" });
    const args = ["spend-request"];
    if (command.action === "create") {
      z.string().uuid().parse(command.purchaseId);
      args.push("create", "--amount", "500", "--currency", "usd", "--credential-type", "card",
        "--merchant-name", testQuote.merchant, "--merchant-url", testQuote.merchantUrl,
        "--context", "The user requested a no-charge end-to-end Eve payment test. Approve a USD 5.00 test credential for one Eve sandbox purchase on Stripe Checkout. No physical product, subscription, shipping, tax, or live charge is involved.",
        "--metadata", `eve_purchase_id:${command.purchaseId}`, "--test", "--no-request-approval");
    } else {
      args.push(command.action === "approval" ? "request-approval" : command.action === "pay" ? "retrieve" : command.action,
        spendId.parse(command.id));
      if (command.action === "pay") args.push("--include", "card", "--output-file", cardPath);
    }
    const packagePath = createRequire(import.meta.url).resolve("@stripe/link-cli/package.json");
    const response = await run(process.execPath, [join(dirname(packagePath), "dist/cli.js"), ...args,
      "--auth", authPath, "--format", "json"], {
      cwd: dir, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
      env: { HOME: dir, XDG_CONFIG_HOME: dir, TMPDIR: dir, NO_UPDATE_NOTIFIER: "1", DO_NOT_TRACK: "1" },
    });
    updated = linkAuthSchema.parse(JSON.parse(await readFile(authPath, "utf8")));
    if (!response.ok) return { auth: updated, error: "unavailable" };
    const parsed = JSON.parse(response.stdout);
    const raw = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    // request-approval only returns id + approval_url, not a status.
    const spend = spendSchema.parse(command.action === "approval" ? { ...raw, status: "pending_approval" } : raw);
    if (command.action !== "create" && spend.id !== command.id) throw new Error();
    if (spend.approval_url) spend.approval_url = linkVerificationUrl(spend.approval_url);
    if (command.action !== "pay") return { auth: updated, spend };
    if (spend.status !== "approved" || !consume || raw.amount !== 500 || raw.currency?.toLowerCase() !== "usd" ||
      raw.merchant_url !== testQuote.merchantUrl) throw new Error();
    const file = JSON.parse(await readFile(cardPath, "utf8"));
    if (file.spend_request_id !== command.id) throw new Error();
    const card = cardSchema.parse(file.card);
    if (card.valid_until * 1000 <= Date.now()) throw new Error();
    return { auth: updated, spend, receipt: await consume(card) };
  } catch {
    return { auth: updated, error: "unavailable" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
