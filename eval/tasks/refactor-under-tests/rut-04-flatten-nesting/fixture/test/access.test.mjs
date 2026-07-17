import test from "node:test";
import assert from "node:assert/strict";
import { canAccess } from "../lib/access.mjs";

const owner = { id: "u1", active: true, roles: [] };
const member = { id: "u2", active: true, roles: ["member"] };
const admin = { id: "u3", active: true, roles: ["admin"] };
const outsider = { id: "u4", active: true, roles: [] };

test("no user or inactive user is denied", () => {
  assert.equal(canAccess(null, { visibility: "public" }), false);
  assert.equal(canAccess({ id: "u9", active: false, roles: ["admin"] }, { visibility: "public" }), false);
});

test("missing resource is denied", () => {
  assert.equal(canAccess(owner, null), false);
});

test("public resources are readable for every active user", () => {
  assert.equal(canAccess(outsider, { ownerId: "u1", visibility: "public" }), true);
});

test("admin reads everything", () => {
  assert.equal(canAccess(admin, { ownerId: "u1", visibility: "private" }), true);
  assert.equal(canAccess(admin, { ownerId: "u1", visibility: "internal" }), true);
});

test("owner reads own private and internal resources", () => {
  assert.equal(canAccess(owner, { ownerId: "u1", visibility: "private" }), true);
  assert.equal(canAccess(owner, { ownerId: "u1", visibility: "internal" }), true);
});

test("owner does not read own resource with unknown visibility", () => {
  assert.equal(canAccess(owner, { ownerId: "u1", visibility: "secret" }), false);
});

test("member reads internal resources of others", () => {
  assert.equal(canAccess(member, { ownerId: "u1", visibility: "internal" }), true);
});

test("non-member does not read internal resources of others", () => {
  assert.equal(canAccess(outsider, { ownerId: "u1", visibility: "internal" }), false);
});

test("private resources of others are denied", () => {
  assert.equal(canAccess(member, { ownerId: "u1", visibility: "private" }), false);
});

test("user without roles list is denied on non-public resources", () => {
  assert.equal(canAccess({ id: "u1", active: true }, { ownerId: "u1", visibility: "private" }), false);
});
