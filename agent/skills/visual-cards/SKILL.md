---
name: visual-cards
description: Compose HTML photo cards, comparisons, plans, and other visual iMessage replies with present_cards.
---

Use present_cards when a visual makes the answer easier to understand. Send one card for a visual summary or two to five cards for distinct researched options. Let useful content and the requested count determine the set size; fewer than four is fine. Prioritize readable, well-spaced layouts at every count. Apple groups four or more images as a swipeable stack and two or three as a collage. Respect an explicit count and do not add filler to reach four. Submit every card in one present_cards call; the tool renders the batch concurrently and sends one ordered multi-attachment message. Compose the HTML yourself; layouts are not restricted to shopping.

Each card has `html`, `props` (a record of string values), `label` (a brief text equivalent), and optionally `sourceUrl`. Placeholders such as `{{TITLE}}` work in text, inline CSS values, and image attributes. Reuse the same HTML with different props for consistent comparisons. The renderer adds a high-contrast top-right x/y badge automatically, even for a single card (1/1). Do not draw another number or supply a NUMBER prop.

Use inline Satori flexbox CSS. Default size is 1000×1250. Design for an inline message about 280px wide: use 90–104px titles, 72px prices, and 56–64px details with strong contrast. The renderer enforces a 56px minimum and 64px default, scaled with canvas width. Shorten copy rather than relying on tiny text; use a short title, one price, and at most two brief detail lines. Keep critical caveats visible and move extra explanation into the caption. The renderer reserves a 132px header above your HTML, leaving a 1000×1118 content area at default dimensions; width/height 100% refer to that area. Scale your layout and font sizes proportionally for other widths. Use a root div with width/height 100%, explicit flex directions, and enough padding. Use normal or bold Outfit typography. Avoid overcrowding; keep names, prices, and critical caveats readable.

Example HTML for a photo-backed option:

```html
<div style="display:flex;position:relative;flex-direction:column;width:100%;height:100%;background:#111b19;color:white">
  <img src="{{PHOTO}}" width="1000" height="660" style="position:absolute;top:0;left:0;object-fit:cover" />
  <div style="display:flex;position:absolute;top:260px;left:0;width:100%;height:400px;background-image:linear-gradient(to bottom,rgba(17,27,25,0),#111b19)"></div>
  <div style="display:flex;flex-direction:column;margin-top:auto;padding:48px">
    <div style="font-size:56px;color:#cfdbd4">{{MERCHANT}}</div>
    <div style="font-size:96px;font-weight:700;margin-top:18px">{{TITLE}}</div>
    <div style="font-size:72px;color:#e7f0ca;margin-top:24px">{{PRICE}}</div>
    <div style="font-size:56px;margin-top:28px">{{DETAIL}}</div>
  </div>
</div>
```

Supply each placeholder in props, including PHOTO as an observed public HTTPS image URL. This is a starting point; change the HTML for the user's task. For a plan or summary, omit photos if unnecessary. Use div/span/p/img/headings and simple emphasis tags. Do not use scripts, style tags, classes, event handlers, CSS variables, SVG, external stylesheets, or CSS url() images. Use img for real photos and CSS gradients/shapes for decoration. The renderer supports a subset of browser HTML/CSS; simplify a layout if it fails.

Research facts before rendering. Never invent product images, URLs, prices, delivery dates, ratings, or discounts. Separate item price from tax/delivery/checkout totals, and make estimates and unknowns explicit. Supply sourceUrl for researched choices. For comparisons, make the introduction invite a reply with a number.

Call action present, then action status. In local TUI or Studio sessions, preview_ready is success: share the returned local HTML preview URL as a clickable link and include its absolute path. No iMessage is sent; action status returns the current preview's ordered cards. For Linq delivery, only say sent when status is sent with a messageId. On send failure use action retry for the same batch. If rendering fails, simplify the layout or find a valid real photo; fall back to concise text when needed. On Linq, the tool sends its introduction, numbered captions and links, so do not duplicate them in ordinary text.

On a numbered follow-up, action status retrieves lastSent with the exact ordered card labels, props and links. Resolve the user's choice from that set and clarify ambiguous references across sets. Recheck changing facts before acting. An image is not a purchase button, and choosing a card does not establish that a purchase occurred.
