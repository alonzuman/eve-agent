import { isNotImplemented } from "eve/channels/chat-sdk";
import type { LinqChannelConfig } from "eve/channels/linq";

type Events = NonNullable<LinqChannelConfig["events"]>;
type Event<K extends keyof Events> = Parameters<NonNullable<Events[K]>>[0];
type Turn = { turnId: string; sequence: number };

interface BubbleStream extends Turn {
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
    post(text: string): Promise<unknown>;
    startTyping(): Promise<unknown>;
  } | null;
}

function stop(channel: DeliveryChannel): void {
  const stream = channel.state.bubbleStream;
  if (stream) {
    stream.stopped = true;
    stream.pending = "";
  }
  channel.state.pendingToolCallMessage = null;
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
    turnId: event.turnId, sequence: event.sequence,
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

async function send(channel: DeliveryChannel, stream: BubbleStream, text: string): Promise<void> {
  if (!text || stream.stopped || !channel.thread) return;
  try {
    await channel.thread.post(text);
  } catch (error) {
    // Don't send later bubbles or automatically retry an ambiguous provider send.
    stop(channel);
    throw error;
  }
}

async function drain(channel: DeliveryChannel, stream: BubbleStream): Promise<boolean> {
  let sent = false;
  // Keep the unconsumed suffix, including a delimiter split across delta chunks.
  // A single LF/CRLF inside a bubble is preserved verbatim.
  for (let boundary; !stream.stopped && (boundary = /\r?\n[\t ]*\r?\n/u.exec(stream.pending));) {
    const text = stream.pending.slice(0, boundary.index).trim();
    stream.pending = stream.pending.slice(boundary.index + boundary[0].length);
    if (text) {
      await send(channel, stream, text);
      sent = true;
    }
  }
  return sent;
}

async function failure(channel: DeliveryChannel): Promise<void> {
  stop(channel);
  if (channel.state.deliveryFailureReported || !channel.thread) return;
  channel.state.deliveryFailureReported = true;
  await channel.thread.post("hit an error before i could finish. try that again?");
}

// Eve serializes stream event handling. Await each post so bubbles retain order;
// no detached queue, provider client, custom send tool, or post-and-edit streaming.
export const linqDeliveryEvents = {
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
    if (await drain(channel, stream) && !stream.stopped) await typing(channel);
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
    await drain(channel, stream);
    const tail = stream.pending.trim();
    stream.pending = "";
    await send(channel, stream, tail);
  },
  "turn.cancelled"(event: Event<"turn.cancelled">, channel: DeliveryChannel) {
    if (forTurn(channel, event)) stop(channel);
  },
  "turn.completed"(event: Event<"turn.completed">, channel: DeliveryChannel) {
    if (forTurn(channel, event)) stop(channel);
  },
  async "turn.failed"(event: Event<"turn.failed">, channel: DeliveryChannel) {
    if (forTurn(channel, event)) await failure(channel);
  },
  async "session.failed"(_event: Event<"session.failed">, channel: DeliveryChannel) {
    await failure(channel);
  },
} satisfies Events;
