import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, exactOrigin } from '../src/vault.ts';
import { windowsPrivate } from '../src/permissions.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const windows = process.platform === 'win32';
async function grantEveryone(path) {
  await run('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
}
async function revokeEveryone(path) {
  await run('icacls.exe', [path, '/remove:g', '*S-1-1-0'], { windowsHide: true });
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-vault-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Vault(join(dir, 'vault'));
}
const master = 'test-only long master passphrase';

test('encrypted roundtrip; plaintext and usernames are absent; restrictive permissions', async t => {
  const vault = await fixture(t);
  await vault.unlock(master);
  await vault.save('https://example.com', 'private-user', 'test-password');
  const text = await readFile(vault.file, 'utf8');
  for (const secret of ['private-user', 'test-password', master, 'example.com']) assert.ok(!text.includes(secret));
  if (windows) {
    await windowsPrivate(vault.dir);
    await windowsPrivate(vault.file);
  } else {
    assert.equal((await stat(vault.file)).mode & 0o777, 0o600);
    assert.equal((await stat(vault.dir)).mode & 0o777, 0o700);
  }
  vault.lock();
  await assert.rejects(vault.read(), /locked/);
  await vault.unlock(master);
  assert.equal((await vault.read()).accounts[0].password, 'test-password');
  await vault.save('https://example.com', 'private-user', 'replacement');
  assert.equal((await vault.read()).accounts.length, 1);
  assert.equal((await vault.read()).accounts[0].password, 'replacement');
});

test('existing unsafe directories are refused, not silently repaired', async t => {
  const vault = await fixture(t);
  await mkdir(vault.dir, { mode: 0o700 });
  if (windows) await grantEveryone(vault.dir);
  else await chmod(vault.dir, 0o755);
  await assert.rejects(vault.unlock(master), /permissions|0700/);
  await assert.rejects(vault.unlock(master), /permissions|0700/);
});

test('private directories support literal Unicode paths and refuse directory links', async t => {
  const vault = await fixture(t);
  const literal = new Vault(join(vault.dir, "café ' $literal [vault]"));
  await literal.unlock(master);
  await literal.save('https://example.com', 'user', 'synthetic-secret');
  assert.equal((await literal.read()).accounts[0].password, 'synthetic-secret');
  const link = join(vault.dir, 'linked-vault');
  await symlink(literal.dir, link, windows ? 'junction' : 'dir');
  await assert.rejects(new Vault(link).unlock(master), /link/);
});

test('wrong passphrase and authenticated ciphertext tampering fail without overwriting', async t => {
  const vault = await fixture(t);
  await vault.unlock(master);
  await vault.save('https://example.com', 'user', 'secret');
  const original = await readFile(vault.file, 'utf8');
  await assert.rejects(vault.unlock('wrong password'), /Wrong master/);
  assert.equal(await readFile(vault.file, 'utf8'), original);
  const changed = JSON.parse(original);
  const body = Buffer.from(changed.body, 'base64'); body[0] ^= 1; changed.body = body.toString('base64');
  await writeFile(vault.file, JSON.stringify(changed));
  await assert.rejects(vault.unlock(master), /Wrong master/);
});

test('fresh salt/nonces, strong master requirement, persistent approval setting', async t => {
  const vault = await fixture(t);
  await assert.rejects(vault.unlock('short'), /12 characters/);
  await vault.unlock(master);
  await vault.mutate(data => { data.mode = 'session'; });
  const first = JSON.parse(await readFile(vault.file, 'utf8'));
  await vault.mutate(data => { data.mode = 'yolo'; });
  const second = JSON.parse(await readFile(vault.file, 'utf8'));
  assert.notEqual(first.iv, second.iv);
  vault.lock(); await vault.unlock(master);
  assert.equal((await vault.read()).mode, 'yolo');
});

test('two writers merge fresh data; lock blocks writes; permissions and symlinks refused', async t => {
  const vault = await fixture(t);
  await vault.unlock(master);
  await vault.save('https://example.com', 'first', 'secret');
  const other = new Vault(vault.dir); await other.unlock(master);
  await other.save('https://example.org', 'second', 'secret');
  await vault.save('https://example.net', 'third', 'secret');
  assert.equal((await vault.read()).accounts.length, 3);
  const lock = join(vault.dir, 'write.lock'); await mkdir(lock);
  await assert.rejects(vault.save('https://example.com', 'fourth', 'secret'), /busy/);
  await rm(lock, { recursive: true });
  if (windows) {
    await grantEveryone(vault.file);
    await assert.rejects(vault.read(), /permissions/);
    await revokeEveryone(vault.file);
    await grantEveryone(vault.dir);
    await assert.rejects(other.unlock(master), /permissions/);
    await revokeEveryone(vault.dir);
  } else {
    await chmod(vault.file, 0o644); await assert.rejects(vault.read(), /permissions/);
    await chmod(vault.file, 0o600);
  }
  const text = await readFile(vault.file); await rm(vault.file);
  await writeFile(join(vault.dir, 'target'), text, { mode: 0o600 });
  try { await symlink(join(vault.dir, 'target'), vault.file); }
  catch (error) {
    if (!windows || error.code !== 'EPERM') throw error;
    // Unprivileged Windows can create junctions even when file symlinks require Developer Mode.
    await symlink(vault.dir, vault.file, 'junction');
  }
  await assert.rejects(vault.read(), /safely/);
});

test('a disappeared vault is not silently recreated; a new writer cannot overwrite an independently created vault', async t => {
  const vault = await fixture(t);
  const other = new Vault(vault.dir);
  await vault.unlock(master); await other.unlock(master);
  await vault.save('https://example.com', 'first', 'secret');
  await assert.rejects(other.save('https://example.org', 'second', 'secret'), /changed/);
  await rm(vault.file);
  await assert.rejects(vault.save('https://example.net', 'third', 'secret'), /disappeared/);
});

test('generic fields extend existing vaults; temporary fields are never persisted and reusable saves replace only exact matches', async t => {
  const vault = await fixture(t);
  const origin = 'https://example.com';
  const field = { label: 'Account ID', selector: '#account', hidden: false, temporary: false, value: 'private-account' };
  const temporary = { label: 'Verification code', selector: '#code', hidden: true, temporary: true, value: 'never-persist-code' };
  assert.deepEqual(await vault.saveFields(origin, [temporary]), []);
  await vault.unlock(master);
  await vault.save(origin, 'legacy-user', 'legacy-password');
  const [id] = await vault.saveFields(origin, [field, temporary]);
  let data = await vault.read();
  assert.equal(data.accounts.length, 1); assert.equal(data.fields.length, 1);
  assert.equal(data.fields[0].value, field.value);
  assert.ok(!JSON.stringify(data).includes(temporary.value));
  await vault.saveFields(origin, [{ ...field, value: 'updated-account' }]);
  data = await vault.read(); assert.equal(data.fields.length, 1); assert.equal(data.fields[0].id, id);
  await vault.saveFields('https://other.example', [field]);
  assert.equal((await vault.read()).fields.length, 2);
  const encrypted = await readFile(vault.file, 'utf8');
  for (const value of ['private-account', 'updated-account', 'Account ID', temporary.value]) assert.ok(!encrypted.includes(value));
  vault.lock(); await vault.unlock(master);
  assert.equal((await vault.read()).accounts[0].password, 'legacy-password');
  assert.equal((await vault.read()).fields[0].value, 'updated-account');
});

test('exact HTTPS origin: reject paths, userinfo, HTTP, subdomain confusion and normalization', () => {
  assert.equal(exactOrigin('https://example.com'), 'https://example.com');
  assert.equal(exactOrigin('https://example.com:8443'), 'https://example.com:8443');
  for (const value of ['http://example.com', 'https://example.com/', 'https://example.com/login',
    'https://user:pass@example.com', 'https://EXAMPLE.com', 'https://example.com:443', 'javascript:alert(1)'])
    assert.throws(() => exactOrigin(value));
});
