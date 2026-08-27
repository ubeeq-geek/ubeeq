import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectory = new URL("../packages", import.meta.url).pathname;
const violations = [];

for (const entry of readdirSync(packageDirectory)) {
  if (!entry.startsWith("adapters-")) continue;
  const manifestPath = join(packageDirectory, entry, "package.json");
  if (!existsSync(manifestPath)) {
    violations.push(`${entry}: adapter package must include package.json`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const test = manifest.scripts?.test;
  const contract = manifest.scripts?.["test:contract"];
  if (typeof contract !== "string" || !contract.trim()) violations.push(`${entry}: missing test:contract script`);
  if (typeof test !== "string" || !test.includes("test:contract")) violations.push(`${entry}: test script must execute test:contract`);
}

if (violations.length) throw new Error(`Adapter contract gate failed:\n${violations.join("\n")}`);
