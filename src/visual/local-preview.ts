import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CardSet } from "./cards.js";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

export async function saveLocalCardPreview(setId: string, set: CardSet, images: string[]) {
  if (!/^[a-f0-9]{64}$/.test(setId) || images.length !== set.cards.length) throw new Error("Invalid local card preview.");
  const directory = join(tmpdir(), "eve-local-cards", setId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cards = await Promise.all(set.cards.map(async (card, index) => {
    const path = join(directory, `card-${index + 1}.png`);
    await writeFile(path, Buffer.from(images[index], "base64"), { mode: 0o600 });
    return { label: card.label, path, url: pathToFileURL(path).href, sourceUrl: card.sourceUrl };
  }));
  const path = join(directory, "index.html");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local card preview</title>
<style>body{margin:0;padding:40px;background:#f2f0eb;color:#16251e;font:18px system-ui}h1{max-width:900px;font-size:28px}main{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0;width:min(100%,360px)}img{width:100%;border-radius:18px}figcaption{padding:14px 0;line-height:1.5}a{color:inherit}</style>
<h1>${escapeHtml(set.introduction)}</h1><main>${cards.map((card, index) => `<figure><img src="card-${index + 1}.png" alt="${escapeHtml(card.label)}"><figcaption>${index + 1}. ${escapeHtml(card.label)}${card.sourceUrl ? `<br><a href="${escapeHtml(card.sourceUrl)}" rel="noreferrer">Source</a>` : ""}</figcaption></figure>`).join("")}</main></html>`;
  await writeFile(path, html, { mode: 0o600 });
  return { status: "preview_ready" as const, setId, path, url: pathToFileURL(path).href, cards,
    guidance: "Local preview only. Show the user a clickable Markdown link to this preview URL and the absolute path. No iMessage was sent. For numbered follow-ups use these ordered cards." };
}
