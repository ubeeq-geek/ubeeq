import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [index, stylesheet, thanks, confirmed] = await Promise.all([
  readFile("apps/landing/ubeeq/index.html", "utf8"),
  readFile("apps/landing/ubeeq/site.css", "utf8"),
  readFile("apps/landing/ubeeq/thanks/index.html", "utf8"),
  readFile("apps/landing/ubeeq/confirmed/index.html", "utf8")
]);

assert.match(index, /<title>Ubeeq/);
assert.match(index, /Open source creator infrastructure/);
assert.match(index, /buttondown\.com\/api\/emails\/embed-subscribe\/Ubeeq/);
assert.match(stylesheet, /--/);
assert.match(thanks, /Ubeeq/);
assert.match(confirmed, /Ubeeq/);
console.log("Ubeeq public landing application is complete");
