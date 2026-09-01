const [major, minor] = process.versions.node.split('.').map(Number);
const supportsNodeSqlite = major > 22 || (major === 22 && minor >= 5);

if (!supportsNodeSqlite) {
  console.error(`Ubeeq's local reference API requires Node 22.5.0 or newer (current: ${process.versions.node}).`);
  console.error('The local SQLite adapter uses Node\'s built-in node:sqlite module.');
  console.error('With nvm: nvm install 22 && nvm use 22');
  process.exitCode = 1;
}
