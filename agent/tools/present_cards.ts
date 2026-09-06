import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireUserScope } from "../../src/identity/user-scope.js";
import { cardSetId, cardsSchema } from "../../src/visual/cards.js";
import { visualCardsState } from "../../src/visual/card-state.js";
import { CardTemplateError, renderCard } from "../../src/visual/render-card.js";

export default defineTool({
  description: "Render and send 1–5 visual cards to the current private iMessage chat. Each card takes HTML with inline Satori flexbox CSS and a map of string props for {{PLACEHOLDERS}}. Compose layouts for researched options, summaries, plans, or other useful visuals. For comparisons use 3–5 numbered cards with real photos, exact prices and details; img src may be a prop containing an observed public HTTPS photo URL. action=present prepares and queues the batch; action=status must confirm a Linq messageId before claiming sent. action=retry reuses prepared cards after failure. status also returns lastSent for numbered follow-up references. No recipient is accepted.",
  inputSchema: z.discriminatedUnion("action", [
    cardsSchema.extend({ action: z.literal("present") }),
    z.object({ action: z.literal("status") }),
    z.object({ action: z.literal("retry") }),
  ]),
  async execute(input, ctx) {
    requireUserScope(ctx);
    const { current, lastSent } = visualCardsState.get();
    if (input.action === "status") return { ...(current?.receipt ?? { status: current ? "prepared" : "not_sent", setId: current?.id }), lastSent };
    if (input.action === "retry") {
      if (!current) throw new Error("No prepared cards to retry.");
      return current.receipt?.status === "sent" ? current.receipt : { status: "queued" as const, setId: current.id };
    }
    const set = cardsSchema.parse(input);
    const id = cardSetId(set, ctx.callId);
    if (current?.id === id) return current.receipt?.status === "sent" ? current.receipt : { status: "queued" as const, setId: id };
    const images: string[] = [];
    let totalBytes = 0;
    const abortSignal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(90_000)]);
    for (const [index, card] of set.cards.entries()) {
      ctx.abortSignal.throwIfAborted();
      try {
        const image = await renderCard({ ...card, width: set.width, height: set.height }, { abortSignal });
        totalBytes += image.length;
        if (totalBytes > 10 * 1024 * 1024) throw new CardTemplateError("Card batch exceeds 10 MB; reduce dimensions or photo count.");
        images.push(image.toString("base64"));
      } catch (error) {
        const hint = error instanceof CardTemplateError ? error.message : "Check placeholders, simplify to inline flexbox CSS, and use public photo URLs.";
        throw new Error(`Could not render card ${index + 1}. ${hint} No new card set was sent.`);
      }
    }
    ctx.abortSignal.throwIfAborted();
    visualCardsState.update(state => ({ ...state, current: { id, set, images, receipt: null } }));
    return { status: "queued" as const, setId: id };
  },
});
