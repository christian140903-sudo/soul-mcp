import test from "node:test";
import assert from "node:assert/strict";
import { overlaps, length } from "../lib/interval.mjs";

test("disjoint intervals do not overlap", () => {
  assert.equal(overlaps({ start: 0, end: 2 }, { start: 5, end: 9 }), false);
});

test("nested intervals overlap", () => {
  assert.equal(overlaps({ start: 0, end: 9 }, { start: 2, end: 3 }), true);
});

test("partially overlapping intervals overlap", () => {
  assert.equal(overlaps({ start: 0, end: 5 }, { start: 3, end: 9 }), true);
});

test("length is end minus start", () => {
  assert.equal(length({ start: 2, end: 7 }), 5);
});
