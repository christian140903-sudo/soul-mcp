import test from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../lib/chunk.mjs";

test("splits evenly divisible arrays", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("empty array gives no chunks", () => {
  assert.deepEqual(chunk([], 3), []);
});

test("rejects non-positive size", () => {
  assert.throws(() => chunk([1], 0), /positive integer/);
});
