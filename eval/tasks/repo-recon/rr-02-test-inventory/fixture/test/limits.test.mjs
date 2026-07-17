import test from "node:test";
import assert from "node:assert/strict";
import { Stack } from "../lib/stack.mjs";

test("capacity is enforced", () => {
  const s = new Stack(1);
  s.push("only");
  assert.throws(() => s.push("too much"), /stack is full/);
});

test("clear empties the stack", () => {
  const s = new Stack();
  s.push(1);
  s.push(2);
  s.clear();
  assert.equal(s.size, 0);
});
