import { createHash } from "node:crypto";

/** Narrow structural view of eve's normalized Linq message. Raw data is signed by Linq first. */
export interface LinqMessage {
  readonly id: string;
  readonly threadId: string;
  readonly raw: unknown;
  readonly author: {
    readonly userId: string;
    readonly userName: string;
    readonly isBot: boolean | "unknown";
    readonly isMe?: boolean;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Avoid aliases that could merge people; phone numbers must already be E.164. */
export function canonicalHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\+[1-9]\d{6,14}$/.test(value)) return value;
  // Preserve the local part: not all email providers treat its case identically.
  const email = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(value);
  return email ? `${email[1]}@${email[2].toLowerCase()}` : null;
}

export function identityDigest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export type LinqRejectionReason =
  | "thread_not_private" | "bot_or_unknown_author" | "self_message"
  | "configured_line_invalid" | "sender_handle_invalid" | "sender_is_configured_line"
  | "direction_not_inbound" | "chat_group_flag_missing" | "chat_is_group"
  | "owner_handle_missing" | "owner_self_flag_missing_or_false" | "owner_line_mismatch"
  | "sender_self_flag_missing_or_true" | "sender_id_missing" | "chat_id_missing"
  | "message_id_missing" | "message_id_mismatch" | "thread_id_mismatch"
  | "author_id_mismatch" | "author_handle_mismatch";

/** Assessment contains only a fixed rejection code; it is safe to log that code. */
export function assessPrivateLinqIdentity(message: LinqMessage, isDM: boolean, line: string) {
  const reject = (reason: LinqRejectionReason) => ({ accepted: false as const, reason });
  if (!isDM) return reject("thread_not_private");
  if (message.author.isBot !== false) return reject("bot_or_unknown_author");
  if (message.author.isMe === true) return reject("self_message");
  const raw = record(message.raw);
  const chat = record(raw?.chat);
  const owner = record(chat?.owner_handle);
  const sender = record(raw?.sender_handle);
  const configuredLine = canonicalHandle(line);
  const senderHandle = canonicalHandle(sender?.handle);
  if (!configuredLine) return reject("configured_line_invalid");
  if (!senderHandle) return reject("sender_handle_invalid");
  if (senderHandle === configuredLine) return reject("sender_is_configured_line");
  if (raw?.direction !== "inbound") return reject("direction_not_inbound");
  if (typeof chat?.is_group !== "boolean") return reject("chat_group_flag_missing");
  if (chat.is_group) return reject("chat_is_group");
  if (!owner) return reject("owner_handle_missing");
  if (owner.is_me !== true) return reject("owner_self_flag_missing_or_false");
  if (canonicalHandle(owner.handle) !== configuredLine) return reject("owner_line_mismatch");
  if (sender?.is_me !== false) return reject("sender_self_flag_missing_or_true");
  if (typeof sender.id !== "string" || !sender.id) return reject("sender_id_missing");
  if (typeof chat.id !== "string" || !chat.id) return reject("chat_id_missing");
  if (typeof raw.id !== "string" || !raw.id) return reject("message_id_missing");
  if (message.id !== raw.id) return reject("message_id_mismatch");
  if (message.threadId !== `linq:${chat.id}`) return reject("thread_id_mismatch");
  if (message.author.userId !== sender.id) return reject("author_id_mismatch");
  if (canonicalHandle(message.author.userName) !== senderHandle) return reject("author_handle_mismatch");

  const issuer = `linq:${configuredLine}`;
  const principalId = identityDigest([issuer, senderHandle]);
  return {
    accepted: true as const,
    identity: {
      chatKey: identityDigest([issuer, chat.id]),
      auth: {
        authenticator: "linq-private",
        issuer,
        principalType: "user",
        principalId,
        subject: principalId,
        attributes: {},
      },
    },
  };
}

/** Reject groups, unknown senders, wrong lines and contradictory normalized identities. */
export function privateLinqIdentity(message: LinqMessage, isDM: boolean, line: string) {
  const assessment = assessPrivateLinqIdentity(message, isDM, line);
  return assessment.accepted ? assessment.identity : null;
}
