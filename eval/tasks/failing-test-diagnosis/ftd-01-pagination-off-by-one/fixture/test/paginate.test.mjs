import test from "node:test";
import assert from "node:assert/strict";
import { pageSlice, pageCount } from "../lib/paginate.mjs";

test("first page has perPage items", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(pageSlice(items, 1, 3), [1, 2, 3]);
});

test("last partial page has the remainder", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(pageSlice(items, 3, 2), [5]);
});

test("pageCount rounds up", () => {
  assert.equal(pageCount([1, 2, 3, 4, 5], 2), 3);
});
