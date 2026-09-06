import { assessLinqResponseAccess, type EvaluateLinqResponseFlag } from "../flags/linq-responses.js";
import { bindPrivateChat } from "./chat-owner.js";
import { assessPrivateLinqIdentity, type LinqMessage } from "./linq-policy.js";

interface AdmissionDependencies {
  readonly evaluateResponseFlag?: EvaluateLinqResponseFlag;
  readonly bindChat?: typeof bindPrivateChat;
}

/** Returning null makes eve acknowledge the webhook without read receipts or a turn. */
export async function admitLinqMessage(
  message: LinqMessage,
  isDM: boolean,
  line: string,
  { evaluateResponseFlag, bindChat = bindPrivateChat }: AdmissionDependencies = {},
) {
  const assessment = assessPrivateLinqIdentity(message, isDM, line);
  if (!assessment.accepted) {
    console.info("[linq] inbound rejected", { reason: assessment.reason });
    return null;
  }
  const { identity } = assessment;
  const access = await assessLinqResponseAccess(identity.senderHandle, evaluateResponseFlag);
  if (!access.accepted) {
    console.info("[linq] inbound rejected", { reason: access.reason });
    return null;
  }
  if (!await bindChat(identity.chatKey, identity.auth.principalId)) {
    console.warn("[linq] inbound rejected", { reason: "conversation_owner_conflict" });
    return null;
  }
  console.info("[linq] inbound accepted");
  return { auth: identity.auth };
}
