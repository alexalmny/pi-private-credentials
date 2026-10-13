import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use Pi's installed loader dependency, not a separate runtime dependency for the extension.
const { createJiti } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('jiti');

test('all local source helpers use the reloadable .ts path', async () => {
  for (const file of await readdir(new URL('../src/', import.meta.url))) {
    assert.ok(file.endsWith('.ts'), `${file} would be cached by native ESM imports`);
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!/from ['"]\.\/.+\.mjs['"]/.test(source));
  }
});

test('Pi-style extension reload refreshes .ts helpers rather than retaining native .mjs code', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credentials-reload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'index.ts'); const helper = join(dir, 'helper.ts');
  await writeFile(entry, "import { version } from './helper.ts'; export default version;");
  const load = () => createJiti(import.meta.url, { moduleCache: false, tryNative: false }).import(entry, { default: true });
  await writeFile(helper, 'export const version = 1;'); assert.equal(await load(), 1);
  await writeFile(helper, 'export const version = 2;'); assert.equal(await load(), 2);
});
