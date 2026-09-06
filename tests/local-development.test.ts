import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalToolSession, requireToolScope, requireUserScope } from "../src/identity/user-scope.js";
import { kernelProjectName } from "../src/browser/kernel-project.js";
import { searchWeb } from "../src/search/exa.js";
import browser from "../agent/extensions/kernel/connections/browser.js";

const local = { authenticator: "local-dev", principalType: "local-dev", principalId: "local-dev" };
const context = { session: { auth: { current: local, initiator: local } } };

test("local tools require the dev server and matching authenticated local principals", () => {
  assert.equal(requireToolScope(context, { EVE_DEV: "1" }), "local-dev");
  assert.equal(isLocalToolSession(context, { VERCEL: "1", VERCEL_ENV: "development" }), true);
  for (const env of [{}, { NODE_ENV: "development" }, { EVE_DEV: "1", VERCEL_ENV: "production" }, { EVE_DEV: "1", VERCEL_ENV: "preview" }]) {
    assert.throws(() => requireToolScope(context, env));
  }
  for (const auth of [null, { ...local, principalType: "service" }, { ...local, principalId: "another" }, { ...local, issuer: "linq:test" }]) {
    for (const changed of ["current", "initiator"]) {
      assert.throws(() => requireToolScope({ session: { auth: { ...context.session.auth, [changed]: auth } } }, { EVE_DEV: "1" }));
    }
  }
  assert.throws(() => requireUserScope(context), /verified private Linq/, "local tools never authorize phone delivery");
});

test("local browsing has a separate stable project from phone users", () => {
  const env = { EVE_DEV: "1", VERCEL_ENV: "development", VERCEL_PROJECT_ID: "test" };
  const phone = { authenticator: "linq-private", principalType: "user", principalId: "a".repeat(64), issuer: "linq:test" };
  const name = kernelProjectName(context, env);
  assert.equal(name, kernelProjectName(context, env));
  assert.notEqual(name, kernelProjectName({ session: { auth: { current: phone, initiator: phone } } }, env));
  assert.throws(() => kernelProjectName(context, { ...env, VERCEL_ENV: "production" }));
});

test("authenticated local searches reach Exa with app credentials", async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.EVE_DEV = "1";
  delete process.env.VERCEL_ENV;
  let calls = 0;
  const result = await searchWeb({ query: "Marina SF flowers" }, context, {
    apiKey: "test-key", request: async (_input, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
      return Response.json({ results: [{ title: "Flower shop", url: "https://example.com" }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.results.length, 1);
});

test("Kernel uses app credentials for local-dev and user credentials for verified phone users", async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.EVE_DEV = "1";
  delete process.env.VERCEL_ENV;
  const auth = browser.auth;
  assert.equal(typeof auth, "function");
  if (typeof auth !== "function") throw new Error("Expected context-based Kernel auth");
  const localAuth = await auth(context as Parameters<typeof auth>[0]);
  assert.equal(localAuth?.principalType, "app");
  const phone = { authenticator: "linq-private", principalType: "user", principalId: "a".repeat(64), issuer: "linq:test" };
  const phoneContext = { session: { auth: { current: phone, initiator: phone } } };
  const phoneAuth = await auth(phoneContext as Parameters<typeof auth>[0]);
  assert.equal(phoneAuth?.principalType, "user");
});
