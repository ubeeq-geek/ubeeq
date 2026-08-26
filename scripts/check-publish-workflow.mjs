import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packagesDirectory = resolve("packages");
const workflow = await readFile(resolve(".github/workflows/publish-packages.yml"), "utf8");
const packageDirectories = await readdir(packagesDirectory, { withFileTypes: true });
const publicPackages = [];

for (const entry of packageDirectories) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(await readFile(resolve(packagesDirectory, entry.name, "package.json"), "utf8"));
  if (manifest.private !== false) continue;
  publicPackages.push(manifest.name);
}

const missingPackages = publicPackages.filter((packageName) => !workflow.includes(`--workspace ${packageName}`));
if (missingPackages.length > 0) {
  throw new Error(`The publish workflow omits public packages: ${missingPackages.join(", ")}`);
}

console.log(`Publish workflow covers ${publicPackages.length} public packages`);
