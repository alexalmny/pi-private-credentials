import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fillFields, CDP } from '../src/browser.mjs';

function page() {
  class Input {
    constructor(type) { this.type = type; this.disabled = false; this.readOnly = false; this.events = []; this.form = { action: 'https://example.com/login' }; }
    getClientRects() { return [1]; }
    set value(value) { this.stored = value; }
    get value() { return this.stored; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const password = new Input('password'); const username = new Input('email');
  const fields = { '#password': [password], '#username': [username] };
  const context = { location: { origin: 'https://example.com', protocol: 'https:', href: 'https://example.com/login' },
    document: { querySelectorAll: selector => fields[selector] ?? [] }, HTMLInputElement: Input,
    getComputedStyle: () => ({ visibility: 'visible' }), URL, Event };
  const invoke = (credential, config = {}) => vm.runInNewContext(`(${fillFields.toString()})(config, credential)`, {
    ...context, config: { origin: 'https://example.com', passwordSelector: '#password', usernameSelector: '#username', ...config }, credential });
  return { context, password, username, fields, invoke };
}

test('preflight reads no input values; private fill invokes native setters and events', () => {
  const fixture = page();
  assert.equal(fixture.invoke(null), 'ok'); assert.equal(fixture.password.stored, undefined);
  assert.equal(fixture.invoke({ username: 'alice', password: 'test-secret' }), 'ok');
  assert.equal(fixture.password.stored, 'test-secret'); assert.equal(fixture.username.stored, 'alice');
  assert.deepEqual(fixture.password.events, ['input', 'change']);
});

test('refuse navigated origins, non-password targets, hidden/ambiguous/disabled inputs and cross-origin actions', () => {
  const credentials = { username: 'alice', password: 'secret' };
  const run = change => { const fixture = page(); change(fixture); assert.notEqual(fixture.invoke(credentials), 'ok'); assert.equal(fixture.password.stored, undefined); };
  run(f => { f.context.location.origin = 'https://evil.example'; });
  run(f => { f.password.type = 'text'; });
  run(f => { f.fields['#password'].push(f.password); });
  run(f => { f.password.disabled = true; });
  run(f => { f.password.readOnly = true; });
  run(f => { f.password.getClientRects = () => []; });
  run(f => { f.password.form.action = 'https://evil.example/login'; });
});

test('page exceptions never return their potentially secret text', () => {
  const fixture = page(); fixture.password.dispatchEvent = () => { throw new Error('password=secret'); };
  assert.equal(fixture.invoke({ username: 'user', password: 'secret' }), 'failed');
});

test('password-only steps are supported; non-loopback debugging endpoints rejected', async () => {
  const fixture = page();
  assert.equal(fixture.invoke({ username: 'user', password: 'secret' }, { usernameSelector: undefined }), 'ok');
  assert.equal(fixture.username.stored, undefined);
  await assert.rejects(CDP.connect('ws://example.com/devtools/page/1'), /127.0.0.1/);
  await assert.rejects(CDP.connect('wss://127.0.0.1/devtools/page/1'), /127.0.0.1/);
});
