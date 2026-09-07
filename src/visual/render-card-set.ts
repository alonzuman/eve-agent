import { cardsSchema, type CardSet } from "./cards.js";
import { CardTemplateError, renderCard } from "./render-card.js";

/** Start the bounded batch together, but retain input order and commit only a complete set. */
export async function renderCardSet(
  input: CardSet,
  options: { abortSignal?: AbortSignal; render?: typeof renderCard } = {},
): Promise<string[]> {
  const set = cardsSchema.parse(input);
  const controller = new AbortController();
  const abortSignal = AbortSignal.any([
    controller.signal, AbortSignal.timeout(90_000), ...(options.abortSignal ? [options.abortSignal] : []),
  ]);
  abortSignal.throwIfAborted();
  let totalBytes = 0;
  const pending = set.cards.map(async (card, index) => {
    try {
      const image = await (options.render ?? renderCard)(
        { ...card, width: set.width, height: set.height },
        { abortSignal, position: { index: index + 1, total: set.cards.length } },
      );
      abortSignal.throwIfAborted();
      totalBytes += image.length;
      if (totalBytes > 10 * 1024 * 1024) throw new CardTemplateError("Card batch exceeds 10 MB; reduce dimensions or photo count.");
      return image.toString("base64");
    } catch (error) {
      const hint = error instanceof CardTemplateError ? error.message : "Check placeholders, simplify to inline flexbox CSS, and use public photo URLs.";
      throw new Error(`Could not render card ${index + 1}. ${hint} No new card set was sent.`);
    }
  });
  try {
    return await Promise.all(pending);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(pending);
    throw error;
  }
}
