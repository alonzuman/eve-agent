import { randomUUID } from "node:crypto";
import satori from "satori";
import { html as parseHtml } from "satori-html";
import { decodeHTML } from "entities";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { outfitRegular, outfitBold } from "./assets/outfit.js";
import { cardSchema, canvasSchema, type CardInput } from "./cards.js";
import { fetchOptionImage } from "./fetch-image.js";

const fonts = [
  { name: "Outfit", data: Buffer.from(outfitRegular, "base64"), weight: 400 as const, style: "normal" as const },
  { name: "Outfit", data: Buffer.from(outfitBold, "base64"), weight: 700 as const, style: "normal" as const },
];
const tags = new Set(["div", "span", "p", "br", "img", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "small"]);
type Node = { type: string; props: Record<string, unknown> };
type Child = Node | string | number | null | Child[];
export class CardTemplateError extends Error {}

/** Parse first, substitute second: props remain data, even when they contain HTML. */
export function cardTree(input: CardInput): Node {
  const { html, props } = cardSchema.parse(input);
  // Alphanumeric tokens also survive CSS parsing (literal {{...}} does not).
  const prefix = `EVEPROP${randomUUID().replaceAll("-", "")}X`;
  const values: string[] = [];
  const template = html.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(props, key)) throw new CardTemplateError(`Missing card prop: ${key}`);
    values.push(props[key]);
    return `${prefix}${values.length - 1}END`;
  });
  // satori-html inlines style tags before creating its tree; reject these up front.
  if (/<\s*(?:script|style|link|iframe|object|embed)\b/i.test(template)) throw new CardTemplateError("Use static HTML with inline CSS only.");
  const token = new RegExp(`${prefix}(\\d+)END`, "g");
  let characters = 0;
  const substitute = (value: string) => {
    const resolved = decodeHTML(value).replace(token, (_match, index: string) => values[Number(index)]);
    characters += resolved.length;
    if (characters > 20_000) throw new CardTemplateError("Card content is too long after substitution.");
    return resolved;
  };
  let nodes = 0;
  function visit(child: Child, depth: number): Child {
    if (++nodes > 300 || depth > 30) throw new CardTemplateError("Card markup is too complex.");
    if (typeof child === "string") return substitute(child);
    if (child === null || typeof child === "number") return child;
    if (Array.isArray(child)) return child.map(value => visit(value, depth + 1));
    if (child.type === "html" || child.type === "body") child.type = "div";
    if (!tags.has(child.type)) throw new CardTemplateError(`Unsupported card element: ${child.type}`);
    const output: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(child.props)) {
      if (name === "children") output.children = visit(value as Child, depth + 1);
      else if (name === "style" && value && typeof value === "object") {
        const style: Record<string, string | number> = { display: "flex" };
        for (const [key, raw] of Object.entries(value)) {
          const resolved = typeof raw === "string" ? substitute(raw) : raw;
          if (typeof resolved !== "string" && typeof resolved !== "number") throw new CardTemplateError("Unsupported CSS value.");
          // No renderer-initiated URL fetches, including escaped CSS URL syntax.
          if (typeof resolved === "string" && /url\s*\(|\\|\/\*/i.test(resolved)) throw new CardTemplateError("Use an img element for photos; CSS URLs are not supported.");
          if (key === "backgroundImage" && typeof resolved === "string" && !/^(?:linear|radial)-gradient\(/.test(resolved)) throw new CardTemplateError("Only gradients are supported as CSS background images.");
          if (key.startsWith("--")) throw new CardTemplateError("Use direct CSS values instead of variables.");
          style[key] = resolved;
        }
        output.style = style;
      } else if (["src", "width", "height", "alt"].includes(name) && child.type === "img") {
        const resolved = typeof value === "string" ? substitute(value) : value;
        output[name] = (name === "width" || name === "height") && typeof resolved === "string" && /^\d+(?:\.\d+)?$/.test(resolved)
          ? Number(resolved) : resolved;
      } else throw new CardTemplateError(`Unsupported card attribute: ${name}. Use inline styles.`);
    }
    output.style ??= { display: "flex" };
    return { type: child.type, props: output };
  }
  return visit(parseHtml(template), 0) as Node;
}

/** HTML + string props → self-contained PNG. No browser, JS execution, or public hosting. */
export async function renderCard(
  input: CardInput & { width?: number; height?: number },
  options: { abortSignal?: AbortSignal } = {},
): Promise<Buffer> {
  const canvas = canvasSchema.parse(input);
  const tree = cardTree(input);
  let imageCount = 0;
  async function embed(child: Child): Promise<void> {
    options.abortSignal?.throwIfAborted();
    if (!child || typeof child !== "object") return;
    if (Array.isArray(child)) { for (const node of child) await embed(node); return; }
    if (child.type === "img") {
      if (++imageCount > 5) throw new CardTemplateError("Use at most five photos per card.");
      if (typeof child.props.src !== "string") throw new CardTemplateError("An img needs a public HTTPS src.");
      const bytes = await fetchOptionImage(child.props.src, options.abortSignal);
      const photo = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
      const metadata = await photo.metadata();
      if (!["png", "jpeg", "webp", "gif"].includes(metadata.format ?? "")) throw new CardTemplateError("Unsupported photo format.");
      const normalized = await photo.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      child.props.src = `data:image/png;base64,${normalized.toString("base64")}`;
    }
    if (child.props.children) await embed(child.props.children as Child);
  }
  await embed(tree);
  tree.props.style = { ...(tree.props.style as object), fontFamily: "Outfit" };
  const svg = await satori(tree as Parameters<typeof satori>[0], { ...canvas, fonts });
  options.abortSignal?.throwIfAborted();
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  if (png.length > 10 * 1024 * 1024) throw new CardTemplateError("Rendered card exceeds 10 MB.");
  return Buffer.from(png);
}
