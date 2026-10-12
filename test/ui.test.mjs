import test from 'node:test';
import assert from 'node:assert/strict';
import { MaskedInput, PrivateDialog } from '../src/private-ui.mjs';
import { Redactor, needsApproval } from '../src/redact.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';
const tui = { requestRender() {} };
const theme = { fg(_color, text) { return text; } };

test('secret rendering is always masked; Unicode editing and bracketed paste preserve data', () => {
  const input = new MaskedInput(); input.focused = true;
  input.handleInput('sëcret🔑');
  for (const width of [1, 2, 10, 80]) {
    const line = input.render(width);
    assert.ok(!line.includes('sëcret'));
    assert.ok(!line.includes('🔑'));
    assert.ok(visibleWidth(line) <= width);
  }
  input.handleInput('\x7f'); assert.equal(input.value, 'sëcret');
  input.handleInput('\x1b[D'); input.handleInput('X'); assert.equal(input.value, 'sëcreXt');
  input.clear();
  input.handleInput('\x1b[200~ p@ss'); input.handleInput(' word \x1b[201~\r');
  assert.equal(input.value, ' p@ss word ');
  input.handleInput('\x1b[200~bad\npassword\x1b[201~');
  assert.equal(input.value, ' p@ss word ');
  input.clear(); assert.equal(input.value, '');
});

test('dialog remembers only when toggled; no rendered credential; disposal and cancellation clear fields', () => {
  let result;
  const dialog = new PrivateDialog(tui, theme, value => { result = value; }, 'https://example.com', ['Username', 'Password'], true);
  dialog.handleInput('alice'); dialog.handleInput('\t'); dialog.handleInput('secret');
  assert.ok(!dialog.render(80).join('\n').includes('alice'));
  assert.ok(!dialog.render(80).join('\n').includes('secret'));
  dialog.handleInput('\t'); dialog.handleInput(' '); dialog.handleInput('\r');
  assert.deepEqual(result, { values: ['alice', 'secret'], remember: true });
  assert.ok(dialog.inputs.every(input => input.value === ''));
  let cancelled = false;
  const controller = new AbortController();
  const other = new PrivateDialog(tui, theme, value => { cancelled = value === undefined; }, 'test', ['Password'], false, controller.signal);
  other.handleInput('secret'); controller.abort();
  assert.ok(cancelled); assert.equal(other.inputs[0].value, '');
});

test('paste does not submit or toggle remember; masked dialog fits narrow widths', () => {
  let result;
  const dialog = new PrivateDialog(tui, theme, value => { result = value; }, 'https://example.com', ['Password'], true);
  dialog.handleInput('\x1b[200~secret\x1b[201~\r');
  assert.equal(result, undefined); assert.equal(dialog.inputs[0].value, 'secret');
  for (const width of [1, 5, 40, 80]) assert.ok(dialog.render(width).every(line => visibleWidth(line) <= width));
  dialog.handleInput('\x1b'); assert.equal(dialog.inputs[0].value, '');
});

test('saved-only approval modes and fail-closed invalid mode', () => {
  const approved = new Set(['a']);
  assert.equal(needsApproval('ask', approved, 'a'), true);
  assert.equal(needsApproval('session', approved, 'a'), false);
  assert.equal(needsApproval('session', approved, 'b'), true);
  assert.equal(needsApproval('yolo', approved, 'b'), false);
  assert.equal(needsApproval('invalid', approved, 'a'), true);
});

test('best-effort filter redacts text, JSON, URL encodings and structured details', () => {
  const filter = new Redactor(); filter.remember('s"ë/cret');
  const data = { content: [{ text: 'value=s"ë/cret' }], details: { raw: JSON.stringify('s"ë/cret') },
    structuredContent: { url: encodeURIComponent('s"ë/cret') } };
  const output = filter.json(data);
  assert.ok(!JSON.stringify(output).includes('cret'));
  filter.clear(); assert.equal(filter.text('s"ë/cret'), 's"ë/cret');
});
