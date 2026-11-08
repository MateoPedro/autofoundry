import assert from "node:assert/strict";
import test from "node:test";
import { webUrl } from "../src/lib/url";

test("webUrl keeps http and https URLs", () => {
  assert.equal(webUrl("https://folsomdental.example/contact"), "https://folsomdental.example/contact");
  assert.equal(webUrl("  http://folsomdental.example  "), "http://folsomdental.example/");
});

test("webUrl refuses every other scheme, a bare host, and nothing at all", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:front@folsomdental.example",
    "folsomdental.example",
    "//folsomdental.example",
    "",
    null,
    undefined,
  ]) {
    assert.equal(webUrl(bad), null, String(bad));
  }
});
