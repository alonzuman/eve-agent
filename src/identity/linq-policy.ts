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

/** Reject groups, unknown senders, wrong lines and contradictory normalized identities. */
export function privateLinqIdentity(message: LinqMessage, isDM: boolean, line: string) {
  if (!isDM || message.author.isBot !== false || message.author.isMe === true) return null;
  const raw = record(message.raw);
  const chat = record(raw?.chat);
  const owner = record(chat?.owner_handle);
  const sender = record(raw?.sender_handle);
  const configuredLine = canonicalHandle(line);
  const senderHandle = canonicalHandle(sender?.handle);
  if (
    !configuredLine || !senderHandle || senderHandle === configuredLine ||
    raw?.direction !== "inbound" || chat?.is_group !== false ||
    owner?.is_me !== true || canonicalHandle(owner.handle) !== configuredLine ||
    sender?.is_me !== false || typeof sender.id !== "string" || !sender.id ||
    typeof chat.id !== "string" || !chat.id ||
    typeof raw.id !== "string" || !raw.id ||
    message.id !== raw.id || message.threadId !== `linq:${chat.id}` ||
    message.author.userId !== sender.id ||
    canonicalHandle(message.author.userName) !== senderHandle
  ) return null;

  const issuer = `linq:${configuredLine}`;
  const principalId = identityDigest([issuer, senderHandle]);
  return {
    chatKey: identityDigest([issuer, chat.id]),
    auth: {
      authenticator: "linq-private",
      issuer,
      principalType: "user",
      principalId,
      subject: principalId,
      attributes: {},
    },
  };
}
