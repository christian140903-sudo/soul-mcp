import test from "node:test";
import assert from "node:assert/strict";
import { topScores, averageScore } from "../lib/ranking.mjs";

test("returns the n highest scores, highest first", () => {
  assert.deepEqual(topScores([10, 50, 30], 2), [50, 30]);
});

test("does not modify the input array", () => {
  const scores = [10, 50, 30];
  topScores(scores, 2);
  assert.deepEqual(scores, [10, 50, 30]);
});

test("averageScore of empty list is 0", () => {
  assert.equal(averageScore([]), 0);
});
