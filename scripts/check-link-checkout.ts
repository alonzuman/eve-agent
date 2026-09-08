/** Real Stripe sandbox + real private Kernel browser; synthetic Stripe test card.
 * Verifies the merchant adapter. The separate user test_link_purchase workflow
 * must also pass to verify Link authentication and user approval end to end.
 */
import { createHash, randomUUID } from "node:crypto";
import { createTestCheckout, inspectTestCheckout, payTestCheckout, testCheckoutStatus } from "../src/payments/test-checkout.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const owner = { namespace: hash("eve-sandbox-checkout-smoke"), principalId: hash("synthetic-sandbox-user") };
const id = randomUUID();
try {
  const checkoutId = await createTestCheckout(id);
  await inspectTestCheckout(owner, checkoutId, id);
  const outcome = await payTestCheckout(owner, checkoutId, id, {
    number: "4242424242424242", cvc: "123", exp_month: 12, exp_year: 2030,
    valid_until: Math.floor(Date.now() / 1000) + 3600,
    billing_address: { name: "Eve Sandbox Test", country: "US", postal_code: "10001" },
  });
  if (outcome !== "paid" || await testCheckoutStatus(checkoutId, id) !== "paid") throw new Error();
  console.log("PASS: real Stripe sandbox reports $5 checkout paid through the private Kernel adapter. No live charge. Link user approval still requires the agent workflow test.");
} catch (error) {
  console.error("FAIL: sandbox checkout was not confirmed. Provider details and payment inputs withheld.");
  if (error instanceof Error && /^Private sandbox checkout stopped at [a-z_]+\. Verify its outcome before retrying\.$/.test(error.message)) console.error(error.message);
  process.exitCode = 1;
}
