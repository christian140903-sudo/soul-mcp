import test from "node:test";
import assert from "node:assert/strict";
import { validateUser, validateOrder, validateProduct } from "../lib/validate.mjs";

const base = { id: "e-1", revision: 0 };

test("valid user passes", () => {
  assert.equal(validateUser({ ...base, email: "a@b.c" }), true);
});

test("valid order passes", () => {
  assert.equal(validateOrder({ ...base, items: [1] }), true);
});

test("valid product passes", () => {
  assert.equal(validateProduct({ ...base, price: 9.5 }), true);
});

test("empty id is rejected everywhere", () => {
  assert.throws(() => validateUser({ ...base, id: " ", email: "a@b.c" }), /id must be a non-empty string/);
  assert.throws(() => validateOrder({ ...base, id: "", items: [1] }), /id must be a non-empty string/);
  assert.throws(() => validateProduct({ ...base, id: 7, price: 1 }), /id must be a non-empty string/);
});

test("negative or non-integer revision is rejected everywhere", () => {
  assert.throws(() => validateUser({ ...base, revision: -1, email: "a@b.c" }), /revision must be a non-negative integer/);
  assert.throws(() => validateOrder({ ...base, revision: 1.5, items: [1] }), /revision must be a non-negative integer/);
  assert.throws(() => validateProduct({ ...base, revision: "0", price: 1 }), /revision must be a non-negative integer/);
});

test("specific checks still apply", () => {
  assert.throws(() => validateUser({ ...base, email: "nope" }), /email must contain @/);
  assert.throws(() => validateOrder({ ...base, items: [] }), /items must be a non-empty list/);
  assert.throws(() => validateProduct({ ...base, price: -2 }), /price must be a non-negative number/);
});
