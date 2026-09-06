import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { z } from "zod";
import { identityDigest } from "./linq-policy.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = digest.nullable();
const chats = z.array(z.string().regex(/^linq:.+$/));
const accountSchema = z.object({
  version: z.literal(1),
  generation,
  chats,
  // Retain hashed command IDs so even an old webhook retry cannot reset again.
  resetIds: z.array(digest),
  pendingReset: z.object({ generation, chats }).nullable(),
});

export type LinqAccount = z.infer<typeof accountSchema>;
export interface StoredLinqAccount {
  readonly state: LinqAccount;
  readonly etag: string;
}
export interface LinqAccountStore {
  read(principalId: string): Promise<StoredLinqAccount | null>;
  /** Compare-and-swap; false means another request changed the account. */
  write(principalId: string, state: LinqAccount, etag: string | null): Promise<boolean>;
}

function path(principalId: string): string {
  digest.parse(principalId);
  // Control records stay outside memory and sandbox namespaces.
  return `app-private/linq/accounts/${principalId}.json`;
}

export const blobLinqAccountStore: LinqAccountStore = {
  async read(principalId) {
    const result = await get(path(principalId), { access: "private", useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new Error("Unable to read Linq account.");
    return {
      state: accountSchema.parse(await new Response(result.stream).json()),
      etag: result.blob.etag,
    };
  },
  async write(principalId, state, etag) {
    try {
      await put(path(principalId), JSON.stringify(state), {
        access: "private", addRandomSuffix: false, allowOverwrite: etag !== null,
        ifMatch: etag ?? undefined, contentType: "application/json",
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      // A racing create (or a lost success response) must be read back before retrying.
      const current = await blobLinqAccountStore.read(principalId);
      if (current && current.etag !== etag) return false;
      throw error;
    }
  },
};

export function accountPrincipal(principalId: string, generation: string | null): string {
  // Keep pre-feature memory and browser projects until the user actually resets.
  return generation === null ? principalId : identityDigest([principalId, "account", generation]);
}

export function accountAddress(threadId: string, generation: string | null): string {
  return generation === null ? threadId : `${threadId}:account:${generation}`;
}

/** Rotate the whole account, while keeping phone verification and chat ownership stable. */
export async function prepareLinqAccount(
  input: {
    readonly principalId: string;
    readonly threadId: string;
    readonly resetMessageId?: string;
    readonly retire: (address: string) => Promise<unknown>;
  },
  store: LinqAccountStore = blobLinqAccountStore,
): Promise<string | null> {
  const resetId = input.resetMessageId === undefined ? null
    : identityDigest([input.threadId, input.resetMessageId]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const stored = await store.read(input.principalId);
    const state: LinqAccount = stored?.state ?? {
      version: 1, generation: null, chats: [], resetIds: [], pendingReset: null,
    };
    const etag = stored?.etag ?? null;
    if (state.pendingReset) {
      // Persist this work BEFORE retiring sessions. Any later request can resume
      // interrupted cleanup; new turns cannot enter the account until it finishes.
      for (const chat of state.pendingReset.chats) {
        await input.retire(accountAddress(chat, state.pendingReset.generation));
      }
      await store.write(input.principalId, { ...state, pendingReset: null }, etag);
      continue;
    }
    if (resetId !== null) {
      if (state.resetIds.includes(resetId)) return state.generation;
      const next: LinqAccount = {
        version: 1,
        generation: identityDigest([input.principalId, "reset", resetId]),
        chats: [],
        resetIds: [...state.resetIds, resetId],
        pendingReset: {
          generation: state.generation,
          chats: [...new Set([...state.chats, input.threadId])],
        },
      };
      await store.write(input.principalId, next, etag);
      continue;
    }
    if (state.chats.includes(input.threadId)) return state.generation;
    if (await store.write(input.principalId, { ...state, chats: [...state.chats, input.threadId] }, etag)) {
      return state.generation;
    }
  }
  throw new Error("Linq account changed too often. Retry the message.");
}
