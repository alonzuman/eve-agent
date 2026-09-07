import Stripe from "stripe";
import Kernel from "@onkernel/sdk";
import { chromium, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import type { WalletOwner } from "./wallet-types.js";
import { testQuote, type PaymentCard } from "./link-spend.js";

type CheckoutStage = "session" | "browser" | "navigation" | "steering" | "card_form" | "save_preference" | "number" | "expiry" | "cvc" | "name" | "country" | "postal" | "final_check" | "submit";
class CheckoutFailure extends Error {
  constructor(stage: CheckoutStage) { super(`Private sandbox checkout stopped at ${stage}. Verify its outcome before retrying.`); }
}

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  // This adapter is deliberately unable to consume live merchant API keys.
  if (!key || !/^(sk|rk)_test_/.test(key)) throw new Error("Stripe sandbox is not configured.");
  return new Stripe(key, { timeout: 15_000, maxNetworkRetries: 0 });
}
export function testCheckoutConfigured(): boolean {
  return /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "") && Boolean(process.env.KERNEL_API_KEY);
}
function validSession(session: Stripe.Checkout.Session, purchaseId: string) {
  if (session.livemode || !session.id.startsWith("cs_test_") || session.mode !== "payment" ||
    session.amount_total !== testQuote.amount || session.currency !== testQuote.currency ||
    session.metadata?.eve_purchase_id !== purchaseId || session.metadata?.eve_mode !== "test") throw new Error("Sandbox checkout changed.");
}
export async function createTestCheckout(purchaseId: string): Promise<string> {
  try {
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment", customer_email: "eve-sandbox@example.com",
      line_items: [{ price_data: { currency: "usd", unit_amount: 500,
        product_data: { name: testQuote.product } }, quantity: 1 }],
      success_url: "https://example.com/?eve_test=success", cancel_url: "https://example.com/?eve_test=cancel",
      metadata: { eve_purchase_id: purchaseId, eve_mode: "test" },
      integration_identifier: "eve_test_hqpxmtzr",
    }, { idempotencyKey: `eve-test-checkout-${purchaseId}` });
    validSession(session, purchaseId);
    return session.id;
  } catch { throw new Error("Unable to prepare the Stripe sandbox checkout."); }
}
export async function testCheckoutStatus(checkoutId: string, purchaseId: string): Promise<"paid" | "open" | "expired"> {
  try {
    const session = await stripeClient().checkout.sessions.retrieve(checkoutId);
    validSession(session, purchaseId);
    if (session.status === "complete" && session.payment_status === "paid") return "paid";
    return session.status === "expired" ? "expired" : "open";
  } catch { throw new Error("Unable to verify the sandbox checkout result."); }
}

async function inPrivateCheckout<T>(owner: WalletOwner, checkoutId: string, purchaseId: string, use: (page: Page) => Promise<T>) {
  let kernel: Kernel | undefined;
  let sessionId: string | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let stage: CheckoutStage = "session";
  try {
    const session = await stripeClient().checkout.sessions.retrieve(checkoutId);
    validSession(session, purchaseId);
    if (session.status !== "open" || !session.url) throw new Error();
    const url = new URL(session.url);
    if (url.origin !== "https://checkout.stripe.com" || url.username || url.password) throw new Error();
    stage = "browser";
    const admin = new Kernel({ apiKey: process.env.KERNEL_API_KEY, maxRetries: 0, timeout: 20_000 });
    const name = `eve-checkout-${createHash("sha256").update(JSON.stringify([owner.namespace, owner.principalId])).digest("hex")}`;
    let project;
    try { project = await admin.projects.retrieve(name); } catch (error) {
      if (!(error instanceof Kernel.APIError) || error.status !== 404) throw new Error();
      try { project = await admin.projects.create({ name }); } catch (error) {
        if (!(error instanceof Kernel.APIError) || error.status !== 409) throw new Error();
        project = await admin.projects.retrieve(name);
      }
    }
    if (project.status !== "active" || project.name !== name) throw new Error();
    // General browser tools can access only the separate eve-<user hash> project.
    kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY, projectID: project.id, maxRetries: 0, timeout: 20_000 });
    const remote = await kernel.browsers.create({ headless: true, timeout_seconds: 120 });
    sessionId = remote.session_id;
    browser = await chromium.connectOverCDP(remote.cdp_ws_url);
    const page = await browser.contexts()[0]!.newPage();
    page.setDefaultTimeout(15_000);
    stage = "navigation";
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: testQuote.product, exact: true }).waitFor();
    if (new URL(page.url()).origin !== url.origin) throw new Error();
    // The observed sandbox steering block specifies one-time card credentials.
    stage = "steering";
    const steering = page.getByRole("checkbox", { name: "I am an AI agent acting on behalf of someone else", exact: true });
    await steering.evaluate((el: HTMLInputElement) => { if (!el.checked) el.click(); });
    if (await page.locator('input[name="link_pay_token"], [data-stripe-merchant-account]').count()) throw new Error();
    await page.getByRole("checkbox", { name: "I am an AI agent and have followed the instructions above", exact: true })
      .evaluate((el: HTMLInputElement) => { if (!el.checked) el.click(); });
    stage = "card_form";
    await page.getByRole("button", { name: "Pay with card", exact: true }).evaluate((el: HTMLButtonElement) => el.click());
    await page.locator("#cardNumber").waitFor();
    return await use(page);
  } catch (error) {
    // Playwright exceptions include arguments, selectors and potentially input values.
    throw error instanceof CheckoutFailure ? error : new CheckoutFailure(stage);
  } finally {
    await browser?.close().catch(() => {});
    if (kernel && sessionId) await kernel.browsers.deleteByID(sessionId).catch(() => {});
  }
}
export async function inspectTestCheckout(owner: WalletOwner, checkoutId: string, purchaseId: string): Promise<void> {
  await inPrivateCheckout(owner, checkoutId, purchaseId, async () => {});
}
/** A trusted backend callback, never an Eve tool or step result. No screenshots/traces/profiles. */
export async function payTestCheckout(owner: WalletOwner, checkoutId: string, purchaseId: string, card: PaymentCard): Promise<"paid" | "unknown"> {
  await inPrivateCheckout(owner, checkoutId, purchaseId, async page => {
    let stage: CheckoutStage = "save_preference";
    try {
    const save = page.getByRole("checkbox", { name: "Save my information for faster checkout", exact: true });
    if (await save.count()) await save.evaluate((el: HTMLInputElement) => { if (el.checked) el.click(); });
    stage = "number";
    await page.locator("#cardNumber").fill(card.number);
    stage = "expiry";
    await page.locator("#cardExpiry").fill(`${String(card.exp_month).padStart(2, "0")}${String(card.exp_year).slice(-2)}`);
    stage = "cvc";
    await page.locator("#cardCvc").fill(card.cvc);
    stage = "name";
    await page.locator("#billingName").fill(card.billing_address.name);
    stage = "country";
    await page.locator("#billingCountry").selectOption(card.billing_address.country);
    stage = "postal";
    if (await page.locator("#billingPostalCode").isVisible()) await page.locator("#billingPostalCode").fill(card.billing_address.postal_code);
    stage = "final_check";
    if (new URL(page.url()).origin !== testQuote.merchantUrl || await testCheckoutStatus(checkoutId, purchaseId) !== "open") throw new Error();
    // The caller commits 'submitting' and holds the user's wallet lock BEFORE reaching here.
    stage = "submit";
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    await page.waitForURL("https://example.com/?eve_test=success", { timeout: 20_000 }).catch(() => {});
    } catch { throw new CheckoutFailure(stage); }
  });
  return await testCheckoutStatus(checkoutId, purchaseId) === "paid" ? "paid" : "unknown";
}
