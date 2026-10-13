import test from 'node:test';
import assert from 'node:assert/strict';
import { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { PrivateDialog, PrivateChoice, privatePrompt, privateSelect, privateConfirm } from '../src/private-ui.ts';

const theme = new Theme({ accent: 39, text: 250, dim: 240, muted: 245, success: 34, warning: 214, error: 160, thinkingXhigh: 245 }, { selectedBg: 236 }, '256color');
const tui = { terminal: { rows: 24 }, requestRender() {} };

test('RPIV-style entry has accent rules, badge, tree context and field tabs; review never reveals values', () => {
  let result;
  const dialog = new PrivateDialog(tui, theme, value => { result = value; }, 'https://example.com\nFill only; never submits.', [
    { label: 'Account', hidden: false, temporary: false }, { label: 'Code', hidden: true, temporary: true },
  ], true);
  let view = dialog.render(80).join('\n');
  for (const text of ['─', 'Private credentials', '├─', '└─', '□ Account', 'Visible locally', 'Code']) {
    assert.ok(view.includes(text));
  }
  assert.ok(view.includes('\x1b['), 'uses the real Pi theme');
  dialog.handleInput('visible-account'); dialog.handleInput('\r');
  assert.equal(result, undefined); assert.equal(dialog.index, 1);
  dialog.handleInput('hidden-code');
  view = dialog.render(80).join('\n'); assert.ok(view.includes('temporary, never saved')); assert.ok(!view.includes('hidden-code'));
  dialog.handleInput('\r');
  view = dialog.render(80).join('\n'); assert.ok(!view.includes('visible-account')); assert.ok(!view.includes('hidden-code'));
  assert.equal(dialog.remember, false);
  dialog.handleInput('\x1b[A'); dialog.handleInput(' '); dialog.handleInput('\r'); dialog.handleInput('\r');
  assert.deepEqual(result, { values: ['visible-account', 'hidden-code'], remember: true });
  assert.deepEqual(dialog.render(80), []);
});

test('resize keeps focus/controls within the row budget; tiny screens refuse blind entry', () => {
  const terminal = { rows: 18 };
  const dialog = new PrivateDialog({ terminal, requestRender() {} }, theme, () => {}, 'https://example.com',
    Array.from({ length: 12 }, (_, index) => ({ label: `Field ${index + 1}`, hidden: true, temporary: true })));
  for (let i = 0; i < 11; i++) dialog.handleInput('\t');
  for (const width of [24, 40, 80]) {
    const lines = dialog.render(width);
    assert.ok(lines.length <= 12); assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.join('\n').includes('Field 12/12')); assert.ok(lines.join('\n').includes(CURSOR_MARKER));
  }
  terminal.rows = 4;
  assert.ok(dialog.render(10).length <= 4); assert.equal(dialog.blocked, true);
  dialog.handleInput('not-captured'); dialog.handleInput('\r'); assert.equal(dialog.inputs[11].value, '');
  terminal.rows = 24; dialog.render(80); assert.equal(dialog.blocked, false);
  dialog.handleInput('private'); dialog.handleInput('\x1b'); assert.ok(dialog.inputs.every(input => !input.value));
});

test('review validates skipped fields and Cancel never saves or returns values', () => {
  let result = 'pending';
  const dialog = new PrivateDialog(tui, theme, value => { result = value; }, 'https://example.com', [{ label: 'Password', hidden: true }], true);
  dialog.handleInput('\t'); dialog.handleInput('\r'); assert.equal(dialog.index, 0); assert.match(dialog.error, /required/);
  dialog.handleInput('private'); dialog.handleInput('\r'); dialog.handleInput('\x1b[B'); dialog.handleInput('\r');
  assert.equal(result, undefined); assert.equal(dialog.remember, false); assert.equal(dialog.inputs[0].value, '');
});

test('approval menus use numbered choices, filtering and focused scrolling, and support abort', () => {
  let result;
  const menu = new PrivateChoice(tui, theme, value => { result = value; }, 'Approve saved fill\nhttps://example.com',
    Array.from({ length: 30 }, (_, index) => `Account ${index + 1}`));
  for (let i = 0; i < 29; i++) menu.handleInput('\x1b[B');
  let view = menu.render(40); assert.ok(view.join('\n').includes('30. Account 30'));
  assert.ok(view.join('\n').includes('Search:')); assert.ok(view.length <= 16); assert.ok(view.every(line => visibleWidth(line) <= 40));
  menu.handleInput('Account 17'); menu.render(40); menu.handleInput('\r'); assert.equal(result, 'Account 17'); assert.equal(menu.search.value, '');
  const controller = new AbortController();
  const other = new PrivateChoice(tui, theme, value => { result = value; }, 'Approve', ['Cancel', 'Confirm'], controller.signal);
  controller.abort(); assert.equal(result, undefined); assert.deepEqual(other.render(40), []);
});

test('custom private UI mounts inline, safely stacks over an existing overlay and stays TUI-only', async () => {
  const modes = [];
  const ctx = { mode: 'tui', ui: { custom(factory, options) {
    modes.push(options?.overlay ?? false);
    return new Promise(resolve => {
      const component = factory({ ...tui, hasOverlay: () => true }, theme, {}, resolve);
      if (component.inputs) { component.handleInput('synthetic-secret'); component.handleInput('\r'); component.handleInput('\r'); }
    });
  } } };
  const result = await privatePrompt(ctx, 'https://example.com', [{ label: 'Password', hidden: true }]);
  assert.deepEqual(modes, [false, true]); assert.deepEqual(result.values, ['synthetic-secret']);
  await assert.rejects(privateSelect({ mode: 'rpc' }, 'No RPC credentials', ['Cancel']), /interactive Pi TUI/);
  const choices = { mode: 'tui', ui: { custom(factory, options) { assert.equal(options, undefined); return new Promise(resolve => {
    const menu = factory({ ...tui, hasOverlay: () => false }, theme, {}, resolve); menu.handleInput('\r');
  }); } } };
  assert.equal(await privateConfirm(choices, 'Delete?', 'Cannot undo'), false, 'destructive confirmations default to Cancel');
});
