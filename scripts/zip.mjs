// Packages dist/ into vidioma-<version>.zip (for the Chrome Web Store or sharing).
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function collect(dir, out = {}) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) await collect(full, out);
    else out[path.relative(dist, full).split(path.sep).join('/')] = new Uint8Array(await readFile(full));
  }
  return out;
}

const files = await collect(dist);
const zip = zipSync(files, { level: 9 });
const out = path.join(root, `vidioma-${pkg.version}.zip`);
await writeFile(out, zip);
console.log(`${path.relative(root, out)}: ${Object.keys(files).length} files, ${(zip.length / 1024 / 1024).toFixed(1)} MB`);
