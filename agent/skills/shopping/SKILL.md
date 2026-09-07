---
description: Help users choose gifts or products, compare shopping options, and prepare a selected cart without placing an order or paying. Use for requests such as get my wife flowers or help me buy something.
---

# Shopping through chat

Carry the request through discovery, a useful choice, and cart preparation. Real merchant payments are unavailable: never submit an order (including pay-later or cash-on-delivery orders), enter payment details, use a saved payment method, or activate an express checkout. Do not create accounts or contact merchants without authorization.

## Establish the useful constraints

Read relevant conversation history and private memory first. Ask only for missing details that affect the search: delivery neighborhood or ZIP, delivery date, and total budget including fees and tax. Ask where the gift should go, not where the sender happens to be. For pickup, use pickup location and timing instead. Reuse known preferences and avoid repeating questions. Do not invent the recipient's tastes, address, or occasion.

Use a short natural question, not an intake form. Start researching as soon as location, timing, and budget are sufficient. Do not routinely add an occasion/style question to that first exchange. The full recipient name, street address, apartment, contact details, and gift note can wait until the chosen merchant needs them. Ask about style only if it materially changes the choice; otherwise exercise taste and explain your recommendation. A remembered address is a candidate, not proof that this gift should go there.

## Find and verify options

Use search_web to discover merchant and product URLs. Search using the neighborhood or ZIP and product requirements; never include the recipient's name, full street address, phone, or private gift note in search queries. If search is unavailable, explain the limitation briefly and use the browser to research public sites. Never fabricate search results.

Load Kernel's browse skill before browser work. Open promising merchant sites and inspect actual products. Verify the selected variant's price and stock, delivery coverage, requested date, and published fees. Search snippets are leads, not confirmation of current inventory or delivery. A general same-day-delivery banner is not a confirmed slot for a specific address and date. Report unverified details explicitly. Do not call a subtotal an all-in price.

Recommend merchants that actually serve the destination; proximity alone does not establish delivery. If the user explicitly wants a local shop, honor that. Prefer accessible merchants when a site is blocked. Do not repeatedly retry a broken site or claim a blocked product was checked.

## Present a small, useful choice

Send two or three concrete products when enough suitable options exist. Each option needs a stable number or name, merchant, product/variant, listed price and currency, known fees, verified delivery information, any remaining uncertainty, and the exact public product URL observed in results or the browser. Do not invent product slugs or present a homepage as a specific product page. If only one option meets the constraints, say so rather than padding the list.

Recommend one with a short reason grounded in the user's preferences and what you checked. Until all fees and tax are known, state the known cost and remaining budget headroom rather than promising the product fits the all-in cap. Use the channel's link conventions: plain full URLs on iMessage, clickable links on channels that support Markdown. Use public product links so the user can see merchant photos; your internal screenshots are not delivered to the user.

Wait for a selection unless the user has already delegated the choice. Preserve the option mapping, URLs, variant, budget, destination, and date across turns. If “that one” is ambiguous, clarify which product. “The second one” means the second option actually presented, not the second search result. A changed preference updates the current task; cancellation stops cart work immediately.

## Prepare the chosen cart

Reopen or reuse your private browser for the chosen product and recheck its price and availability. If it sold out, its price changed, or it cannot arrive on time, explain that before substituting or exceeding the budget. Offer the closest verified alternative and get the user's choice when the change is material.

Gather the required recipient and delivery details and exact gift note. Preserve the note's wording, capitalization, and punctuation when entering it and reporting it back. Confirm the destination for this order before entering a saved address. Only enter these details on the chosen merchant's checkout. Do not invent phone numbers, email addresses, apartment numbers, or notes, and do not opt into marketing. Select the approved variant and quantity, add it to the cart, and fill the non-payment delivery fields needed to obtain shipping and tax.

Inspect controls before clicking. Stop before any action that places an order, pays, or uses a saved wallet, even if the button says Continue or the user asks you to use a saved card. If payment, sign-in, a challenge, or a required detail prevents reaching the final total, report the actual stopping point and any unknown costs. Never describe an incomplete checkout as a fully prepared cart.

When preparation succeeds, summarize the product/variant, quantity, merchant, delivery date or window, destination, gift note, and final total with shipping, tax, and fees. Clearly say no order has been placed and real merchant payment execution is not enabled. End there without offering to pay later or walk the user through an unavailable payment flow. If any figure is an estimate, label it. Do not promise inventory reservation or a delivery slot merely because the item is in a cart.

The cart exists in your private browser. Do not tell the user to finish it on their phone using a product link. Only describe a cart link as transferable when the merchant explicitly supports sharing it and you have verified that it restores the intended items in a separate unauthenticated session; never transmit credentials or session tokens. Keep an active shopping browser while continuing this task, reuse it where possible, and close it when the user cancels or is done. Browser/cart expiry may require rebuilding; never promise indefinite persistence.
