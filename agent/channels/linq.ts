import { resettableLinqChannel } from "../../src/messaging/resettable-linq-channel.js";
import { admitLinqMessage } from "../../src/identity/linq-admission.js";
import { toolResultFrom } from "eve/tools";
import { requireUserScope } from "../../src/identity/user-scope.js";
import presentCards from "../tools/present_cards.js";
import { visualCardsState } from "../../src/visual/card-state.js";
import { deliverCards } from "../../src/visual/deliver-cards.js";
import { cardCaption } from "../../src/visual/cards.js";
import { createLinqDeliveryEvents } from "../../src/messaging/linq-delivery.js";
import { stopLinqTyping } from "../../src/messaging/linq-typing.js";
import {
  bindMessageConversation, boundMessageConversation, inboundMessageParts, messageScope,
} from "../../src/messaging/message-references.js";
import { messageStore } from "../../src/messaging/message-store.js";
import { beginMessageActions, stopMessageActions } from "../../src/messaging/linq-message-actions.js";

const deliveryEvents = createLinqDeliveryEvents(stopLinqTyping, {
  async recordSent(threadId, text, receipt) {
    if (!receipt || typeof receipt !== "object" || !("id" in receipt) || typeof receipt.id !== "string" || !receipt.id) {
      throw new Error("Missing Linq message receipt.");
    }
    await messageStore.record(boundMessageConversation(threadId), [{
      messageId: receipt.id, partIndex: 0, sender: "agent", content: text, partType: "text", replyTo: null,
    }]);
  },
});

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
    ...deliveryEvents,
    async "turn.started"(event, channel, ctx) {
      if (event.turnId !== ctx.session.turn.id || event.sequence !== ctx.session.turn.sequence) return;
      if (!channel.thread?.isDM) throw new Error("Message references require a private Linq chat.");
      bindMessageConversation(ctx, channel.thread.id);
      beginMessageActions(event);
      await deliveryEvents["turn.started"](event, channel);
    },
    async "turn.completed"(event, channel) {
      stopMessageActions(event);
      await deliveryEvents["turn.completed"](event, channel);
    },
    async "turn.cancelled"(event, channel) {
      stopMessageActions(event);
      await deliveryEvents["turn.cancelled"](event, channel);
    },
    async "turn.failed"(event, channel) {
      stopMessageActions(event);
      await deliveryEvents["turn.failed"](event, channel);
    },
    async "action.result"({ result }, channel, ctx) {
      requireUserScope(ctx);
      const presentation = toolResultFrom(result, presentCards);
      if (!presentation || presentation.output.status !== "queued") return;
      const { current } = visualCardsState.get();
      if (!current || current.id !== presentation.output.setId) return;
      if (!channel.thread?.isDM) throw new Error("Visual cards require the originating private Linq chat.");
      const receipt = current.receipt?.status === "sent" ? current.receipt
        : await deliverCards(current, ctx.session.id, (message, options) =>
          channel.bot.getAdapter("linq").postMessage(channel.thread!.id, message, options));
      visualCardsState.update(state => ({
        ...state,
        current: { ...current, receipt, images: receipt.status === "sent" ? [] : current.images },
        lastSent: receipt.status === "sent" && receipt.messageId
          ? { id: current.id, set: current.set, messageId: receipt.messageId }
          : state.lastSent,
      }));
      // A replay can repair a failed DB write using the saved provider receipt.
      if (receipt.status === "sent" && receipt.messageId) {
        const sent = { messageId: receipt.messageId, sender: "agent" as const, replyTo: null };
        await messageStore.record(messageScope(ctx, channel.thread.id), [
          { ...sent, partIndex: 0, partType: "text", content: cardCaption(current.set) },
          ...current.set.cards.map((card, index) => ({
            ...sent, partIndex: index + 1, partType: "media", content: `[visual card attachment: ${card.label}]`,
          })),
        ]);
      }
    },
  },
  async onMessage({ thread }, message) {
    return admitLinqMessage(message, thread.isDM, requiredEnv("LINQ_PHONE_NUMBER"));
  },
  async onAdmittedMessage({ thread }, message, admission) {
    const scope = messageScope({ session: { auth: { current: admission.auth, initiator: admission.auth } } }, thread.id);
    try {
      const references = await messageStore.record(scope, inboundMessageParts(message));
      return { ...admission, context: [...admission.context ?? [],
        `Incoming iMessage references: ${references.map(ref => `${ref.ref} (part ${ref.partIndex})`).join(", ")}.`],
      };
    } catch {
      // The adapter acknowledges webhook callbacks even on errors. Give the
      // admitted sender an explicit retry notice instead of silently losing input.
      console.warn("[linq] inbound message storage failed");
      await thread.post("messaging is temporarily unavailable. please try again shortly.");
      return null;
    }
  },
});
