import test from "node:test";
import assert from "node:assert/strict";
import { sumAmounts, countEntries } from "../lib/ledger.mjs";

test("sums csv amounts numerically", () => {
  const entries = [{ amount: "2" }, { amount: "3" }];
  assert.equal(sumAmounts(entries), 5);
});

test("empty ledger sums to 0", () => {
  assert.equal(sumAmounts([]), 0);
});

test("countEntries counts", () => {
  assert.equal(countEntries([{ amount: "1" }]), 1);
});
