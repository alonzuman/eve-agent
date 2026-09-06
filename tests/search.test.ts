import assert from "node:assert/strict";
import { test } from "node:test";
import { searchWeb } from "../src/search/exa.js";

const identity = { authenticator: "linq-private", issuer: "linq:search-test", principalType: "user", principalId: "a".repeat(64) };
const context = { session: { auth: { current: identity, initiator: identity } } };
const apiKey = "secret-test-key";

test("search rejects unverified users and invalid inputs before contacting Exa", async () => {
  const request: typeof fetch = async () => { throw new Error("must not reach network"); };
  await assert.rejects(searchWeb({ query: "flowers" }, { session: { auth: { current: null, initiator: null } } }, { request, apiKey }), /verified private/);
  for (const input of [{ query: " " }, { query: "x".repeat(801) }, { query: "flowers", numResults: 100 }]) {
    await assert.rejects(searchWeb(input, context, { request, apiKey }));
  }
  await assert.rejects(searchWeb({ query: "flowers" }, context, { request, apiKey: "" }), /unavailable/);
});

test("search uses fixed server credentials and returns bounded, usable links without provider internals", async () => {
  const result = await searchWeb({ query: " UES flowers ", numResults: 2 }, context, {
    apiKey,
    request: async (input, init) => {
      assert.equal(input, "https://api.exa.ai/search");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("x-api-key"), apiKey);
      assert.ok(init?.signal);
      assert.deepEqual(JSON.parse(String(init?.body)), { query: "UES flowers", numResults: 2, type: "auto", contents: { highlights: true } });
      return Response.json({
        requestId: "internal-request", secret: apiKey,
        results: [
          { url: "javascript:alert(1)" },
          { url: "https://user:password@shop.example/bouquet" },
          { title: "Bouquet", url: "https://shop.example/products/bouquet?variant=1", highlights: ["x".repeat(9000)], text: "private extra" },
          { url: "https://shop.example/products/bouquet?variant=1" },
          { title: null, url: "https://other.example/flowers", highlights: null },
          { url: "https://third.example/flowers" },
        ],
      });
    },
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].url, "https://shop.example/products/bouquet?variant=1");
  assert.equal(result.results[0].excerpts.length, 3000);
  assert.equal(result.results[1].title, "https://other.example/flowers");
  assert.equal(result.results[1].excerpts, "");
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.ok(!JSON.stringify(result).includes("private extra"));
  assert.match(result.guidance, /verify/);
});

test("provider failures are actionable without leaking bodies or transport secrets", async () => {
  for (const [status, pattern] of [[401, /authentication/], [403, /authentication/], [402, /usage limit/], [429, /usage limit/], [500, /temporarily unavailable/]] as const) {
    await assert.rejects(searchWeb({ query: "flowers" }, context, {
      apiKey, request: async () => new Response(apiKey, { status }),
    }), (error: Error) => pattern.test(error.message) && !error.message.includes(apiKey));
  }
  await assert.rejects(searchWeb({ query: "flowers" }, context, {
    apiKey, request: async () => { throw new Error(apiKey); },
  }), /did not complete/);
  await assert.rejects(searchWeb({ query: "flowers" }, context, {
    apiKey, request: async () => Response.json({ results: [{ url: 123 }] }),
  }), /unreadable/);
});

test("cancellation reaches the HTTP request and empty searches remain empty", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchWeb({ query: "flowers" }, { ...context, abortSignal: controller.signal }, {
    apiKey, request: async (_input, init) => { init?.signal?.throwIfAborted(); return Response.json({ results: [] }); },
  }), /canceled/);
  const empty = await searchWeb({ query: "flowers" }, context, { apiKey, request: async () => Response.json({ results: [] }) });
  assert.deepEqual(empty.results, []);
});
