import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ignored = new Set([".git", "node_modules", "dist"]);
const self = "scripts/check-public-boundary.mjs";
const protectedNames = ["eversally", "nightframe"];
const violations = [];
const cloudImport = /(?:from\s*["']|require\s*\(\s*["'])(?:@aws-sdk\/|@aws-cdk\/|aws-cdk-lib|constructs)/;
const cloudAllowedPath = (path) => path.startsWith("packages/adapters-aws/")
  || path.startsWith("examples/aws-self-host/")
  || path.startsWith("packages/aws-self-host-infra/");

const visit = (directory) => {
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const file = join(directory, entry);
    const path = relative(root, file);
    if (path === self) continue;
    if (statSync(file).isDirectory()) visit(file);
    else if (/\.(?:ts|tsx|js|mjs|json|md|ya?ml|css|html)$/i.test(file)) {
      const rawContents = readFileSync(file, "utf8");
      const contents = rawContents.toLowerCase();
      for (const name of protectedNames) if (contents.includes(name)) violations.push(`${path}: contains protected hosted-product name \"${name}\"`);
      if (/\.(?:ts|tsx|js|mjs)$/i.test(path) && cloudImport.test(rawContents) && !cloudAllowedPath(path)) {
        violations.push(`${path}: imports a cloud SDK outside an approved AWS adapter/example package`);
      }
    }
  }
};

visit(root);
if (violations.length) throw new Error(`Public boundary check failed:\n${violations.join("\n")}`);
