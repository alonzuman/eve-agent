import { createClient } from "@vercel/global-config";
import { z } from "zod";

// One value keeps the enable flag and its allowlist in the same config revision.
const responsePolicySchema = z.object({
  enabled: z.boolean(),
  allowedNumbers: z.array(z.string().regex(/^\+[1-9]\d{6,14}$/).refine((value) => value === value.trim())),
});

export type ReadLinqResponsePolicy = () => Promise<unknown>;

/** Resolve lazily so builds work without credentials; read again for every message. */
export const readLinqResponsePolicy: ReadLinqResponsePolicy = async () => {
  const connection = process.env.GLOBAL_CONFIG?.trim();
  if (!connection) return undefined;
  const client = createClient(connection, {
    cache: "no-store",
    disableDevelopmentCache: true,
    // An outage must not restore an old allowlist or an old enabled flag.
    staleIfError: false,
  });
  return client.get<unknown>("linqResponses");
};

export async function assessLinqResponseAccess(
  senderHandle: string,
  readPolicy: ReadLinqResponsePolicy = readLinqResponsePolicy,
) {
  let value: unknown;
  try {
    value = await readPolicy();
  } catch {
    // Provider errors can contain credentials; expose only a fixed reason.
    return { accepted: false as const, reason: "response_policy_unavailable" as const };
  }
  const policy = responsePolicySchema.safeParse(value);
  if (!policy.success) return { accepted: false as const, reason: "response_policy_invalid" as const };
  if (!policy.data.enabled) return { accepted: false as const, reason: "responses_disabled" as const };
  if (!policy.data.allowedNumbers.includes(senderHandle)) {
    return { accepted: false as const, reason: "sender_not_allowlisted" as const };
  }
  return { accepted: true as const };
}
