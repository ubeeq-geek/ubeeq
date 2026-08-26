import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ignored = new Set([".git", "node_modules", "dist"]);
const self = "scripts/check-public-boundary.mjs";
const protectedNames = ["eversally", "nightframe"];
const violations = [];

const visit = (directory) => {
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const file = join(directory, entry);
    const path = relative(root, file);
    if (path === self) continue;
    if (statSync(file).isDirectory()) visit(file);
    else if (/\.(?:ts|tsx|js|mjs|json|md|ya?ml|css|html)$/i.test(file)) {
      const contents = readFileSync(file, "utf8").toLowerCase();
      for (const name of protectedNames) if (contents.includes(name)) violations.push(`${path}: contains protected hosted-product name \"${name}\"`);
    }
  }
};

visit(root);
if (violations.length) throw new Error(`Public boundary check failed:\n${violations.join("\n")}`);

