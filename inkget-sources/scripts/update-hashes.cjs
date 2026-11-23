'use strict';
// Recalculate the SHA-256 digests of files already declared in an index.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const index = path.resolve(process.argv[2] || 'sources.json');
const manifest = JSON.parse(fs.readFileSync(index, 'utf8'));
if (manifest.format !== 'inkget-source-repository-v1' || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw Error('Not an Inkget repository index.');
for (const file of Object.keys(manifest.files)) {
  if (!/^sources\/[a-z0-9_-]+\.js$/i.test(file)) throw Error(`Invalid source path: ${file}`);
  const bytes = fs.readFileSync(path.join(path.dirname(index), file));
  manifest.files[file] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(index, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated ${Object.keys(manifest.files).length} hashes in ${index}`);
