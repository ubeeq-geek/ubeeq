import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** v1 retains the original unframed digest. v2 frames paths and bytes with NUL. */
export async function hashDeploymentArtifactDirectory(directory: string, schemaVersion: 1 | 2, legacyExcludedDirectories: readonly string[] = []): Promise<{fileCount: number; sha256: string}> {
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error('Unsupported artifact digest version');
  const root = resolve(directory);
  const files: string[] = [];
  const visit = async (relative = ''): Promise<void> => {
    const current = resolve(root, relative);
    if (!(await lstat(current)).isDirectory()) throw new Error('Artifact roots must be regular directories');
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (schemaVersion === 1 && legacyExcludedDirectories.includes(entry.name)) continue;
        await visit(file);
      } else if (entry.isFile()) files.push(file);
      else throw new Error('Artifact directories must contain regular files only');
    }
  };
  await visit();
  if (!files.length) throw new Error('Artifact directory is empty');
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    digest.update(file);
    if (schemaVersion === 2) digest.update('\0');
    digest.update(await readFile(resolve(root, file)));
    if (schemaVersion === 2) digest.update('\0');
  }
  return {fileCount: files.length, sha256: digest.digest('hex')};
}
