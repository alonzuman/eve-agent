import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureKernelProject, kernelProjectName } from "../src/browser/kernel-project.js";

function context(user = "a") {
  const identity = { authenticator: "linq-private", issuer: "linq:test", principalType: "user", principalId: user.repeat(64) };
  return { session: { auth: { current: identity, initiator: identity } } };
}
const env = { VERCEL_PROJECT_ID: "app-a", VERCEL_ENV: "production" };

test("Kernel projects are stable per verified user and separated across users, apps and environments", () => {
  const name = kernelProjectName(context(), env);
  assert.equal(name, kernelProjectName(context(), { ...env, VERCEL_GIT_COMMIT_REF: "new-release" }));
  assert.notEqual(name, kernelProjectName(context("b"), env));
  assert.notEqual(name, kernelProjectName(context(), { ...env, VERCEL_PROJECT_ID: "app-b" }));
  assert.notEqual(name, kernelProjectName(context(), { ...env, VERCEL_ENV: "preview" }));
  assert.notEqual(kernelProjectName(context(), { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "a" }),
    kernelProjectName(context(), { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "b" }));
});

test("existing private project is selected using server credentials without OAuth", async () => {
  let requests = 0;
  const id = await ensureKernelProject(context(), { env, apiKey: "test-secret", request: async (input, init) => {
    requests++;
    assert.equal(String(input), `https://api.onkernel.com/org/projects/${kernelProjectName(context(), env)}`);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-secret");
    return Response.json({ id: "proj_a", name: kernelProjectName(context(), env), status: "active" });
  } });
  assert.equal(id, "proj_a");
  assert.equal(requests, 1);
});

test("first use creates a private project; a competing create converges on the same project", async () => {
  for (const conflict of [false, true]) {
    let gets = 0, creates = 0;
    const name = kernelProjectName(context(), env);
    const project = { id: "proj_a", name, status: "active" };
    const id = await ensureKernelProject(context(), { env, apiKey: "test-secret", request: async (input, init) => {
      if (init?.method === "POST") {
        creates++;
        assert.equal(String(input), "https://api.onkernel.com/org/projects");
        assert.deepEqual(JSON.parse(String(init.body)), { name });
        return conflict ? Response.json({}, { status: 409 }) : Response.json(project, { status: 201 });
      }
      return ++gets === 1 ? Response.json({ code: "project_not_found" }, { status: 404 }) : Response.json(project);
    } });
    assert.equal(id, "proj_a");
    assert.equal(creates, 1);
    assert.equal(gets, conflict ? 2 : 1);
  }
});

test("missing isolation, rejected auth and invalid project responses fail closed without leaking response bodies", async () => {
  for (const response of [
    Response.json({ code: "projects_disabled" }, { status: 404 }),
    Response.json({ secret: "private-provider-detail" }, { status: 401 }),
    Response.json({ id: "proj_other", name: "someone-else", status: "active" }),
    Response.json({ id: "proj_a", name: kernelProjectName(context(), env), status: "archived" }),
  ]) {
    let calls = 0;
    await assert.rejects(() => ensureKernelProject(context(), { env, apiKey: "test-secret", request: async () => {
      calls++;
      return response;
    } }), (error: Error) => !error.message.includes("private-provider-detail"));
    assert.equal(calls, 1);
  }
});

test("unverified sessions never reach Kernel", async () => {
  await assert.rejects(() => ensureKernelProject({ session: { auth: { current: null, initiator: null } } }, {
    apiKey: "test-secret", request: async () => { assert.fail("must reject before network access"); },
  }), /verified private Linq/);
});
