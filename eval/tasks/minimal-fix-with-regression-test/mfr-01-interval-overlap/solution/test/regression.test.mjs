import test from "node:test";
import assert from "node:assert/strict";
import { overlaps } from "../lib/interval.mjs";

test("touching intervals do not overlap (half-open)", () => {
  assert.equal(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 }), false);
  assert.equal(overlaps({ start: 5, end: 9 }, { start: 0, end: 5 }), false);
});
