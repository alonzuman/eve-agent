import { resettableLinqChannel } from "../../src/messaging/resettable-linq-channel.js";
import { admitLinqMessage } from "../../src/identity/linq-admission.js";
import { linqDeliveryEvents } from "../../src/messaging/linq-delivery.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to enable the Linq channel.`);
  return value;
}

export default resettableLinqChannel({
  // Lazy resolvers let the deployment build before Linq credentials are connected.
  // Supplying signingSecret selects eve's built-in signed-webhook verification.
  credentials: {
    apiKey: () => requiredEnv("LINQ_API_KEY"),
    signingSecret: () => requiredEnv("LINQ_WEBHOOK_SECRET"),
  },
  turnPolicy: "steer",
  events: linqDeliveryEvents,
  async onMessage({ thread }, message) {
    return admitLinqMessage(message, thread.isDM, requiredEnv("LINQ_PHONE_NUMBER"));
  },
});
