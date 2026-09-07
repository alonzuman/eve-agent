import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import { z } from "zod";
import {
  requireMessageConversation, type MessageReference, type AcceptedMessageAction,
} from "./message-references.js";
import { messageStore, type MessageStore } from "./message-store.js";
import type { UserScopedContext } from "../identity/user-scope.js";
import { deliveryTiming, sendLinqBubble, splitBubbles, type BubbleDeliveryState, type DeliveryTiming } from "./linq-bubbles.js";
import { startLinqTyping } from "./linq-typing.js";

export const messageTargetSchema = z.string().regex(/^m[1-9]\d{0,18}$/u);
// Unicode's RGI sequences include skin tones, flags, keycaps and ZWJ families.
export const reactionEmojiSchema = z.string().max(64).refine(
  value => /^(?:\p{RGI_Emoji}|[❤‼❗❓])$/v.test(value), "Use one Unicode emoji.",
);
export const replyTextSchema = z.string().trim().min(1).max(10_000).refine(
  value => !value.includes("<eve-empty-delivery/>") && !value.includes("&lt;eve-empty-delivery/&gt;"),
  "A threaded reply must contain user-facing text.",
);

type Action = { kind: "reaction"; target: string; emoji: string } | { kind: "reply"; target: string; text: string };
export type MessageActionReceipt = AcceptedMessageAction | {
  status: "unconfirmed"; target: string; error: string;
};
type ActionContext = UserScopedContext & {
  session: { id: string; turn: { id: string; sequence: number } };
  abortSignal: AbortSignal;
};

// Turn-wide pacing and echo suppression survive tool/channel step restoration.
// Durable provider receipts and atomic claims remain in Postgres.
export const messageActionState = defineState<{
  turnId: string | null;
  sequence: number;
  stopped: boolean;
  delivery?: BubbleDeliveryState;
}>("personal-assistant.linq-message-actions", () => ({ turnId: null, sequence: -1, stopped: true }));

export function beginMessageActions(turn: { turnId: string; sequence: number }): void {
  const state = messageActionState.get();
  if (turn.sequence <= state.sequence) return;
  messageActionState.update(() => ({ ...turn, stopped: false, delivery: { sentCount: 0 } }));
}

export function messageTurnDelivery(turn: { turnId: string; sequence: number }): BubbleDeliveryState {
  const state = messageActionState.get();
  if (state.stopped || state.turnId !== turn.turnId || state.sequence !== turn.sequence) {
    throw new Error("This message action belongs to an inactive turn.");
  }
  // Sessions started before this field was introduced may resume after deployment.
  return state.delivery ??= { sentCount: 0 };
}

export function stopMessageActions(turn: { turnId: string; sequence: number }): void {
  const state = messageActionState.get();
  if (state.turnId === turn.turnId && state.sequence === turn.sequence) {
    messageActionState.update(state => ({ ...state, stopped: true }));
  }
}

export function messageActionKey(sessionId: string, turnId: string, chatId: string, target: MessageReference, action: Action): string {
  return createHash("sha256").update(JSON.stringify([
    "linq-message-action", sessionId, turnId, chatId, target.messageId, target.partIndex,
    action.kind, action.kind === "reaction" ? action.emoji : action.text,
  ])).digest("hex");
}

export function reactionPayload(emoji: string, partIndex: number) {
  const standard: Record<string, string> = {
    "❤️": "love", "❤": "love", "👍": "like", "👎": "dislike", "😂": "laugh",
    "‼️": "emphasize", "‼": "emphasize", "❗": "emphasize", "❓": "question",
  };
  return {
    operation: "add", part_index: partIndex,
    ...(standard[emoji] ? { type: standard[emoji] } : { type: "custom", custom_emoji: emoji }),
  };
}

/** Server-owned transport: no destination, provider ID or credential is model input. */
export async function performMessageAction(
  action: Action, ctx: ActionContext,
  { apiKey = process.env.LINQ_API_KEY?.trim(), request = fetch, store = messageStore, ...timingOverrides }: {
    apiKey?: string; request?: typeof fetch; store?: MessageStore;
    random?: DeliveryTiming["random"]; sleep?: DeliveryTiming["sleep"];
  } = {},
): Promise<MessageActionReceipt> {
  const scope = requireMessageConversation(ctx);
  const { chatId } = scope;
  const target = await store.resolve(scope, messageTargetSchema.parse(action.target));
  if (!target) throw new Error("Unknown message reference. Use a reference provided in this conversation; never guess one.");
  if (action.kind === "reaction") reactionEmojiSchema.parse(action.emoji);
  else action = { ...action, text: replyTextSchema.parse(action.text) };
  ctx.abortSignal.throwIfAborted();
  const turn = { turnId: ctx.session.turn.id, sequence: ctx.session.turn.sequence };
  const delivery = messageTurnDelivery(turn);
  const active = () => {
    const state = messageActionState.get();
    return !ctx.abortSignal.aborted && !state.stopped && state.turnId === turn.turnId && state.sequence === turn.sequence;
  };
  if (!apiKey) throw new Error("Linq messaging is temporarily unavailable.");
  const key = messageActionKey(ctx.session.id, ctx.session.turn.id, chatId, target, action);
  const unconfirmed: MessageActionReceipt = {
    status: "unconfirmed", target: action.target,
    error: "Linq has not confirmed this action. Do not claim success or automatically resend it or substitute an ordinary message.",
  };
  const claim = await store.claim(scope, key, action.target, action.kind,
    action.kind === "reaction" ? { emoji: action.emoji } : { text: action.text });
  const bubbles = action.kind === "reply" ? splitBubbles(action.text) : [];
  if (bubbles.length) {
    // Reserve the full reply, including an ambiguous or interrupted batch. Never
    // substitute its text through the unthreaded channel, including on replay.
    const replies = delivery.threadedReplies ??= [];
    if (!replies.some(reply => JSON.stringify(reply) === JSON.stringify(bubbles))) replies.push(bubbles);
  }
  if (!claim.claimed) return claim.receipt ?? unconfirmed;
  const path = action.kind === "reaction"
    ? `/messages/${encodeURIComponent(target.messageId)}/reactions`
    : `/chats/${encodeURIComponent(chatId)}/messages`;
  const post = async (body: unknown) => {
    ctx.abortSignal.throwIfAborted();
    if (!active()) throw new Error("This message action belongs to an inactive turn.");
    const response = await request(`https://api.linqapp.com/api/partner/v3${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error",
      signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("Linq did not accept the action.");
    return response;
  };
  try {
    if (action.kind === "reaction") {
      await post(reactionPayload(action.emoji, target.partIndex));
      return await store.accept(scope, key, action.target);
    }
    const timing = deliveryTiming(timingOverrides);
    for (const [index, text] of bubbles.entries()) {
      const sent = await sendLinqBubble(text, {
        state: delivery, active, timing,
        startTyping: () => startLinqTyping(`linq:${chatId}`, { apiKey, request, signal: ctx.abortSignal }),
        post: () => post({ message: {
          parts: [{ type: "text", value: text }], preferred_service: "iMessage",
          reply_to: { message_id: target.messageId, part_index: target.partIndex },
          // Preserve existing single-bubble keys; repeated text at different
          // positions within one reply must still produce distinct bubbles.
          idempotency_key: bubbles.length === 1 ? key
            : createHash("sha256").update(JSON.stringify([key, index])).digest("hex"),
        } }),
      });
      if (!sent) throw new Error("Threaded reply interrupted.");
      const result = z.object({
        chat_id: z.string(), message: z.object({ id: z.string().min(1) }),
      }).parse(await sent.receipt.json());
      if (result.chat_id !== chatId) throw new Error("Unexpected Linq conversation receipt.");
      const message = {
        messageId: result.message.id, partIndex: 0, sender: "agent" as const, content: text, partType: "text",
        replyTo: { messageId: target.messageId, partIndex: target.partIndex },
      };
      if (index === bubbles.length - 1) return await store.accept(scope, key, action.target, message);
      // Retain references for already accepted bubbles even if a later one fails.
      await store.record(scope, [message]);
    }
    throw new Error("Threaded reply has no bubbles.");
  } catch {
    // A timeout/cancellation may occur after provider acceptance. No blind retry.
    await store.unconfirmed(scope, key).catch(() => {});
    return unconfirmed;
  }
}
