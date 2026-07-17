import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../lib/escape.mjs";

test("escapes double and single quotes for attribute contexts", () => {
  assert.equal(escapeHtml('x" onmouseover="alert(1)'), "x&quot; onmouseover=&quot;alert(1)");
  assert.equal(escapeHtml("it's"), "it&#39;s");
});
