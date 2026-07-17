import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery } from "../lib/query.mjs";

test("joins simple params with ampersand", () => {
  assert.equal(buildQuery({ page: 2, limit: 10 }), "page=2&limit=10");
});

test("single param has no separator", () => {
  assert.equal(buildQuery({ q: "hello" }), "q=hello");
});

test("empty params give empty string", () => {
  assert.equal(buildQuery({}), "");
});
