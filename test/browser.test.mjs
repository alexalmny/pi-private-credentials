import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fillFields, CDP, FillError } from '../src/browser.ts';

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

test('controlled forms keep both values when username events rerender the password input', () => {
  const fixture = page();
  let committedPassword = '';
  fixture.username.dispatchEvent = () => { fixture.password.stored = committedPassword; };
  fixture.password.dispatchEvent = () => { committedPassword = fixture.password.stored; };
  assert.equal(fixture.invoke({ username: 'alice', password: 'test-secret' }), 'ok');
  assert.equal(fixture.username.stored, 'alice');
  assert.equal(fixture.password.stored, 'test-secret');
});

test('revalidate and resolve password inputs after username-triggered DOM changes', () => {
  const replaced = page();
  const replacement = new replaced.context.HTMLInputElement('password');
  replaced.username.dispatchEvent = () => { replaced.fields['#password'] = [replacement]; };
  assert.equal(replaced.invoke({ username: 'alice', password: 'test-secret' }), 'ok');
  assert.equal(replacement.stored, 'test-secret');
  assert.equal(replaced.password.stored, undefined);
  for (const change of [
    f => { f.password.type = 'text'; },
    f => { f.context.location.origin = 'https://evil.example'; },
    f => { f.password.form.action = 'https://evil.example/login'; },
  ]) {
    const fixture = page();
    fixture.username.dispatchEvent = () => change(fixture);
    assert.notEqual(fixture.invoke({ username: 'alice', password: 'test-secret' }), 'ok');
    assert.equal(fixture.password.stored, undefined);
  }
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

test('arbitrary text/code fields fill privately; alias selectors, unmasked passwords and non-text widgets are refused', () => {
  const fixture = page();
  const fields = [
    { label: 'Account', selector: '#username', hidden: false, temporary: false },
    { label: 'Code', selector: '#password', hidden: true, temporary: true },
  ];
  fixture.password.type = 'text';
  assert.equal(fixture.invoke({ values: ['account-id', '123456'] }, { fields }), 'ok');
  assert.equal(fixture.password.stored, '123456');
  fixture.password.type = 'password'; fields[1].hidden = false;
  assert.notEqual(fixture.invoke({ values: ['account-id', '123456'] }, { fields }), 'ok');
  fields[1].hidden = true; fixture.password.type = 'checkbox';
  assert.notEqual(fixture.invoke({ values: ['account-id', '123456'] }, { fields }), 'ok');
  fixture.password.type = 'text'; fixture.fields['#alias'] = [fixture.password];
  assert.notEqual(fixture.invoke({ values: ['one', 'two'] }, { fields: [fields[1], { ...fields[1], selector: '#alias' }] }), 'ok');
});

test('a form that discards typed data reports failure instead of a false success', () => {
  const fixture = page();
  fixture.password.dispatchEvent = () => { fixture.password.stored = ''; };
  assert.notEqual(fixture.invoke({ username: 'alice', password: 'test-secret' }), 'ok');
});

test('refusal diagnostics are specific but never include page-generated text or exception descriptions', async () => {
  const fixture = page();
  fixture.password.disabled = true; assert.equal(fixture.invoke(null), 'unavailable');
  fixture.password.disabled = false; fixture.password.form.action = 'https://other.example';
  assert.equal(fixture.invoke(null), 'action');
  const client = new CDP();
  for (const reply of [{ result: { value: 'page-secret' } }, { exceptionDetails: { text: 'page-secret' } }]) {
    client.call = async () => reply;
    await assert.rejects(client.invoke('window', {}), error => error instanceof FillError && error.reason === 'failed' && !error.message.includes('page-secret'));
  }
  client.call = async () => ({ result: { value: 'mismatch' } });
  await assert.rejects(client.invoke('window', {}), /page changed or discarded/);
});

test('password-only steps are supported; non-loopback debugging endpoints rejected', async () => {
  const fixture = page();
  assert.equal(fixture.invoke({ username: 'user', password: 'secret' }, { usernameSelector: undefined }), 'ok');
  assert.equal(fixture.username.stored, undefined);
  await assert.rejects(CDP.connect('ws://example.com/devtools/page/1'), /127.0.0.1/);
  await assert.rejects(CDP.connect('wss://127.0.0.1/devtools/page/1'), /127.0.0.1/);
});
