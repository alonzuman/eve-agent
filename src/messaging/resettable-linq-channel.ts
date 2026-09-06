import { AsyncLocalStorage } from "node:async_hooks";
import type { RouteHandlerArgs } from "eve/channels";
import type { ChatSdkChannelState } from "eve/channels/chat-sdk";
import { linqChannel, type LinqChannel, type LinqChannelConfig } from "eve/channels/linq";
import { accountAddress, accountPrincipal, prepareLinqAccount, type LinqAccountStore } from "../identity/linq-account.js";
import { requireUserScope } from "../identity/user-scope.js";

type OnMessage = NonNullable<LinqChannelConfig["onMessage"]>;
type Admission = NonNullable<Awaited<ReturnType<OnMessage>>>;

export function isResetCommand(message: { readonly text: string; readonly attachments: readonly unknown[] }): boolean {
  return message.text.trim() === "!reset" && message.attachments.length === 0;
}

/** Add account controls without replacing Eve's signed Linq adapter or dispatch. */
export function resettableLinqChannel(
  config: LinqChannelConfig & {
    onMessage: OnMessage;
    onAdmittedMessage?: (ctx: Parameters<OnMessage>[0], message: Parameters<OnMessage>[1], admission: Admission) => Promise<Admission | null>;
  },
  store?: LinqAccountStore,
): LinqChannel {
  // Eve 0.52.2 exposes `from().reset()` on routes, but not Linq's onMessage ctx.
  // Keep those operations and address mappings isolated to this webhook request.
  const inbound = new AsyncLocalStorage<{
    args: RouteHandlerArgs<ChatSdkChannelState>;
    addresses: Map<string, string>;
  }>();
  const channel = linqChannel({
    ...config,
    async onMessage(ctx, message) {
      const admitted = await config.onMessage(ctx, message);
      if (!admitted) return null;
      const principalId = requireUserScope({
        session: { auth: { current: admitted.auth, initiator: admitted.auth } },
      });
      const request = inbound.getStore();
      if (!request) throw new Error("Linq account controls require an inbound webhook.");
      const reset = isResetCommand(message);
      let generation: string | null;
      try {
        generation = await prepareLinqAccount({
          principalId, threadId: ctx.thread.id,
          resetMessageId: reset ? message.id : undefined,
          retire: address => request.args.from(address).reset({ reason: "User requested !reset" }),
        }, store);
      } catch (error) {
        if (!reset) throw error;
        // Never claim success or pass the command to the model on partial failure.
        console.error("[linq] account reset failed");
        await ctx.thread.post("couldn't finish the reset. send !reset again to retry.");
        return null;
      }
      if (reset) {
        await ctx.thread.post("all set — we're starting fresh. your next message will use a new conversation, memory, and browser.");
        return null;
      }
      request.addresses.set(ctx.thread.id, accountAddress(ctx.thread.id, generation));
      const scopedPrincipal = accountPrincipal(principalId, generation);
      const admission = {
        ...admitted,
        auth: { ...admitted.auth!, principalId: scopedPrincipal, subject: scopedPrincipal },
      };
      return config.onAdmittedMessage ? config.onAdmittedMessage(ctx, message, admission) : admission;
    },
  });
  return {
    ...channel,
    routes: channel.routes.map(route => {
      if (route.transport === "websocket") throw new Error("Expected Linq HTTP routes.");
      return {
        ...route,
        handler: (request: Request, args: RouteHandlerArgs<ChatSdkChannelState>) => {
          const addresses = new Map<string, string>();
          return inbound.run({ args, addresses }, () => route.handler(request, {
            ...args,
            from(address) {
              const scoped = addresses.get(address);
              if (!scoped) throw new Error("Linq dispatch requires an admitted account.");
              return args.from(scoped);
            },
          }));
        },
      };
    }),
  };
}
