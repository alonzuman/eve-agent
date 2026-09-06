import { resettableLinqChannel } from "../../src/messaging/resettable-linq-channel.js";
import { admitLinqMessage } from "../../src/identity/linq-admission.js";
import { toolResultFrom } from "eve/tools";
import { requireUserScope } from "../../src/identity/user-scope.js";
import { linqDeliveryEvents } from "../../src/messaging/linq-delivery.js";
import presentCards from "../tools/present_cards.js";
import { visualCardsState } from "../../src/visual/card-state.js";
import { deliverCards } from "../../src/visual/deliver-cards.js";

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
      const presentation = toolResultFrom(result, presentCards);
      if (!presentation || presentation.output.status !== "queued") return;
      const { current } = visualCardsState.get();
      if (!current || current.id !== presentation.output.setId || current.receipt?.status === "sent") return;
      if (!channel.thread?.isDM) throw new Error("Visual cards require the originating private Linq chat.");
      const receipt = await deliverCards(current, ctx.session.id, (message, options) =>
        channel.bot.getAdapter("linq").postMessage(channel.thread!.id, message, options));
      visualCardsState.update(state => ({
        ...state,
        current: { ...current, receipt, images: receipt.status === "sent" ? [] : current.images },
        lastSent: receipt.status === "sent" && receipt.messageId
          ? { id: current.id, set: current.set, messageId: receipt.messageId }
          : state.lastSent,
      }));
    },
  },
  async onMessage({ thread }, message) {
    return admitLinqMessage(message, thread.isDM, requiredEnv("LINQ_PHONE_NUMBER"));
  },
});
