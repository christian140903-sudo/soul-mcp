import test from "node:test";
import assert from "node:assert/strict";
import { makeReport, totalOf } from "../lib/report.mjs";

test("formats title and rows line by line", () => {
  const out = makeReport("Q1", [
    { name: "alpha", value: 1 },
    { name: "beta", value: 2 }
  ]);
  assert.equal(out, "Q1\nalpha: 1\nbeta: 2");
});

test("empty rows give title plus empty line", () => {
  assert.equal(makeReport("leer", []), "leer\n");
});

test("totalOf is variadic", () => {
  assert.equal(totalOf(), 0);
  assert.equal(totalOf(5), 5);
  assert.equal(totalOf(1, 2, 3, 4), 10);
});
