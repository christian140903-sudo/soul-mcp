import test from "node:test";
import assert from "node:assert/strict";
import { processRecord } from "../lib/records.mjs";

test("formats a valid record", () => {
  assert.equal(processRecord("Widget; 4 ;pcs"), "Widget x4 [pcs]");
});

test("rejects malformed lines", () => {
  assert.throws(() => processRecord("Widget;4"), /malformed record/);
});

test("rejects empty name", () => {
  assert.throws(() => processRecord(";4;pcs"), /empty name/);
});

test("rejects negative or non-integer qty", () => {
  assert.throws(() => processRecord("Widget;-1;pcs"), /non-negative integer/);
  assert.throws(() => processRecord("Widget;zwei;pcs"), /non-negative integer/);
});

test("rejects empty unit", () => {
  assert.throws(() => processRecord("Widget;4; "), /empty unit/);
});
