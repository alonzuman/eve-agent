import { createClient, Reason, type EvaluationResult } from "@vercel/flags-core";

export const LINQ_RESPONSES_FLAG = "linq-responses";
export type EvaluateLinqResponseFlag = (senderHandle: string) => Promise<EvaluationResult<unknown>>;

/** Fetch current targeting for each webhook; never fall back to an old allowlist. */
export const evaluateLinqResponseFlag: EvaluateLinqResponseFlag = async (senderHandle) => {
  const sdkKey = process.env.FLAGS?.trim();
  if (!sdkKey) throw new Error("Linq response flag is not configured.");
  const request = new AbortController();
  const client = createClient(sdkKey, {
    buildStep: false,
    stream: false,
    polling: { intervalMs: 30_000, initTimeoutMs: 2_000 },
    // A provided empty datafile takes precedence over embedded definitions if the
    // initial refresh fails. A new client prevents reuse of a previous allowlist.
    datafile: { definitions: {}, environment: "unconfigured", projectId: "" },
    disableMetrics: true,
    async fetch(input, init) {
      try {
        return await fetch(input, {
          ...init,
          cache: "no-store",
          signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : [])]),
        });
      } catch {
        // The SDK logs fetch errors. Keep credentials and sender data out of them.
        throw new Error("Linq response flag refresh failed.");
      }
    },
  });
  try {
    await client.initialize();
    return await client.evaluate<unknown>(LINQ_RESPONSES_FLAG, false, { user: { id: senderHandle } });
  } finally {
    request.abort();
    await client.shutdown();
  }
};

export async function assessLinqResponseAccess(
  senderHandle: string,
  evaluateFlag: EvaluateLinqResponseFlag = evaluateLinqResponseFlag,
) {
  if (!/^\+[1-9]\d{6,14}$/.test(senderHandle) || senderHandle !== senderHandle.trim()) {
    return { accepted: false as const, reason: "sender_not_allowlisted" as const };
  }
  let result: EvaluationResult<unknown>;
  try {
    result = await evaluateFlag(senderHandle);
  } catch {
    return { accepted: false as const, reason: "response_flag_unavailable" as const };
  }
  if (result.reason === Reason.ERROR) {
    return { accepted: false as const, reason: "response_flag_unavailable" as const };
  }
  if (typeof result.value !== "boolean") {
    return { accepted: false as const, reason: "response_flag_invalid" as const };
  }
  if (result.reason === Reason.PAUSED) {
    return { accepted: false as const, reason: "responses_disabled" as const };
  }
  // Require an explicit target. Broad rules or a true fallback must not let
  // numbers outside the allowlist through, even if the flag is misconfigured.
  if (result.value !== true || result.reason !== Reason.TARGET_MATCH) {
    return { accepted: false as const, reason: "sender_not_allowlisted" as const };
  }
  return { accepted: true as const };
}
