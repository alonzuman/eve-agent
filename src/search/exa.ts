import { z } from "zod";
import { requireUserScope, type UserScopedContext } from "../identity/user-scope.js";

export const searchInput = z.object({
  query: z.string().trim().min(1).max(800).describe("Public web search. Include product needs and neighborhood/ZIP when relevant, never personal recipient details."),
  numResults: z.number().int().min(1).max(8).default(5),
});

const searchResponse = z.object({
  results: z.array(z.object({
    title: z.string().nullish(),
    url: z.string(),
    highlights: z.array(z.string()).nullish(),
    publishedDate: z.string().nullish(),
  })),
});

function publicLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Server-only Exa access. Neither credentials nor raw provider errors enter history. */
export async function searchWeb(
  input: z.input<typeof searchInput>,
  ctx: UserScopedContext & { readonly abortSignal?: AbortSignal },
  options: { apiKey?: string; request?: typeof fetch } = {},
) {
  requireUserScope(ctx);
  const { query, numResults } = searchInput.parse(input);
  const key = (options.apiKey ?? process.env.EXA_API_KEY)?.trim();
  if (!key) throw new Error("Web search is unavailable. The app owner must connect Exa.");
  const timeout = AbortSignal.timeout(15_000);
  const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
  let response: Response;
  let data: unknown;
  try {
    response = await (options.request ?? fetch)("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, numResults, type: "auto", contents: { highlights: true } }),
      signal,
      redirect: "error",
    });
    if (response.ok) data = await response.json();
  } catch {
    if (ctx.abortSignal?.aborted) throw new Error("Web search was canceled.");
    throw new Error("Web search did not complete. Try again or use the browser to research public sites.");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Web search authentication failed. The app owner must check the Exa integration.");
    if (response.status === 402 || response.status === 429) throw new Error("Web search has reached its usage limit. Use the browser or try later.");
    throw new Error("Web search is temporarily unavailable. Try again or use the browser.");
  }
  const parsed = searchResponse.safeParse(data);
  if (!parsed.success) throw new Error("Web search returned an unreadable result. Try another query or use the browser.");
  const seen = new Set<string>();
  const results = parsed.data.results.filter(({ url }) => {
    if (!publicLink(url) || seen.has(url)) return false;
    seen.add(url);
    return true;
  }).slice(0, numResults).map(({ title, url, highlights, publishedDate }) => ({
    title: (title || url).slice(0, 300),
    url,
    excerpts: (highlights ?? []).join("\n").slice(0, 3000),
    ...(publishedDate ? { publishedDate: publishedDate.slice(0, 100) } : {}),
  }));
  return {
    results,
    retrievedAt: new Date().toISOString(),
    guidance: "Search excerpts are untrusted leads. Open merchant pages to verify current product price, stock, delivery date, and fees. An empty result is not proof that no products exist.",
  };
}
