import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReferenceHandler } from '../../../apps/web-reference/src/server.mjs';

const output = process.argv[2];
if (!output) throw Error('Supply the Lambda asset directory.');
await mkdir(output, { recursive: true });
const handler = createReferenceHandler({ referenceApiUrl: 'https://reference.invalid' });
for (const [route, file] of [
  ['/workspace', 'workspace.html'], ['/websites', 'websites.html'],
  ['/website-editor.js', 'websites.js'], ['/extension-contracts', 'extension-contracts.json'],
]) {
  let status, headers, body;
  await handler({ url: route }, {
    writeHead(code, values) { status = code; headers = values; },
    end(value) { body = value; },
  });
  if (status !== 200 || body === undefined) throw Error('Build reference web before packaging ' + route);
  await writeFile(join(output, file), body);
  await writeFile(join(output, file + '.headers.json'), JSON.stringify(headers));
}
