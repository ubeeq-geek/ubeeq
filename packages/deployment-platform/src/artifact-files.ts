import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type DeploymentArtifactSchemaVersion = 1 | 2 | 3;

/** Keep the digest wire format stable for each manifest version. */
export async function hashDeploymentArtifactDirectory(directory: string, schemaVersion: DeploymentArtifactSchemaVersion, legacyExcludedDirectories: readonly string[] = []): Promise<{fileCount: number; sha256: string}> {
  if (![1, 2, 3].includes(schemaVersion)) throw new Error('Unsupported artifact digest version');
  const root = resolve(directory);
  const files: string[] = [];
  const visit = async (relative = ''): Promise<void> => {
    const current = resolve(root, relative);
    if (!(await lstat(current)).isDirectory()) throw new Error('Artifact roots must be regular directories');
    if (schemaVersion === 3) {
      for (const name of await readdir(current, {encoding: 'buffer'})) {
        if (!Buffer.from(name.toString('utf8')).equals(name)) throw new Error('Artifact paths must be valid UTF-8');
      }
    }
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
  const updateWithLength = (bytes: Buffer): void => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  };
  if (schemaVersion === 3) digest.update('ubeeq-deployment-artifact-v3\0');
  for (const file of files.sort()) {
    const bytes = await readFile(resolve(root, file));
    if (schemaVersion === 3) {
      updateWithLength(Buffer.from(file));
      updateWithLength(bytes);
      continue;
    }
    digest.update(file);
    if (schemaVersion === 2) digest.update('\0');
    digest.update(bytes);
    if (schemaVersion === 2) digest.update('\0');
  }
  return {fileCount: files.length, sha256: digest.digest('hex')};
}
