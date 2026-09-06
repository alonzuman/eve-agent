import { defineState } from "eve/context";
import type { CardSet } from "./cards.js";
import type { saveLocalCardPreview } from "./local-preview.js";

export type CardReceipt = { setId: string; status: "sent" | "failed"; messageId?: string; error?: string };
export type PreparedCards = { id: string; set: CardSet; images: string[]; receipt: CardReceipt | null; localPreview?: Awaited<ReturnType<typeof saveLocalCardPreview>> };
export const visualCardsState = defineState<{
  current: PreparedCards | null;
  lastSent: { id: string; set: CardSet; messageId: string } | null;
}>("personal-assistant.visual-cards", () => ({ current: null, lastSent: null }));
