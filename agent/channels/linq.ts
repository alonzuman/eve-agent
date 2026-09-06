import { linqChannel } from "eve/channels/linq";
import { bindPrivateChat } from "../../src/identity/chat-owner.js";
import { assessPrivateLinqIdentity } from "../../src/identity/linq-policy.js";
import { linqDeliveryEvents } from "../../src/messaging/linq-delivery.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to enable the Linq channel.`);
  return value;
}

export default linqChannel({
  // Lazy resolvers let the deployment build before Linq credentials are connected.
  // Supplying signingSecret selects eve's built-in signed-webhook verification.
  credentials: {
    apiKey: () => requiredEnv("LINQ_API_KEY"),
    signingSecret: () => requiredEnv("LINQ_WEBHOOK_SECRET"),
  },
  turnPolicy: "steer",
  events: linqDeliveryEvents,
  async onMessage({ thread }, message) {
    const assessment = assessPrivateLinqIdentity(message, thread.isDM, requiredEnv("LINQ_PHONE_NUMBER"));
    if (!assessment.accepted) {
      console.info("[linq] inbound rejected", { reason: assessment.reason });
      return null;
    }
    const { identity } = assessment;
    if (!await bindPrivateChat(identity.chatKey, identity.auth.principalId)) {
      console.warn("[linq] inbound rejected", { reason: "conversation_owner_conflict" });
      return null;
    }
    console.info("[linq] inbound accepted");
    return { auth: identity.auth };
  },
});
