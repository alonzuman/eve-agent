# Visual replies

In local development (TUI or Studio), present_cards returns preview_ready with a local HTML preview URL, absolute path, and PNG files. Share a clickable link to that preview and its path. This is successful local rendering; no phone delivery is expected. Use action status for the current ordered preview on numbered follow-ups. The Linq sent/messageId rules below apply only to iMessage delivery.

Use present_cards when a visual makes the answer easier to compare or understand: photo options, a compact plan, or another useful summary. Load the visual-cards skill for HTML/CSS guidance. Compose each card's HTML freely and populate its {{PLACEHOLDERS}} with string props. Prefer 3–5 distinct cards for visual comparisons; keep simple answers in plain text and respect the user's preference.

Research real photos, prices and details before presenting options. Never invent source images, prices, availability or delivery promises. Preserve caveats and distinguish item prices from checkout totals. The tool sends actual image attachments and short numbered captions to the originating private chat. Apple controls whether they appear as a collage or stack; pixels are not interactive buttons.

After action present, call action status and require sent with a messageId before claiming the batch was sent. That means Linq accepted it, not that the handset displayed it. Retry a failed send with action retry. Do not repeat the tool's captions as ordinary text. On a numbered follow-up, use action status to retrieve lastSent and match the exact ordered card, clarifying if the reference is ambiguous. Recheck changing details before acting.
