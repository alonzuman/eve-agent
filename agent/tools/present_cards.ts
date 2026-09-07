import { defineTool } from "eve/tools";
import { isLocalToolSession, requireToolScope } from "../../src/identity/user-scope.js";
import { saveLocalCardPreview } from "../../src/visual/local-preview.js";
import { cardSetId, cardsSchema, presentCardsInputSchema } from "../../src/visual/cards.js";
import { visualCardsState } from "../../src/visual/card-state.js";
import { renderCardSet } from "../../src/visual/render-card-set.js";

export default defineTool({
  description: "Render and send 1–5 visual cards to the current private iMessage chat. Each card takes HTML with inline Satori flexbox CSS and a map of string props for {{PLACEHOLDERS}}. Compose layouts for researched options, summaries, plans, or other useful visuals. Choose 1–5 cards based on useful content and the requested count; fewer than four is fine. 4–5 images enable the native iMessage stack; 2–3 appear as a collage. Prioritize readable, well-spaced layouts at every count. Send all cards in one call. Use 90–104px titles, 72px prices, and at least 56px details at 1000px width; shorten copy to fit. For item options, use the real item photo as a full-card background with a dark gradient and text anchored bottom-left. Use one rounded outer edge, without a white header or nested frames. The renderer overlays a top-right x/y badge; the entire 1000×1250 canvas is available. Cards render concurrently. Use cards with real photos, exact prices and details; img src may be a prop containing an observed public HTTPS photo URL. action=present prepares and queues the batch; action=status must confirm a Linq messageId before claiming sent. action=retry reuses prepared cards after failure. status also returns lastSent for numbered follow-up references. No recipient is accepted.",
  inputSchema: presentCardsInputSchema,
  async execute(input, ctx) {
    requireToolScope(ctx);
    const local = isLocalToolSession(ctx);
    const { current, lastSent } = visualCardsState.get();
    if (local && current?.localPreview && (input.action === "status" || input.action === "retry")) return current.localPreview;
    if (input.action === "status") return { ...(current?.receipt ?? { status: current ? "prepared" : "not_sent", setId: current?.id }), lastSent };
    if (input.action === "retry") {
      if (!current) throw new Error("No prepared cards to retry.");
      return current.receipt?.status === "sent" ? current.receipt : { status: "queued" as const, setId: current.id };
    }
    const set = cardsSchema.parse(input);
    const id = cardSetId(set, ctx.callId);
    if (current?.id === id) return current.localPreview ?? (current.receipt?.status === "sent" ? current.receipt : { status: "queued" as const, setId: id });
    const images = await renderCardSet(set, { abortSignal: ctx.abortSignal });
    ctx.abortSignal.throwIfAborted();
    const localPreview = local ? await saveLocalCardPreview(id, set, images) : undefined;
    visualCardsState.update(state => ({ ...state, current: { id, set, images, receipt: null, ...(localPreview ? { localPreview } : {}) } }));
    if (localPreview) return localPreview;
    return { status: "queued" as const, setId: id };
  },
});
