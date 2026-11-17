import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const license = read('LICENSE');
assert.match(license, /^MIT License\n/);
const lock = JSON.parse(read('package-lock.json'));
const packages = Object.entries(lock.packages).filter(([path]) => !path.split('/').includes('node_modules'));
for (const [path, metadata] of packages) {
  const prefix = path ? `${path}/` : '';
  const manifest = JSON.parse(read(`${prefix}package.json`));
  assert.equal(manifest.license, 'MIT', `${manifest.name} must declare MIT`);
  assert.equal(metadata.license, 'MIT', `${manifest.name} lock metadata must declare MIT`);
  assert.equal(read(`${prefix}LICENSE`), license, `${manifest.name} must ship the project license`);
}
console.log(`MIT license verified for ${packages.length} workspace manifests and license files.`);
