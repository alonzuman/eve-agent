import { get, put } from "@vercel/blob";

export interface ChatOwnerStore {
  read(chatKey: string): Promise<string | null>;
  create(chatKey: string, userScope: string): Promise<void>;
}

function path(chatKey: string) {
  if (!/^[a-f0-9]{64}$/.test(chatKey)) throw new Error("Invalid chat identity.");
  // Outside eve's sandbox/file-memory namespaces; never mounted into agent tools.
  return `app-private/linq/chat-owners/${chatKey}.json`;
}

const blobOwnerStore: ChatOwnerStore = {
  async read(chatKey) {
    const result = await get(path(chatKey), { access: "private", useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200) throw new Error("Unable to verify conversation owner.");
    const owner: unknown = await new Response(result.stream).json();
    if (typeof owner !== "object" || !owner || !("userScope" in owner) ||
      typeof owner.userScope !== "string" || !/^[a-f0-9]{64}$/.test(owner.userScope)) {
      throw new Error("Invalid stored conversation owner.");
    }
    return owner.userScope;
  },
  async create(chatKey, userScope) {
    await put(path(chatKey), JSON.stringify({ version: 1, userScope }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
    });
  },
};

/** An immutable owner also protects the eve chat-to-session mapping from sender changes. */
export async function bindPrivateChat(
  chatKey: string,
  userScope: string,
  store: ChatOwnerStore = blobOwnerStore,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(userScope)) throw new Error("Invalid user scope.");
  const existing = await store.read(chatKey);
  if (existing !== null) return existing === userScope;
  try {
    await store.create(chatKey, userScope);
    return true;
  } catch (error) {
    // Concurrent first messages can race; only the winner's principal may proceed.
    const winner = await store.read(chatKey);
    if (winner === null) throw error;
    return winner === userScope;
  }
}
