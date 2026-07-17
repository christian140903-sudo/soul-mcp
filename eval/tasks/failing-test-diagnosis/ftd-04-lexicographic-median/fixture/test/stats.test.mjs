import test from "node:test";
import assert from "node:assert/strict";
import { median, range } from "../lib/stats.mjs";

test("median of single-digit values", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median of multi-digit values", () => {
  assert.equal(median([10, 2, 33]), 10);
});

test("range spans min to max", () => {
  assert.equal(range([10, 2, 33]), 31);
});
