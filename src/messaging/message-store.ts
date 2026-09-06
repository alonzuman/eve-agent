import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDatabase, type Database } from "../database/postgres.js";
import { messages, messageActions } from "../database/schema.js";
import type { AcceptedMessageAction, MessageInput, MessageReference, MessageScope } from "./message-references.js";

export type ActionClaim = { claimed: true } | { claimed: false; receipt: AcceptedMessageAction | null };
export interface MessageStore {
  record(scope: MessageScope, input: readonly MessageInput[]): Promise<MessageReference[]>;
  recent(scope: MessageScope): Promise<MessageReference[]>;
  resolve(scope: MessageScope, ref: string): Promise<MessageReference | null>;
  claim(scope: MessageScope, key: string, target: string, kind: "reaction" | "reply", request: Record<string, string>): Promise<ActionClaim>;
  accept(scope: MessageScope, key: string, target: string, sent?: MessageInput): Promise<AcceptedMessageAction>;
  unconfirmed(scope: MessageScope, key: string): Promise<void>;
}

function refId(ref: string): bigint {
  if (!/^m[1-9]\d{0,18}$/u.test(ref) || BigInt(ref.slice(1)) > 9223372036854775807n) throw new Error("Invalid message reference.");
  return BigInt(ref.slice(1));
}
const messageFilter = (scope: MessageScope) => and(
  eq(messages.namespace, scope.namespace), eq(messages.principalId, scope.principalId), eq(messages.chatId, scope.chatId),
);
const actionFilter = (scope: MessageScope, key: string) => and(
  eq(messageActions.namespace, scope.namespace), eq(messageActions.principalId, scope.principalId),
  eq(messageActions.chatId, scope.chatId), eq(messageActions.actionKey, key),
);
function reference(row: typeof messages.$inferSelect): MessageReference {
  return {
    ref: `m${row.id}`, messageId: row.messageId, partIndex: row.partIndex, sender: row.sender,
    content: row.content, partType: row.partType,
    replyTo: row.replyToMessageId ? { messageId: row.replyToMessageId, partIndex: row.replyToPartIndex! } : null,
  };
}
async function record(db: Pick<Database, "insert">, scope: MessageScope, input: readonly MessageInput[]): Promise<MessageReference[]> {
  if (!input.length) return [];
  const rows = await db.insert(messages).values(input.map(message => ({
    ...scope, messageId: message.messageId, partIndex: message.partIndex, sender: message.sender,
    content: message.content, partType: message.partType,
    replyToMessageId: message.replyTo?.messageId ?? null, replyToPartIndex: message.replyTo?.partIndex ?? null,
  }))).onConflictDoUpdate({
    target: [messages.namespace, messages.principalId, messages.chatId, messages.messageId, messages.partIndex],
    // Return the existing identity without replacing original message content.
    set: { messageId: sql`${messages.messageId}` },
  }).returning();
  return rows.map(reference);
}

export function createMessageStore(database: () => Database): MessageStore {
  async function safely<T>(run: (db: Database) => Promise<T>): Promise<T> {
    try { return await run(database()); }
    catch { throw new Error("Message storage is temporarily unavailable."); }
  }
  return {
    record: (scope, input) => safely(db => record(db, scope, input)),
    recent: scope => safely(async db => {
      const recent = await db.select().from(messages).where(messageFilter(scope)).orderBy(desc(messages.id)).limit(40);
      const targets = recent.flatMap(message => message.replyToMessageId ? [and(
        eq(messages.messageId, message.replyToMessageId), eq(messages.partIndex, message.replyToPartIndex!),
      )] : []);
      const parents = targets.length ? await db.select().from(messages).where(and(messageFilter(scope), or(...targets))) : [];
      const rows = new Map([...parents, ...recent].map(message => [message.id, message]));
      return [...rows.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(reference);
    }),
    resolve: (scope, ref) => safely(async db => {
      const rows = await db.select().from(messages).where(and(messageFilter(scope), eq(messages.id, refId(ref))));
      return rows[0] ? reference(rows[0]) : null;
    }),
    claim: (scope, key, target, kind, request) => safely(async db => {
      const targetId = refId(target);
      const rows = await db.select({ id: messages.id }).from(messages).where(and(messageFilter(scope), eq(messages.id, targetId)));
      if (!rows.length) throw new Error("Unknown message action target.");
      const inserted = await db.insert(messageActions).values({
        ...scope, actionKey: key, targetId, kind, request,
      }).onConflictDoNothing().returning({ key: messageActions.actionKey });
      if (inserted.length) return { claimed: true };
      const existing = await db.select({ receipt: messageActions.receipt }).from(messageActions).where(actionFilter(scope, key));
      if (!existing.length) throw new Error("Unknown message action.");
      return { claimed: false, receipt: existing[0]!.receipt };
    }),
    accept: (scope, key, target, sent) => safely(db => db.transaction(async tx => {
      const saved = sent ? await record(tx, scope, [sent]) : [];
      const receipt: AcceptedMessageAction = {
        status: "accepted", target,
        ...(sent ? { messageId: sent.messageId, ref: saved[0]!.ref } : {}),
      };
      const updated = await tx.update(messageActions).set({ status: "accepted", receipt, updatedAt: new Date() })
        .where(and(actionFilter(scope, key), eq(messageActions.targetId, refId(target))))
        .returning({ key: messageActions.actionKey });
      if (!updated.length) throw new Error("Unknown message action.");
      return receipt;
    })),
    unconfirmed: (scope, key) => safely(async db => {
      await db.update(messageActions).set({ status: "unconfirmed", updatedAt: new Date() })
        .where(and(actionFilter(scope, key), eq(messageActions.status, "pending")));
    }),
  };
}

export const messageStore = createMessageStore(getDatabase);
