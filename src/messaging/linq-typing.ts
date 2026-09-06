/** Eve's pinned Linq adapter exposes startTyping, but not the stop endpoint. */
export async function stopLinqTyping(
  threadId: string,
  { apiKey = process.env.LINQ_API_KEY?.trim(), request = fetch }: {
    apiKey?: string;
    request?: typeof fetch;
  } = {},
): Promise<void> {
  // Match Linq's persisted private thread IDs, including the legacy :dm suffix.
  // Pending handles do not yet have a chat and must never become API paths.
  const chatId = /^linq:([^:]+)(?::dm)?$/u.exec(threadId)?.[1];
  if (!chatId || chatId === "pending") throw new Error("Invalid private Linq thread.");
  if (!apiKey) throw new Error("LINQ_API_KEY is required for typing cleanup.");
  const response = await request(`https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(chatId)}/typing`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Linq typing cleanup failed (${response.status}).`);
}
