import { isNotImplemented } from "eve/channels/chat-sdk";

export const bubbleBoundary = /\r?\n[\t ]*\r?\n/u;
export const splitBubbles = (text: string): string[] => text.split(bubbleBoundary).map(part => part.trim()).filter(Boolean);

export interface BubbleDeliveryState {
  sentCount: number;
  threadedReplies?: string[][];
}

export interface DeliveryTiming {
  random(): number;
  sleep(ms: number): Promise<void>;
}

export function deliveryTiming(overrides: Partial<DeliveryTiming> = {}): DeliveryTiming {
  return {
    random: () => Math.random(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    ...overrides,
  };
}

const normalize = (text: string) => text.trim().replace(/\s+/gu, " ");

export function isThreadedReplyEcho(state: BubbleDeliveryState, text: string): boolean {
  const candidate = normalize(text);
  // Accept changes in line endings or merged adjacent bubbles, but never drop a
  // bubble containing new text merely because part of it repeats an earlier reply.
  return (state.threadedReplies ?? []).some(reply => reply.some((_, start) => {
    let joined = "";
    for (const bubble of reply.slice(start)) {
      joined += (joined ? " " : "") + normalize(bubble);
      if (joined === candidate) return true;
      if (joined.length >= candidate.length) break;
    }
    return false;
  }));
}

export async function startBubbleTyping(startTyping: () => Promise<unknown>): Promise<void> {
  try { await startTyping(); }
  catch (error) { if (!isNotImplemented(error)) throw error; }
}

/** Both delivery paths use the same turn-wide counter and awaited pacing. */
export async function sendLinqBubble<T>(text: string, options: {
  state: BubbleDeliveryState;
  active(): boolean;
  startTyping(): Promise<unknown>;
  post(): Promise<T>;
  timing: DeliveryTiming;
}): Promise<{ receipt: T } | undefined> {
  if (!text || !options.active()) return;
  if (text.includes("<eve-empty-delivery/>") || text.includes("&lt;eve-empty-delivery/&gt;")) return;
  if (options.state.sentCount > 0) {
    await startBubbleTyping(options.startTyping);
    if (!options.active()) return;
    // 250 ms to start, 25 ms per Unicode code point, ±15%, bounded to 400–4,000 ms.
    const estimate = (250 + Array.from(text).length * 25) * (0.85 + options.timing.random() * 0.3);
    await options.timing.sleep(Math.round(Math.min(4_000, Math.max(400, estimate))));
    if (!options.active()) return;
  }
  const receipt = await options.post();
  options.state.sentCount++;
  return { receipt };
}
