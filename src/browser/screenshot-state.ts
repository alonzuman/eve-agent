import { defineState } from "eve/context";
import type { ScreenshotState } from "./attachments.js";

// Eve persists this slot in the current session only; no global image cache.
export const screenshotState = defineState<ScreenshotState>("personal-assistant.browser-screenshot", () => ({
  screenshot: null,
  receipt: null,
}));
