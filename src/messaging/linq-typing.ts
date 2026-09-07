interface TypingOptions {
  apiKey?: string;
  request?: typeof fetch;
  signal?: AbortSignal;
}

async function setLinqTyping(
  threadId: string,
  method: "POST" | "DELETE",
  { apiKey = process.env.LINQ_API_KEY?.trim(), request = fetch, signal }: TypingOptions,
): Promise<void> {
  // Match Linq's persisted private thread IDs, including the legacy :dm suffix.
  // Pending handles do not yet have a chat and must never become API paths.
  const chatId = /^linq:([^:]+)(?::dm)?$/u.exec(threadId)?.[1];
  if (!chatId || chatId === "pending") throw new Error("Invalid private Linq thread.");
  if (!apiKey) throw new Error("LINQ_API_KEY is required for typing cleanup.");
  const response = await request(`https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(chatId)}/typing`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    redirect: "error",
  });
  // Match the pinned adapter: typing may be unavailable for this chat.
  if (method === "POST" && response.status === 403) return;
  if (!response.ok) throw new Error(`Linq typing ${method === "DELETE" ? "cleanup" : "start"} failed (${response.status}).`);
}

export const startLinqTyping = (threadId: string, options: TypingOptions = {}) => setLinqTyping(threadId, "POST", options);
/** Eve's pinned Linq adapter exposes startTyping, but not the stop endpoint. */
export const stopLinqTyping = (threadId: string, options: TypingOptions = {}) => setLinqTyping(threadId, "DELETE", options);
