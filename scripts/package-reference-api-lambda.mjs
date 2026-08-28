import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "apps/reference-api");
const output = join(api, "lambda-package");
const copy = (source, target) => { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); };

if (!existsSync(join(api, "dist/lambda.js"))) throw new Error("Build @ubeeq/reference-api before packaging its Lambda artifact.");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
copy(join(api, "dist"), output);
copy(join(root, "apps", "web-reference", "src"), join(output, "web-reference"));

// AWS SDK v3 is explicitly packaged rather than assumed from a Lambda runtime image.
for (const scope of ["@aws", "@aws-sdk", "@smithy"]) copy(join(root, "node_modules", scope), join(output, "node_modules", scope));
for (const dependency of ["bowser", "mnemonist", "obliterator", "tslib"]) copy(join(root, "node_modules", dependency), join(output, "node_modules", dependency));

// Workspace adapters are real production dependencies of the Lambda entry
// point.  Keep them beside core packages in the artifact so Node can resolve
// the same @ubeeq/* specifiers it resolves during local development.
for (const workspaceRoot of ["packages", "adapters"]) {
  const packages = await import("node:fs/promises").then(({ readdir }) => readdir(join(root, workspaceRoot), { withFileTypes: true }));
  for (const directory of packages.filter((item) => item.isDirectory())) {
    const source = join(root, workspaceRoot, directory.name);
    const manifestPath = join(source, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.name?.startsWith("@ubeeq/")) continue;
    const target = join(output, "node_modules", "@ubeeq", manifest.name.slice("@ubeeq/".length));
    copy(manifestPath, join(target, "package.json"));
    if (existsSync(join(source, "dist"))) copy(join(source, "dist"), join(target, "dist"));
  }
}

// TypeScript emits CommonJS for the Lambda entrypoint; do not mark this artifact ESM.
writeFileSync(join(output, "package.json"), JSON.stringify({ private: true }, null, 2));
console.log(`Packaged Lambda artifact at ${output}`);
