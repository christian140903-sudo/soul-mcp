import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../lib/escape.mjs";

test("escapes angle brackets", () => {
  assert.equal(escapeHtml("<b>fett</b>"), "&lt;b&gt;fett&lt;/b&gt;");
});

test("escapes ampersand first", () => {
  assert.equal(escapeHtml("a & b < c"), "a &amp; b &lt; c");
});

test("leaves plain text untouched", () => {
  assert.equal(escapeHtml("hello world"), "hello world");
});
