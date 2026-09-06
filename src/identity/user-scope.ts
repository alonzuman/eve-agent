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
