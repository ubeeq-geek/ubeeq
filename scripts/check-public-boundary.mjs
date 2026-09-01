import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ignored = new Set([".git", "node_modules", "dist"]);
const self = "scripts/check-public-boundary.mjs";
const protectedNames = ["eversally", "nightframe"];
// Public Ubeeq contains no product runtime code, defaults, or product-facing
// documentation. This boundary-design record is intentionally the one
// exception: it documents how separately owned private UI extensions relate to
// the public contracts. Keep this list explicit and narrow.
const protectedNameDocumentationExceptions = new Set(["docs/ui-mockup-specification.md"]);
const violations = [];
const cloudImport = /(?:from\s*["']|require\s*\(\s*["'])(?:@aws-sdk\/|@aws-cdk\/|aws-cdk-lib|constructs)/;
const cloudAllowedPath = (path) => path.startsWith("adapters/aws/")
  // The machine adapter uses the S3 protocol client for MinIO/Ceph-compatible
  // stores. It remains an adapter boundary, never an application dependency.
  || path.startsWith("adapters/machine/")
  || path.startsWith("examples/aws-serverless/")
  || path.startsWith("deployments/aws-serverless/");

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
      if (!protectedNameDocumentationExceptions.has(path)) {
        for (const name of protectedNames) if (contents.includes(name)) violations.push(`${path}: contains protected hosted-product name \"${name}\"`);
      }
      if (/\.(?:ts|tsx|js|mjs)$/i.test(path) && cloudImport.test(rawContents) && !cloudAllowedPath(path)) {
        violations.push(`${path}: imports a cloud SDK outside an approved provider adapter/example package`);
      }
    }
  }
};

visit(root);
if (violations.length) throw new Error(`Public boundary check failed:\n${violations.join("\n")}`);
