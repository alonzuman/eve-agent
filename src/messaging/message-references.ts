import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import { z } from "zod";
import { requireUserScope, type UserScopedContext } from "../identity/user-scope.js";

export interface MessageScope { namespace: string; principalId: string; chatId: string }
export interface MessageTarget { messageId: string; partIndex: number }
export interface MessageInput extends MessageTarget {
  sender: "user" | "agent";
  content: string;
  partType: string;
  replyTo: MessageTarget | null;
}
export interface MessageReference extends MessageInput { ref: string }
export type AcceptedMessageAction = { status: "accepted"; target: string; messageId?: string; ref?: string };

// Only routing identity is session state. Messages and action receipts live in PG.
const conversation = defineState<MessageScope | null>("personal-assistant.linq-conversation", () => null);

export function privateLinqChatId(threadId: string): string {
  const chatId = /^linq:([^:]+)(?::dm)?$/u.exec(threadId)?.[1];
  if (!chatId || chatId === "pending") throw new Error("Invalid private Linq thread.");
  return chatId;
}

export function messageNamespace(env = process.env): string {
  const environment = env.VERCEL_ENV || "development";
  return createHash("sha256").update(JSON.stringify([
    env.VERCEL_PROJECT_ID || "eve-personal-agent", environment,
    environment === "production" ? "" : env.VERCEL_GIT_COMMIT_REF || "local",
  ])).digest("hex");
}

export function messageScope(ctx: UserScopedContext, threadId: string): MessageScope {
  return { namespace: messageNamespace(), principalId: requireUserScope(ctx), chatId: privateLinqChatId(threadId) };
}

export function bindMessageConversation(ctx: UserScopedContext, threadId: string): void {
  const scope = messageScope(ctx, threadId);
  const previous = conversation.get();
  if (previous && (previous.principalId !== scope.principalId || previous.chatId !== scope.chatId || previous.namespace !== scope.namespace)) {
    throw new Error("Message references belong to another conversation.");
  }
  conversation.update(() => scope);
}

export function requireMessageConversation(ctx: UserScopedContext): MessageScope {
  const principalId = requireUserScope(ctx);
  const scope = conversation.get();
  if (!scope || scope.principalId !== principalId || scope.namespace !== messageNamespace()) {
    throw new Error("A verified private Linq conversation is required for message actions.");
  }
  return scope;
}

/** For the channel's ordered send callback, after turn.started bound auth. */
export function boundMessageConversation(threadId: string): MessageScope {
  const scope = conversation.get();
  if (!scope || scope.chatId !== privateLinqChatId(threadId) || scope.namespace !== messageNamespace()) {
    throw new Error("Missing verified Linq conversation.");
  }
  return scope;
}

/** Called only after signed-message admission and account generation selection. */
export function inboundMessageParts(message: { id: string; raw: unknown }): MessageInput[] {
  const raw = z.object({
    parts: z.array(z.object({ type: z.string(), value: z.string().optional() }).passthrough()).max(100),
    reply_to: z.object({ message_id: z.string(), part_index: z.number().int().min(0).max(99).optional() }).nullish(),
  }).parse(message.raw);
  return raw.parts.map((part, partIndex) => ({
    messageId: message.id, partIndex, sender: "user", partType: part.type,
    content: (part.type === "text" || part.type === "link") ? part.value ?? "" : `[${part.type} attachment]`,
    replyTo: raw.reply_to ? { messageId: raw.reply_to.message_id, partIndex: raw.reply_to.part_index ?? 0 } : null,
  }));
}

export function renderMessageReferences(messages: readonly MessageReference[]): string {
  return JSON.stringify(messages.map(message => ({
    ref: message.ref, sender: message.sender, preview: message.content.slice(0, 400),
    replyTo: message.replyTo ? messages.find(candidate => candidate.messageId === message.replyTo!.messageId &&
      candidate.partIndex === message.replyTo!.partIndex)?.ref ?? "unavailable earlier message" : null,
  })));
}
