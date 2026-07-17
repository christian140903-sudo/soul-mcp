import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery } from "../lib/query.mjs";

test("encodes reserved characters in keys and values", () => {
  assert.equal(buildQuery({ q: "a&b=c" }), "q=a%26b%3Dc");
  assert.equal(buildQuery({ "user name": "max müller" }), "user%20name=max%20m%C3%BCller");
});
