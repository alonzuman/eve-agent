import { localDev, vercelOidc, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const projectOidc = vercelOidc();
const internalServiceOnly: AuthFn<Request> = async (request) => {
  const auth = await projectOidc(request);
  // eve route auth alone does not enforce session ownership. Humans enter via
  // verified Linq DMs; do not expose the session API to arbitrary end-user JWTs.
  return auth?.principalType === "service" || auth?.principalType === "runtime" ? auth : null;
};

export default eveChannel({ auth: [internalServiceOnly, localDev()] });
