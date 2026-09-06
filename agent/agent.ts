import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-sol",
  // Keep Satori external in dev; Nitro's * selector copies every HarfBuzz asset
  // into production output, including the package-relative hb.wasm file.
  build: { externalDependencies: ["@resvg/resvg-js", "sharp", "satori", "harfbuzzjs*"] },
});
