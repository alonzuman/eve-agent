import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { AcceptedMessageAction } from "../messaging/message-references.js";

// Credentials and pending OAuth device codes are encrypted together, outside Eve state.
export const linkWallets = pgTable("link_wallets", {
  namespace: text().notNull(),
  principalId: text("principal_id").notNull(),
  ciphertext: text().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.namespace, table.principalId] }),
  check("link_wallets_namespace", sql`${table.namespace} ~ '^[a-f0-9]{64}$'`),
  check("link_wallets_principal", sql`${table.principalId} ~ '^[a-f0-9]{64}$'`),
]);

// Only encrypted checkout references live here; never card credentials or OAuth tokens.
export const linkPurchases = pgTable("link_purchases", {
  id: text().primaryKey(), namespace: text().notNull(), principalId: text("principal_id").notNull(),
  callKey: text("call_key").notNull(), revision: integer().notNull().default(0),
  ciphertext: text().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [unique("link_purchase_call").on(table.namespace, table.principalId, table.callKey),
  index("link_purchase_owner").on(table.namespace, table.principalId),
  check("link_purchase_namespace", sql`${table.namespace} ~ '^[a-f0-9]{64}$'`),
  check("link_purchase_principal", sql`${table.principalId} ~ '^[a-f0-9]{64}$'`),
]);

// A row is an addressable message part; multipart messages share messageId.
export const messages = pgTable("linq_messages", {
  id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  namespace: text().notNull(),
  principalId: text("principal_id").notNull(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  partIndex: integer("part_index").notNull(),
  sender: text({ enum: ["user", "agent"] }).notNull(),
  content: text().notNull(),
  partType: text("part_type").notNull(),
  replyToMessageId: text("reply_to_message_id"),
  replyToPartIndex: integer("reply_to_part_index"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("linq_messages_provider_part").on(table.namespace, table.principalId, table.chatId, table.messageId, table.partIndex),
  index("linq_messages_recent").on(table.namespace, table.principalId, table.chatId, table.id.desc()),
  check("linq_messages_namespace", sql`${table.namespace} ~ '^[a-f0-9]{64}$'`),
  check("linq_messages_principal", sql`${table.principalId} ~ '^[a-f0-9]{64}$'`),
  check("linq_messages_chat", sql`length(${table.chatId}) between 1 and 256`),
  check("linq_messages_message", sql`length(${table.messageId}) between 1 and 256`),
  check("linq_messages_part", sql`${table.partIndex} between 0 and 99`),
  check("linq_messages_sender", sql`${table.sender} in ('user', 'agent')`),
  check("linq_messages_reply", sql`(${table.replyToMessageId} is null) = (${table.replyToPartIndex} is null)
    and (${table.replyToPartIndex} is null or ${table.replyToPartIndex} between 0 and 99)`),
]);

export const messageActions = pgTable("linq_message_actions", {
  namespace: text().notNull(),
  actionKey: text("action_key").notNull(),
  principalId: text("principal_id").notNull(),
  chatId: text("chat_id").notNull(),
  targetId: bigint("target_id", { mode: "bigint" }).notNull().references(() => messages.id),
  kind: text({ enum: ["reaction", "reply"] }).notNull(),
  request: jsonb().$type<Record<string, string>>().notNull(),
  status: text({ enum: ["pending", "accepted", "unconfirmed"] }).notNull().default("pending"),
  receipt: jsonb().$type<AcceptedMessageAction>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.namespace, table.actionKey] }),
  check("linq_actions_key", sql`${table.actionKey} ~ '^[a-f0-9]{64}$'`),
  check("linq_actions_namespace", sql`${table.namespace} ~ '^[a-f0-9]{64}$'`),
  check("linq_actions_principal", sql`${table.principalId} ~ '^[a-f0-9]{64}$'`),
  check("linq_actions_kind", sql`${table.kind} in ('reaction', 'reply')`),
  check("linq_actions_status", sql`${table.status} in ('pending', 'accepted', 'unconfirmed')`),
  check("linq_actions_receipt", sql`(${table.status} = 'accepted') = (${table.receipt} is not null)`),
]);
