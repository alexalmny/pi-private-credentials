import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

import { validateFields, fieldKey } from './fields.ts';
import { windowsPrivate } from './permissions.ts';

const derive = promisify(scrypt);
const AAD = Buffer.from('pi-private-credentials:v1:scrypt-32768-8-1');
const LIMIT = 8 * 1024 * 1024;
export const MODES = ['ask', 'session', 'yolo'];

export function exactOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value)
    throw new Error('Use an exact HTTPS origin, such as https://example.com (no path).');
  return url.origin;
}

async function privateDirectory(dir) {
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe vault directory: links are refused.');
  if (process.platform === 'win32') await windowsPrivate(dir, created !== undefined);
  else if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('Vault directory must be owned by you, not a symlink, and have mode 0700.');
}

async function readPrivate(file) {
  let handle;
  try {
    if (process.platform === 'win32') {
      if (!(await lstat(file)).isFile()) throw new Error('Links are refused.');
      await windowsPrivate(file);
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Cannot safely open vault: unsafe permissions or link.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT || (process.platform !== 'win32' &&
        ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))))
      throw new Error('Unsafe vault permissions or size.');
    if (process.platform === 'win32') {
      const pathStat = await lstat(file);
      if (!pathStat.isFile() || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev)
        throw new Error('Cannot safely open vault: file changed.');
    }
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

function bytes(text, size) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid vault.');
  const value = Buffer.from(text, 'base64');
  if (value.toString('base64') !== text || (size !== undefined && value.length !== size))
    throw new Error('Invalid vault.');
  return value;
}

function envelope(text) {
  const data = JSON.parse(text);
  if (data.version !== 1) throw new Error('Unsupported vault version.');
  return { salt: bytes(data.salt, 16), iv: bytes(data.iv, 12), tag: bytes(data.tag, 16), body: bytes(data.body) };
}

function validate(data) {
  if (!MODES.includes(data.mode) || !Array.isArray(data.accounts) || data.accounts.length > 1000)
    throw new Error('Invalid vault data.');
  const ids = new Set();
  for (const account of data.accounts) {
    exactOrigin(account.origin);
    if (typeof account.id !== 'string' || ids.has(account.id) || typeof account.username !== 'string' ||
        typeof account.password !== 'string' || !account.password || account.password.length > 65536 ||
        account.username.length > 65536) throw new Error('Invalid account data.');
    ids.add(account.id);
  }
  if (data.fields !== undefined) {
    if (!Array.isArray(data.fields) || data.fields.length > 1000) throw new Error('Invalid saved fields.');
    const keys = new Set();
    for (const field of data.fields) {
      exactOrigin(field.origin);
      validateFields([{ ...field, temporary: false }]);
      const key = JSON.stringify([field.origin, fieldKey(field)]);
      if (typeof field.id !== 'string' || ids.has(field.id) || keys.has(key) ||
          typeof field.value !== 'string' || !field.value || field.value.length > 65536 || field.temporary !== undefined)
        throw new Error('Invalid saved field data.');
      ids.add(field.id); keys.add(key);
    }
  }
  return data;
}

function decrypt(text, key) {
  const value = envelope(text);
  const cipher = createDecipheriv('aes-256-gcm', key, value.iv);
  cipher.setAAD(AAD);
  cipher.setAuthTag(value.tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([cipher.update(value.body), cipher.final()]);
    return validate(JSON.parse(plaintext.toString('utf8')));
  } finally { plaintext?.fill(0); }
}

export class Vault {
  constructor(dir) { this.dir = dir; this.file = join(dir, 'vault.json'); }
  get unlocked() { return !!this.key; }
  async exists() { await privateDirectory(this.dir); return (await readPrivate(this.file)) !== undefined; }
  lock() { this.key?.fill(0); this.key = undefined; this.salt = undefined; this.persisted = false; }

  async unlock(passphrase) {
    this.lock();
    await privateDirectory(this.dir);
    const text = await readPrivate(this.file);
    if (!text && passphrase.length < 12) throw new Error('New master passphrase must be at least 12 characters.');
    const salt = text ? envelope(text).salt : randomBytes(16);
    const key = await derive(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try { if (text) decrypt(text, key); }
    catch { key.fill(0); throw new Error('Wrong master passphrase or damaged vault. Nothing was changed.'); }
    this.key = key;
    this.salt = salt;
    this.persisted = text !== undefined;
  }

  async read() {
    if (!this.key) throw new Error('Vault is locked.');
    const text = await readPrivate(this.file);
    if (text === undefined) {
      if (this.persisted) throw new Error('Vault disappeared; refusing to recreate it.');
      return { mode: 'ask', accounts: [] };
    }
    if (!envelope(text).salt.equals(this.salt)) throw new Error('Vault changed; lock and unlock again.');
    return decrypt(text, this.key);
  }

  async mutate(update) {
    if (!this.key) throw new Error('Vault is locked.');
    const lockDir = join(this.dir, 'write.lock');
    try { await mkdir(lockDir, { mode: 0o700 }); }
    catch { throw new Error('Vault is busy. If a writer crashed, remove write.lock only after all Pi sessions stop.'); }
    const temp = join(this.dir, `.vault-${randomUUID()}.tmp`);
    try {
      const data = await this.read();
      update(data);
      validate(data);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(AAD);
      const plaintext = Buffer.from(JSON.stringify(data));
      let body;
      try { body = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
      finally { plaintext.fill(0); }
      const text = JSON.stringify({ version: 1, salt: this.salt.toString('base64'), iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
      if (Buffer.byteLength(text) > LIMIT) throw new Error('Vault size limit reached.');
      const handle = await open(temp, 'wx', 0o600);
      try {
        if (process.platform === 'win32') await windowsPrivate(temp, true);
        await handle.writeFile(text);
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, this.file);
      this.persisted = true;
      // Windows cannot open/fsync directories; the file is still synced before atomic rename.
      if (process.platform !== 'win32') {
        const directory = await open(this.dir, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await unlink(temp).catch(() => {});
      await rmdir(lockDir);
    }
  }

  // One reusable value per exact origin/label/selector/visibility; saving explicitly replaces it.
  async saveFields(origin, fields) {
    exactOrigin(origin);
    validateFields(fields);
    const reusable = fields.filter(field => !field.temporary);
    if (!reusable.length) return [];
    const ids = [];
    await this.mutate(data => {
      data.fields ??= [];
      for (const field of reusable) {
        const existing = data.fields.find(saved => saved.origin === origin && fieldKey(saved) === fieldKey(field));
        if (existing) { existing.value = field.value; ids.push(existing.id); }
        else {
          const saved = { id: randomUUID(), origin, label: field.label, selector: field.selector, hidden: field.hidden, value: field.value };
          data.fields.push(saved); ids.push(saved.id);
        }
      }
    });
    return ids;
  }

  async save(origin, username, password) {
    exactOrigin(origin);
    let id = randomUUID();
    await this.mutate(data => {
      const existing = data.accounts.find(a => a.origin === origin && a.username === username);
      if (existing) { existing.password = password; id = existing.id; }
      else data.accounts.push({ id, origin, username, password });
    });
    return id;
  }
}
