import { createHash } from "node:crypto";
import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Use a single line of text.");
export const httpsUrl = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443");
}, "Use a public HTTPS URL without credentials or a custom port.");

export const cardSchema = z.object({
  html: z.string().min(1).max(16_000).describe("Satori HTML with inline flexbox CSS and {{PLACEHOLDER}} values. No scripts, external stylesheets, or CSS image URLs; use img elements."),
  props: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(2048)).refine(props => Object.keys(props).length <= 40, "Use at most 40 props."),
});
export type CardInput = z.infer<typeof cardSchema>;
export const canvasSchema = z.object({
  width: z.number().int().min(320).max(1600).default(1000),
  height: z.number().int().min(320).max(1600).default(1250),
});
export const cardsSchema = canvasSchema.extend({
  introduction: line(180),
  cards: z.array(cardSchema.extend({
    label: line(160).describe("Brief plain-text equivalent, e.g. title and price, for the numbered caption and follow-up references."),
    sourceUrl: httpsUrl.optional().describe("Exact researched source page for this card, when applicable."),
  })).min(1).max(5),
});
export type CardSet = z.infer<typeof cardsSchema>;
// Model providers require an object at the root of every tool input schema.
export const presentCardsInputSchema = cardsSchema.partial().extend({
  action: z.enum(["present", "status", "retry"]),
}).superRefine((input, ctx) => {
  if (input.action !== "present") return;
  const result = cardsSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) ctx.addIssue({ ...issue });
  }
});
export const cardSetId = (set: CardSet, callId: string) => createHash("sha256").update(JSON.stringify([callId, set])).digest("hex");
export const cardSendKey = (sessionId: string, setId: string) => createHash("sha256").update(JSON.stringify(["visual-cards", sessionId, setId])).digest("hex");

export function cardCaption(set: CardSet): string {
  return `${set.introduction}\n${set.cards.map((card, index) => `${index + 1}. ${card.label}${card.sourceUrl ? `\n${card.sourceUrl}` : ""}`).join("\n")}`;
}
