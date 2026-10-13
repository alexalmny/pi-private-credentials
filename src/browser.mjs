import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exactOrigin } from './vault.mjs';

function loopback(value, protocol) {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || url.username || url.password)
    throw new Error('Chrome debugging connection must use 127.0.0.1.');
  return url;
}

export async function pageTargets(profile, origin) {
  exactOrigin(origin);
  let port;
  try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
  catch { throw new Error('Chrome debugging port unavailable. Start Chrome MCP with --chromeArg=--remote-debugging-port=0 and navigate first.'); }
  if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid Chrome debugging port.');
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error();
    targets = await response.json();
    if (!Array.isArray(targets)) throw new Error();
  } catch { throw new Error('Cannot connect privately to Chrome.'); }
  return targets.filter(target => {
    try { return target.type === 'page' && new URL(target.url).origin === origin; } catch { return false; }
  }).map(target => {
    const ws = loopback(target.webSocketDebuggerUrl, 'ws:');
    if (ws.port !== port || !ws.pathname.startsWith('/devtools/page/')) throw new Error('Invalid Chrome page endpoint.');
    return { id: target.id, ws: ws.href };
  });
}

export class CDP {
  pending = new Map();
  id = 0;
  static async connect(url, signal) {
    loopback(url, 'ws:');
    if (signal?.aborted) throw new Error('Credential fill cancelled.');
    const client = new CDP();
    client.ws = new WebSocket(url);
    client.signal = signal;
    client.abort = () => client.close();
    signal?.addEventListener('abort', client.abort, { once: true });
    client.ws.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        const call = client.pending.get(message.id);
        if (!call) return;
        client.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error('Chrome rejected the private operation.'));
        else call.resolve(message.result);
      } catch { client.close(); }
    });
    client.ws.addEventListener('close', () => client.fail());
    client.ws.addEventListener('error', () => client.fail());
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('Private Chrome connection timed out.')); }, 5000);
        const finish = (error) => { clearTimeout(timer); error ? reject(new Error('Private Chrome connection failed.')) : resolve(); };
        client.ws.addEventListener('open', () => finish(false), { once: true });
        client.ws.addEventListener('error', () => finish(true), { once: true });
        client.ws.addEventListener('close', () => finish(true), { once: true });
      });
      return client;
    } catch (error) { client.close(); throw error; }
  }
  fail() {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('Private Chrome connection closed.')); }
    this.pending.clear();
  }
  close() {
    this.signal?.removeEventListener('abort', this.abort);
    this.fail();
    this.ws.close();
  }
  call(method, params) {
    if (this.signal?.aborted || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Private Chrome connection unavailable.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Private Chrome operation timed out.')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('Private Chrome operation failed.')); }
    });
  }
  async window() {
    const result = await this.call('Runtime.evaluate', { expression: 'window', returnByValue: false, silent: true });
    if (result.exceptionDetails || !result.result?.objectId) throw new Error('Chrome page unavailable.');
    return result.result.objectId;
  }
  async invoke(objectId, config, credential) {
    const result = await this.call('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fillFields.toString(),
      arguments: [config, credential ?? null].map(value => ({ value })), returnByValue: true, silent: true,
    });
    // Never propagate exception descriptions, remote objects, or page-generated strings.
    if (result.exceptionDetails || result.result?.value !== 'ok')
      throw new Error('Fill refused: origin changed, fields are ambiguous/unavailable, or form action is not same-origin HTTPS.');
  }
}

// shortcut: top-level inputs only, add explicit frame-origin approval before supporting iframe forms.
// Runs synchronously in one document, both for preflight and immediately before writing secrets.
export function fillFields(config, credential) {
  try {
    if (location.origin !== config.origin || location.protocol !== 'https:') return 'origin';
    const fields = config.fields ?? [
      ...(config.usernameSelector ? [{ selector: config.usernameSelector, hidden: true }] : []),
      { selector: config.passwordSelector, hidden: true, mustBePassword: true },
    ];
    const find = field => {
      const selector = field.selector;
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1) return null;
      const input = matches[0];
      const textArea = typeof HTMLTextAreaElement !== 'undefined' && input instanceof HTMLTextAreaElement;
      if (!(input instanceof HTMLInputElement) && !textArea) return null;
      if (input.disabled || input.readOnly || !input.getClientRects().length || getComputedStyle(input).visibility !== 'visible' ||
          (field.mustBePassword ? input.type !== 'password' : !textArea && !['text', 'email', 'tel', 'password', 'number', 'url', 'search'].includes(input.type)) ||
          (input.type === 'password' && !field.hidden)) return null;
      if (input.form && new URL(input.form.action, location.href).origin !== config.origin) return null;
      return input;
    };
    const inputs = fields.map(find);
    if (!inputs.length || inputs.some(input => !input) || new Set(inputs).size !== inputs.length) return 'fields';
    if (!credential) return 'ok';
    const values = config.fields ? credential.values : (config.usernameSelector ? [credential.username, credential.password] : [credential.password]);
    if (!Array.isArray(values) || values.length !== fields.length || values.some(value => typeof value !== 'string')) return 'fields';
    const written = new Set();
    // Notify each field before writing the next: controlled forms can rerender other inputs.
    for (const [index, field] of fields.entries()) {
      if (location.origin !== config.origin || location.protocol !== 'https:') return 'origin';
      const input = find(field);
      if (!input || written.has(input)) return 'fields';
      written.add(input);
      const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, values[index]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (location.origin !== config.origin || location.protocol !== 'https:') return 'origin';
    return fields.every((field, index) => find(field)?.value === values[index]) ? 'ok' : 'fields';
  } catch { return 'failed'; }
}
