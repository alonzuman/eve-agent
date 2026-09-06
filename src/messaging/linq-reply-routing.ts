import type { SessionContext } from "eve/context";
import type { ChatSdkEventContext } from "eve/channels/chat-sdk";
import { z } from "zod";
import {
  bindMessageConversation, boundMessageConversation, privateLinqChatId, requireMessageConversation,
} from "./message-references.js";

type Channel = Pick<ChatSdkEventContext, "state" | "thread">;
type Turn = { turnId: string; sequence: number };
const routeSchema = z.object({ sessionId: z.string(), turnId: z.string(), sequence: z.number().int() });

/** Eve swallows event-handler errors, so a failed binding must revoke delivery. */
export function bindLinqReplyRoute(event: Turn, channel: Channel, ctx: SessionContext): void {
  channel.state.linqReplyRoute = null;
  if (event.turnId !== ctx.session.turn.id || event.sequence !== ctx.session.turn.sequence) {
    throw new Error("Linq reply turn does not match the active session.");
  }
  if (!channel.thread?.isDM) throw new Error("Linq replies require a private Linq chat.");
  bindMessageConversation(ctx, channel.thread.id);
  channel.state.linqReplyRoute = { sessionId: ctx.session.id, turnId: event.turnId, sequence: event.sequence };
}

/** Check before sending, including completion-only output and visual cards. */
export function requireLinqReplyRoute(event: Turn, channel: Channel, ctx: SessionContext): void {
  if (!channel.thread?.isDM) throw new Error("Linq replies require a private Linq chat.");
  const route = routeSchema.parse(channel.state.linqReplyRoute);
  if (route.sessionId !== ctx.session.id || route.turnId !== event.turnId || route.sequence !== event.sequence ||
    event.turnId !== ctx.session.turn.id || event.sequence !== ctx.session.turn.sequence) {
    throw new Error("Linq reply does not belong to the active session turn.");
  }
  const scope = requireMessageConversation(ctx);
  if (scope.chatId !== privateLinqChatId(channel.thread.id)) {
    throw new Error("Linq reply belongs to another conversation.");
  }
}

/** session.failed has no auth context; use only a previously verified route. */
export function requireLinqFailureRoute(sessionId: string, channel: Channel): void {
  const route = routeSchema.parse(channel.state.linqReplyRoute);
  if (route.sessionId !== sessionId || !channel.thread?.isDM) {
    throw new Error("Linq failure does not belong to this conversation.");
  }
  boundMessageConversation(channel.thread.id);
}
