import { cardCaption, cardSendKey } from "./cards.js";
import type { CardReceipt, PreparedCards } from "./card-state.js";

interface AttachmentPost {
  markdown: string;
  files: { data: Buffer; filename: string; mimeType: string }[];
}

export async function deliverCards(
  prepared: PreparedCards,
  sessionId: string,
  post: (message: AttachmentPost, options: { idempotencyKey: string }) => Promise<{ id: string }>,
): Promise<CardReceipt> {
  try {
    if (prepared.images.length !== prepared.set.cards.length || !prepared.images.length) throw new Error("Missing cards.");
    const message = await post({
      markdown: cardCaption(prepared.set),
      files: prepared.images.map((image, index) => ({ data: Buffer.from(image, "base64"), filename: `card-${index + 1}.png`, mimeType: "image/png" })),
    }, { idempotencyKey: cardSendKey(sessionId, prepared.id) });
    if (!message.id) throw new Error("Missing Linq receipt.");
    return { setId: prepared.id, status: "sent", messageId: message.id };
  } catch {
    return { setId: prepared.id, status: "failed", error: "Linq did not confirm this card set. Use action=retry for the same cards; do not claim delivery." };
  }
}
