import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
for (const category of ['packages', 'adapters', 'apps']) {
  for (const entry of readdirSync(resolve(root, category), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, category, entry.name);
    if (!existsSync(resolve(directory, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }));
    const visit = directory => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
          const source = readFileSync(file, 'utf8');
          for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"](@ubeeq(?:-commercial)?\/[^/'"]+)/g)) {
            const dependency = match[1];
            if (dependency.startsWith('@ubeeq-commercial/')) failures.push(`${manifest.name}: private-tier import is forbidden`);
            else if (!declared.has(dependency)) failures.push(`${manifest.name}: undeclared production dependency ${dependency}`);
          }
        }
      }
    };
    visit(resolve(directory, 'src'));
  }
}
if (failures.length) throw new Error([...new Set(failures)].join('\n'));
console.log('Public package dependency boundaries verified.');
