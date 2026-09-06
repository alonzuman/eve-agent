/** Only channel-verified identities may select a user's browser or credentials. */
export interface VerifiedUserIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalType: string;
  readonly principalId: string;
}

export interface UserScopedContext {
  readonly session: {
    readonly auth: {
      readonly current: VerifiedUserIdentity | null;
      readonly initiator: VerifiedUserIdentity | null;
    };
  };
}

/** Local tools use eve's server-authenticated dev identity, never a phone scope. */
export function isLocalToolSession(ctx: UserScopedContext, env = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return false;
  if (env.EVE_DEV !== "1" && !(env.VERCEL === "1" && env.VERCEL_ENV === "development")) return false;
  const { current, initiator } = ctx.session.auth;
  return [current, initiator].every(auth => auth?.authenticator === "local-dev" &&
    auth.principalType === "local-dev" && auth.principalId === "local-dev" && !auth.issuer);
}

export function requireToolScope(ctx: UserScopedContext, env = process.env): string {
  return isLocalToolSession(ctx, env) ? "local-dev" : requireUserScope(ctx);
}

export function requireUserScope(ctx: UserScopedContext): string {
  const { current, initiator } = ctx.session.auth;
  if (
    !current || !initiator ||
    current.authenticator !== "linq-private" ||
    current.principalType !== "user" ||
    !current.issuer?.startsWith("linq:") ||
    !/^[a-f0-9]{64}$/.test(current.principalId) ||
    current.authenticator !== initiator.authenticator ||
    current.issuer !== initiator.issuer ||
    current.principalType !== initiator.principalType ||
    current.principalId !== initiator.principalId
  ) {
    throw new Error("A verified private Linq conversation is required.");
  }
  return current.principalId;
}
