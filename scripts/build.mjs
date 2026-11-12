import { stripTypeScriptTypes } from 'node:module';
import { readdir, readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
async function compile(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name.replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js'));
    if (entry.isDirectory()) await compile(source, dest);
    else if (entry.name.endsWith('.ts')) {
      const code = stripTypeScriptTypes(await readFile(source, 'utf8'), { mode: 'transform' });
      await writeFile(dest, code);
    } else if (entry.name.endsWith('.cts')) await cp(source, dest);
    else await cp(source, dest);
  }
}
await compile(path.join(root, 'src'), path.join(root, 'build'));
await cp(path.join(root, 'assets'), path.join(root, 'build/assets'), { recursive: true });
console.log('Built application.');
