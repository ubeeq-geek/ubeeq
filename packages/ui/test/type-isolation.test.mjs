import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('UI builds exclude enclosing consumer ambient types without skipping declaration checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-type-isolation-'));
  try {
    const project = join(root, 'checkout');
    await mkdir(join(root, 'node_modules/@types/consumer-only'), { recursive: true });
    await writeFile(join(root, 'node_modules/@types/consumer-only/index.d.ts'),
      'declare const consumerOnly: MissingConsumerType;\n');
    await mkdir(join(project, 'src'), { recursive: true });
    await symlink(dirname(dirname(require.resolve('typescript/package.json'))), join(project, 'node_modules'), 'dir');
    await writeFile(join(project, 'src/react.tsx'), 'export const View = () => <div />;\n');
    await writeFile(join(project, 'src/creator-client.ts'), 'export const client = true;\n');
    const config = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'));
    assert.notEqual(config.compilerOptions.skipLibCheck, true);
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify(config));
    await writeFile(join(project, 'tsconfig.browser.json'), await readFile(join(packageRoot, 'tsconfig.browser.json')));
    const compile = (name) => spawnSync(process.execPath,
      [require.resolve('typescript/bin/tsc'), '-p', join(project, name)], { encoding: 'utf8' });
    for (const name of ['tsconfig.json', 'tsconfig.browser.json']) {
      const result = compile(name);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    // Control: demonstrate that this fixture detects the original ancestor leak.
    delete config.compilerOptions.types;
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify(config));
    const control = compile('tsconfig.json');
    assert.notEqual(control.status, 0);
    assert.match(control.stdout, /MissingConsumerType/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
