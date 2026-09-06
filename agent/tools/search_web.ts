import { defineTool } from "eve/tools";
import { searchInput, searchWeb } from "../../src/search/exa.js";

export default defineTool({
  description: "Search the public web with Exa for merchants, products, and research. Returns public URLs and excerpts, not verified live inventory or checkout totals. Search using public requirements and neighborhood/ZIP, never recipient names, full addresses, contact details, or gift notes. The app already connects Exa; users do not need an Exa account.",
  inputSchema: searchInput,
  execute: (input, ctx) => searchWeb(input, ctx),
});
