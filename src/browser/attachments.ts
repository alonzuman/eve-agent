import { createHash } from "node:crypto";

export interface Screenshot {
  callId: string;
  data: string;
  mimeType: "image/png" | "image/jpeg";
}

export type DeliveryReceipt = {
  screenshotCallId: string;
  status: "sent" | "failed";
  messageId?: string;
  error?: string;
};

export interface ScreenshotState {
  screenshot: Screenshot | null;
  receipt: DeliveryReceipt | null;
}

const MAX_BYTES = 10 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Accept only inline image bytes from the Kernel screenshot tool, never URLs. */
export function extractKernelScreenshot(result: unknown): Screenshot | null {
  if (!record(result) || result.kind !== "tool-result" || result.isError === true ||
      result.toolName !== "kernel__browser__computer_action" || typeof result.callId !== "string") return null;
  const output = result.output;
  if (!record(output) || output.isError === true || !Array.isArray(output.content)) return null;
  for (const part of output.content) {
    if (!record(part) || part.type !== "image") continue;
    if (part.mimeType !== "image/png" && part.mimeType !== "image/jpeg") continue;
    if (typeof part.data !== "string" || part.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
        part.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(part.data)) continue;
    const bytes = Buffer.from(part.data, "base64");
    if (bytes.toString("base64") !== part.data) continue;
    const validHeader = part.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!validHeader || bytes.length > MAX_BYTES) continue;
    return { callId: result.callId, data: part.data, mimeType: part.mimeType };
  }
  return null;
}

export function screenshotIdempotencyKey(sessionId: string, screenshotCallId: string): string {
  return createHash("sha256").update(JSON.stringify(["browser-screenshot", sessionId, screenshotCallId])).digest("hex");
}

export interface AttachmentPost {
  markdown: string;
  files: { data: Buffer; filename: string; mimeType: string }[];
}

/** Linq uploads the bytes and sends an attachment_id, rather than a text link. */
export async function deliverScreenshot(
  screenshot: Screenshot,
  sessionId: string,
  post: (message: AttachmentPost, options: { idempotencyKey: string }) => Promise<{ id: string }>,
): Promise<DeliveryReceipt> {
  try {
    const message = await post({
      markdown: "Here’s the browser screenshot.",
      files: [{
        data: Buffer.from(screenshot.data, "base64"),
        filename: screenshot.mimeType === "image/png" ? "screenshot.png" : "screenshot.jpg",
        mimeType: screenshot.mimeType,
      }],
    }, { idempotencyKey: screenshotIdempotencyKey(sessionId, screenshot.callId) });
    if (!message.id) throw new Error("Missing Linq message receipt");
    return { screenshotCallId: screenshot.callId, status: "sent", messageId: message.id };
  } catch {
    return { screenshotCallId: screenshot.callId, status: "failed", error: "Linq did not confirm the attachment send. Retry sending this same capture; do not claim delivery." };
  }
}
