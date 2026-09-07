# Visual replies

The API is `renderCard({ html, props, width?, height? }) → Promise<Buffer>` (PNG bytes), implemented with **satori-html → Satori → resvg**. It runs in the existing Node app with no Next.js app, browser rendering service, public image endpoint, or image-generation model.

```ts
import { renderCard } from "../src/visual/render-card.js";

const png = await renderCard({
  html: `<div style="display:flex;flex-direction:column;width:100%;height:100%;padding:60px;background:#10251c;color:white">
    <div style="font-size:96px;font-weight:700">{{TITLE}}</div>
    <div style="font-size:72px;margin-top:32px;color:#def0b9">{{PRICE}}</div>
  </div>`,
  props: { TITLE: "Peach garden bouquet", PRICE: "$65 · example price" },
});
```

The agent's `present_cards` tool takes `action: "present"`, `introduction`, and `cards: [{ html, props, label, sourceUrl? }]`. It supports one visual reply or up to five cards with arbitrary supported layouts. Dimensions apply to the batch (default 1000×1250; each dimension 320–1600). Labels provide a brief text equivalent for the numbered caption; source links are optional for plans and should be included for researched choices. Choose one to five useful cards, respecting the requested count; readable layouts take priority over reaching the four-image stack threshold. Submit the whole set in one tool call. There is no fixed shopping schema. See [the agent's template example](../agent/skills/visual-cards/SKILL.md).

Every PNG includes a renderer-owned top-right `x/y` badge, including `1/1` for single cards. The default canvas reserves a 132px header and a clipped 1000×1118 content area, preventing template artwork from covering the badge. Direct `renderCard` calls default to `1/1`; batch rendering supplies the ordered position via `options.position`. Font sizes resolve through inheritance (including px/em/rem/%) and are raised to a minimum of 56px at 1000px width; omitted sizes default to 64px. Both scale with width. Author templates with 90–104px titles, 72px prices, and 56–64px details; shorten copy and avoid fixed text heights so enlarged text fits. Preview at roughly 280px wide to assess inline readability.

HTML is parsed before placeholder substitution, so strings containing apparent HTML stay data. Missing props fail explicitly. Props are a JSON object, not a JavaScript Map. Use static div/span/p/br/img/headings/emphasis tags and inline [Satori-supported CSS](https://github.com/vercel/satori#css). Flexbox, gradients, absolute positioning, rounded corners, and typography are supported; this is not a browser. Scripts, event handlers, style tags, classes, SVG input, CSS variables, and external stylesheets are rejected. Use img elements for photos instead of CSS image URLs.

Photo downloads use public HTTPS, validate and pin DNS addresses at connection time, revalidate redirects, send no app credentials, and cap bytes and time (10 MB, 15 seconds). Sharp only validates and normalizes downloaded raster photos; Satori owns composition and typography. Photos become embedded bytes before Satori sees them. Each card has at most five photos and a bounded canvas, markup, prop count, tree depth, node count, and output size. Latin Outfit WOFF fonts are bundled; regenerate using `node --import tsx scripts/bundle-card-fonts.ts`.

The batch starts all card render promises concurrently (at most five), overlapping photo fetching and asynchronous rendering work; synchronous rasterization still runs on the Node thread. Promise ordering preserves card/caption/follow-up numbering even if renders finish out of order. A shared 90-second deadline, cancellation on failure, and 10 MB aggregate output limit apply to the whole batch. Failed work is drained before returning; all cards must render before committing a prepared session set. The Linq handler uploads the ordered PNGs in one message, bound to the originating private chat. [Linq supports media attachments](https://docs.linqapp.com/channel/imessage/guides/messaging/attachments/). [Apple controls photo grouping](https://support.apple.com/en-ie/guide/iphone/iphb66cfeaad/ios): two or three form a collage, and four or more form a stack. These are images, not interactive purchase buttons.

After preparation, the tool returns queued. `action: "status"` is read-only; sent with a messageId means Linq accepted the batch, not that a phone displayed it. `action: "retry"` reuses the prepared bytes and send key. A new presentation has a distinct call-scoped ID; replayed events are deduplicated. Successful sends discard image bytes from session state but retain the last sent ordered labels, props and sources. Failed new sets do not replace that mapping. The agent retrieves it for replies like “option 2.”

Run `npm run check` and `npm run build`. Automated checks do not prove handset rendering. After deployment, request four researched choices, inspect their grouping/readability on a real iPhone, reply with a number, and verify the matching source is used.
