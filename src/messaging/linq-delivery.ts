import { isNotImplemented } from "eve/channels/chat-sdk";
import type { LinqChannelConfig } from "eve/channels/linq";
import { stopLinqTyping } from "./linq-typing.js";

type Events = NonNullable<LinqChannelConfig["events"]>;
type Event<K extends keyof Events> = Parameters<NonNullable<Events[K]>>[0];
type Turn = { turnId: string; sequence: number };
type StopTyping = (threadId: string) => Promise<void>;
type RecordSentMessage = (threadId: string, text: string, receipt: unknown) => void | Promise<void>;

interface BubbleStream extends Turn {
  sentCount: number;
  stepIndex: number;
  pending: string;
  receivedDeltas: boolean;
  completed: boolean;
  stopped: boolean;
}

interface DeliveryChannel {
  // Plain data in Eve's existing per-session channel state, never a global buffer.
  state: {
    bubbleStream?: BubbleStream;
    pendingToolCallMessage?: string | null;
    deliveryFailureReported?: boolean;
  };
  thread: {
    id: string;
    post(text: string): Promise<unknown>;
    startTyping(): Promise<unknown>;
  } | null;
}

function stop(channel: DeliveryChannel, stream = channel.state.bubbleStream): void {
  if (stream) {
    stream.stopped = true;
    stream.pending = "";
  }
  if (channel.state.bubbleStream === stream) channel.state.pendingToolCallMessage = null;
}

function forTurn(channel: DeliveryChannel, event: Turn): BubbleStream | undefined {
  const previous = channel.state.bubbleStream;
  if (previous) {
    if (event.sequence < previous.sequence) return;
    if (event.sequence === previous.sequence) {
      return event.turnId === previous.turnId ? previous : undefined;
    }
    stop(channel);
  }
  const stream: BubbleStream = {
    turnId: event.turnId, sequence: event.sequence, sentCount: 0,
    stepIndex: -1, pending: "", receivedDeltas: false, completed: false, stopped: false,
  };
  channel.state.bubbleStream = stream;
  channel.state.deliveryFailureReported = false;
  return stream;
}

function forMessage(channel: DeliveryChannel, event: Turn & { stepIndex: number }): BubbleStream | undefined {
  const stream = forTurn(channel, event);
  if (!stream || stream.stopped || event.stepIndex < stream.stepIndex) return;
  if (event.stepIndex > stream.stepIndex) {
    stream.stepIndex = event.stepIndex;
    stream.pending = "";
    stream.receivedDeltas = false;
    stream.completed = false;
  }
  return stream;
}

async function typing(channel: DeliveryChannel): Promise<void> {
  try {
    await channel.thread?.startTyping();
  } catch (error) {
    // Match Eve's optional typing support; real delivery errors still surface.
    if (!isNotImplemented(error)) throw error;
  }
}

interface DeliveryTiming {
  random(): number;
  sleep(ms: number): Promise<void>;
}

function typingDelayMs(text: string, random: number): number {
  // Tune conversational pacing here: 250 ms to start, 25 ms per Unicode code
  // point, and ±15% variation. Bound very short and very long messages.
  const estimate = (250 + Array.from(text).length * 25) * (0.85 + random * 0.3);
  return Math.round(Math.min(4_000, Math.max(400, estimate)));
}

async function send(channel: DeliveryChannel, stream: BubbleStream, text: string, timing: DeliveryTiming, recordSent?: RecordSentMessage): Promise<void> {
  if (!text || stream.stopped || !channel.thread) return;
  // Eve's built-in conditional-delivery marker can arrive in deltas before its
  // null completion. Never send it, including when followed by a blank line.
  if (text.includes("<eve-empty-delivery/>") || text.includes("&lt;eve-empty-delivery/&gt;")) return;
  try {
    if (stream.sentCount > 0) {
      await typing(channel);
      if (stream.stopped || !channel.thread) return;
      await timing.sleep(typingDelayMs(text, timing.random()));
      // Cancellation or a replacement turn can arrive while typing or waiting.
      if (stream.stopped || !channel.thread) return;
    }
    const receipt = await channel.thread.post(text);
    stream.sentCount = (stream.sentCount ?? 0) + 1;
    await recordSent?.(channel.thread.id, text, receipt);
  } catch (error) {
    // Don't send later bubbles or automatically retry an ambiguous provider send.
    stop(channel, stream);
    throw error;
  }
}

async function drain(channel: DeliveryChannel, stream: BubbleStream, timing: DeliveryTiming, recordSent?: RecordSentMessage): Promise<boolean> {
  let sent = false;
  // Keep the unconsumed suffix, including a delimiter split across delta chunks.
  // A single LF/CRLF inside a bubble is preserved verbatim.
  for (let boundary; !stream.stopped && (boundary = /\r?\n[\t ]*\r?\n/u.exec(stream.pending));) {
    const text = stream.pending.slice(0, boundary.index).trim();
    stream.pending = stream.pending.slice(boundary.index + boundary[0].length);
    if (text) {
      await send(channel, stream, text, timing, recordSent);
      sent = true;
    }
  }
  return sent;
}

async function finish(channel: DeliveryChannel, stream: BubbleStream | undefined, stopTyping: StopTyping): Promise<void> {
  // An old failure may settle after a replacement turn has started.
  if (channel.state.bubbleStream !== stream) return;
  stop(channel);
  if (!channel.thread) return;
  try {
    // Await cleanup in Eve's ordered event handler, before another turn starts.
    // No background task or retry that could later clear a new turn's indicator.
    await stopTyping(channel.thread.id);
  } catch {
    // Typing is advisory. Don't fail or replay a successfully delivered reply,
    // and don't log provider errors that might contain credentials or chat IDs.
    console.warn("[linq] typing cleanup failed");
  }
}

async function failure(channel: DeliveryChannel, stopTyping: StopTyping): Promise<void> {
  const stream = channel.state.bubbleStream;
  stop(channel);
  try {
    if (channel.state.deliveryFailureReported || !channel.thread) return;
    channel.state.deliveryFailureReported = true;
    await channel.thread.post("hit an error before i could finish. try that again?");
  } finally {
    // Even a failed error-notice send must not leave typing active.
    await finish(channel, stream, stopTyping);
  }
}

// Eve serializes stream event handling. Await each pause and post to retain order;
// no detached queue or post-and-edit streaming.
export function createLinqDeliveryEvents(stopTyping: StopTyping, options: Partial<DeliveryTiming> & { recordSent?: RecordSentMessage } = {}) {
  const { recordSent, ...overrides } = options;
  const timing: DeliveryTiming = {
    random: () => Math.random(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    ...overrides,
  };
  return {
    async "turn.started"(event: Event<"turn.started">, channel: DeliveryChannel) {
      const stream = forTurn(channel, event);
      if (!stream || stream.stopped) return;
      channel.state.pendingToolCallMessage = null;
      await typing(channel);
    },
    async "message.appended"(event: Event<"message.appended">, channel: DeliveryChannel) {
      const stream = forMessage(channel, event);
      if (!stream) return;
      // Inline tools can separate multiple messages in the SAME Eve step.
      if (stream.completed) {
        stream.pending = "";
        stream.receivedDeltas = false;
        stream.completed = false;
      }
      stream.receivedDeltas = true;
      stream.pending += event.messageDelta;
      if (await drain(channel, stream, timing, recordSent) && !stream.stopped) await typing(channel);
    },
    async "message.completed"(event: Event<"message.completed">, channel: DeliveryChannel) {
      const stream = forMessage(channel, event);
      if (!stream || stream.completed) return;
      stream.completed = true;
      channel.state.pendingToolCallMessage = event.finishReason === "tool-calls"
        ? event.message?.split(/\r?\n/u).find(line => line.trim()) ?? null
        : null;
      if (event.message === null || !["stop", "tool-calls"].includes(event.finishReason)) {
        stream.pending = "";
        return;
      }
      // A completion repeats the full message; only flush the unsent suffix.
      // Also support a complete message from a provider that emitted no deltas.
      if (!stream.receivedDeltas) stream.pending = event.message;
      await drain(channel, stream, timing, recordSent);
      const tail = stream.pending.trim();
      stream.pending = "";
      await send(channel, stream, tail, timing, recordSent);
    },
    async "turn.cancelled"(event: Event<"turn.cancelled">, channel: DeliveryChannel) {
      const stream = forTurn(channel, event);
      if (stream) await finish(channel, stream, stopTyping);
    },
    async "turn.completed"(event: Event<"turn.completed">, channel: DeliveryChannel) {
      const stream = forTurn(channel, event);
      if (stream) await finish(channel, stream, stopTyping);
    },
    async "turn.failed"(event: Event<"turn.failed">, channel: DeliveryChannel) {
      if (forTurn(channel, event)) await failure(channel, stopTyping);
    },
    async "session.failed"(_event: Event<"session.failed">, channel: DeliveryChannel) {
      await failure(channel, stopTyping);
    },
  } satisfies Events;
}

export const linqDeliveryEvents = createLinqDeliveryEvents(stopLinqTyping);
