import { resettableLinqChannel } from "../../src/messaging/resettable-linq-channel.js";
import { admitLinqMessage } from "../../src/identity/linq-admission.js";
import { toolResultFrom } from "eve/tools";
import sendBrowserScreenshot from "../tools/send_browser_screenshot.js";
import { requireUserScope } from "../../src/identity/user-scope.js";
import { deliverScreenshot, extractKernelScreenshot } from "../../src/browser/attachments.js";
import { screenshotState } from "../../src/browser/screenshot-state.js";
import { linqDeliveryEvents } from "../../src/messaging/linq-delivery.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to enable the Linq channel.`);
  return value;
}

export default resettableLinqChannel({
  // Lazy resolvers let the deployment build before Linq credentials are connected.
  // Supplying signingSecret selects eve's built-in signed-webhook verification.
  credentials: {
    apiKey: () => requiredEnv("LINQ_API_KEY"),
    signingSecret: () => requiredEnv("LINQ_WEBHOOK_SECRET"),
  },
  turnPolicy: "steer",
  events: {
    ...linqDeliveryEvents,
    async "action.result"({ result }, channel, ctx) {
      requireUserScope(ctx);
      const capture = extractKernelScreenshot(result);
      if (capture) {
        screenshotState.update(() => ({ screenshot: capture, receipt: null }));
        return;
      }
      const send = toolResultFrom(result, sendBrowserScreenshot);
      if (!send || send.output.status !== "queued") return;
      const { screenshot, receipt } = screenshotState.get();
      if (!screenshot || screenshot.callId !== send.output.screenshotCallId) return;
      if (receipt?.screenshotCallId === screenshot.callId && receipt.status === "sent") return;
      if (!channel.thread || !channel.thread.isDM) throw new Error("Screenshot attachments require the originating private Linq chat.");
      const nextReceipt = await deliverScreenshot(screenshot, ctx.session.id, (message, options) =>
        channel.bot.getAdapter("linq").postMessage(channel.thread!.id, message, options));
      screenshotState.update((state) => ({ ...state, receipt: nextReceipt }));
    },
  },
  async onMessage({ thread }, message) {
    return admitLinqMessage(message, thread.isDM, requiredEnv("LINQ_PHONE_NUMBER"));
  },
});
