import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { browserInputSchema, validateBrowserInput } from "../agent/tools/browser.js";
import { browserScopeName } from "../src/browser/sandbox.js";

test("browser schema is a top-level object accepted by model providers", () => {
  const schema = z.toJSONSchema(browserInputSchema);
  assert.equal(schema.type, "object");
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.anyOf, undefined);
});

test("browser rejects missing parameters before remote actions", () => {
  assert.throws(() => validateBrowserInput({ action: "navigate" }), /URL/);
  assert.throws(() => validateBrowserInput({ action: "click" }), /selector/);
  assert.throws(() => validateBrowserInput({ action: "fill", selector: "input" }), /value/);
  assert.doesNotThrow(() => validateBrowserInput({ action: "fill", selector: "input", value: "" }));
  assert.throws(() => validateBrowserInput({ action: "press", selector: "input" }), /key/);
});

test("browser VM identifiers isolate users and do not contain sender details", () => {
  assert.notEqual(browserScopeName("user-one"), browserScopeName("user-two"));
  assert.equal(browserScopeName("user-one"), browserScopeName("user-one"));
  assert.equal(browserScopeName("user-one").includes("user-one"), false);
  assert.throws(() => browserScopeName(""), /verified user/);
});
