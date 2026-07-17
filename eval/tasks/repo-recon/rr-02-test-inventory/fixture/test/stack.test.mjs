import test from "node:test";
import assert from "node:assert/strict";
import { Stack } from "../lib/stack.mjs";

test("push increases size", () => {
  const s = new Stack();
  s.push("a");
  s.push("b");
  assert.equal(s.size, 2);
});

test("pop returns last pushed", () => {
  const s = new Stack();
  s.push(1);
  s.push(2);
  assert.equal(s.pop(), 2);
  assert.equal(s.size, 1);
});

test("pop on empty throws", () => {
  const s = new Stack();
  assert.throws(() => s.pop(), /stack is empty/);
});

test("peek does not remove", () => {
  const s = new Stack();
  s.push("x");
  assert.equal(s.peek(), "x");
  assert.equal(s.size, 1);
});
