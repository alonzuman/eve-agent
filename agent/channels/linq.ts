import { linqChannel } from "eve/channels/linq";
import { bindPrivateChat } from "../../src/identity/chat-owner.js";
import { privateLinqIdentity } from "../../src/identity/linq-policy.js";

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
  async onMessage({ thread }, message) {
    const identity = privateLinqIdentity(message, thread.isDM, requiredEnv("LINQ_PHONE_NUMBER"));
    if (!identity) return null;
    if (!await bindPrivateChat(identity.chatKey, identity.auth.principalId)) return null;
    return { auth: identity.auth };
  },
});
