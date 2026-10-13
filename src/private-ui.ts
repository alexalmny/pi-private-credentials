import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, renderFakeCursor, matchesKey, decodeKittyPrintable, truncateToWidth, wrapTextWithAnsi, visibleWidth, sliceByColumn, SelectList } from '@earendil-works/pi-tui';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Pi's Input has no masked mode and retains undo history; private fields use neither undo nor a kill ring.
export class MaskedInput {
  constructor(hidden = true) { this.hidden = hidden; }
  value = '';
  cursor = 0;
  focused = false;
  paste = null;
  handleInput(data) {
    if (data.includes('\x1b[200~')) { this.paste = ''; data = data.replace('\x1b[200~', ''); }
    if (this.paste !== null) {
      this.paste += data;
      const end = this.paste.indexOf('\x1b[201~');
      if (end < 0) return;
      const text = this.paste.slice(0, end);
      this.paste = null;
      // Do not silently alter a pasted credential or interpret trailing paste bytes as Submit.
      if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) this.insert(text);
      return;
    }
    const parts = [...segments.segment(this.value)].map(part => part.segment);
    if (matchesKey(data, 'left')) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, 'right')) this.cursor = Math.min(parts.length, this.cursor + 1);
    else if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a')) this.cursor = 0;
    else if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+e')) this.cursor = parts.length;
    else if (matchesKey(data, 'ctrl+u')) { this.value = ''; this.cursor = 0; }
    else if (matchesKey(data, 'backspace')) {
      if (this.cursor) { parts.splice(--this.cursor, 1); this.value = parts.join(''); }
    } else if (matchesKey(data, 'delete')) { parts.splice(this.cursor, 1); this.value = parts.join(''); }
    else {
      const printable = decodeKittyPrintable(data) ?? data;
      if (!/[\x00-\x1f\x7f-\x9f]/.test(printable)) this.insert(printable);
    }
  }
  insert(text) {
    if (this.value.length + text.length > 65536) return;
    const parts = [...segments.segment(this.value)].map(part => part.segment);
    const before = parts.slice(0, this.cursor).join('') + text;
    this.value = before + parts.slice(this.cursor).join('');
    this.cursor = [...segments.segment(before)].length;
  }
  clear() { this.value = ''; this.cursor = 0; this.paste = null; }
  render(width) {
    if (!this.hidden) {
      const parts = [...segments.segment(this.value)].map(part => part.segment);
      let start = this.cursor; let used = 0;
      while (start > 0 && used + visibleWidth(parts[start - 1]) <= Math.max(0, width - 2)) used += visibleWidth(parts[--start]);
      const current = parts[this.cursor] ?? ' ';
      return truncateToWidth(parts.slice(start, this.cursor).join('') +
        (this.focused ? CURSOR_MARKER + renderFakeCursor(current) : current) + parts.slice(this.cursor + 1).join(''), width, '');
    }
    const length = [...segments.segment(this.value)].length;
    const start = Math.max(0, this.cursor - Math.max(0, width - 1));
    const before = '*'.repeat(Math.max(0, this.cursor - start));
    const after = '*'.repeat(Math.max(0, Math.min(length - this.cursor - 1, width - before.length - 1)));
    return truncateToWidth(before + (this.focused ? CURSOR_MARKER + renderFakeCursor(this.cursor < length ? '*' : ' ') : (this.cursor < length ? '*' : ' ')) + after, width, '');
  }
}

function panel(tui, theme, width, title, body, focusRow, hint, overlay = false, error = '', pinned = []) {
  const rows = Math.max(1, tui.terminal?.rows ?? 40);
  const allocated = tui.terminal?.[Symbol.for('rpiv-ask-user-question:host-allocated-rows')];
  const budget = overlay ? Math.max(1, Math.floor(rows * 0.9)) : allocated ? rows : Math.min(rows, Math.max(12, Math.floor(rows * 0.7)));
  const border = new DynamicBorder(text => theme.fg('accent', text)).render(width);
  const context = title.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 4)));
  const header = [...border, ` ${theme.bg('selectedBg', theme.fg('text', ' Private credentials '))}`,
    ...context.map((line, index) => ` ${theme.fg('dim', index === context.length - 1 ? '└─' : '├─')} ${theme.fg(index ? 'muted' : 'text', line)}`), ...pinned];
  const footer = [...(error ? [` ${theme.fg('error', error)}`] : []), ...border, ` ${theme.fg('dim', hint)}`];
  const available = budget - header.length - footer.length;
  const blocked = available < 3;
  if (blocked) return { blocked, lines: [...border, theme.fg('warning', 'Resize terminal to show the private form safely.'), ...border,
    theme.fg('dim', 'Esc cancel')].slice(0, budget).map(line => truncateToWidth(line, width, '')) };
  const start = Math.max(0, Math.min(focusRow - available + 1, body.length - available));
  return { blocked, lines: [...header, ...body.slice(start, start + available), ...footer].map(line => truncateToWidth(line, width, '')) };
}

export class PrivateDialog {
  focused = true;
  index = 0;
  remember = false;
  error = '';
  finished = false;
  blocked = false;
  constructor(tui, theme, done, title, labels, allowRemember = false, signal, action = 'Fill fields', overlay = false) {
    Object.assign(this, { tui, theme, done, title, allowRemember, signal, action, overlay });
    this.fields = labels.map((field, index) => typeof field === 'string' ?
      { label: field, hidden: true, required: index === labels.length - 1 } : { ...field, required: field.required ?? true });
    this.labels = this.fields.map(field => field.label);
    this.inputs = this.fields.map(field => new MaskedInput(field.hidden));
    this.reviewIndex = allowRemember ? 1 : 0;
    this.abort = () => this.finish(undefined);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) queueMicrotask(this.abort);
  }
  finish(result) {
    if (this.finished) return;
    this.dispose();
    this.done(result);
  }
  handleInput(data) {
    if (this.finished) return;
    const input = this.inputs[this.index];
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.finish(undefined);
    else if (this.blocked) return;
    else if ((input && input.paste !== null) || data.includes('\x1b[200~')) input?.handleInput(data);
    else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const count = this.inputs.length + 1;
      this.index = (this.index + (matchesKey(data, 'tab') ? 1 : count - 1)) % count;
      this.error = '';
    } else if (!input && (matchesKey(data, 'up') || matchesKey(data, 'down'))) {
      const count = this.allowRemember ? 3 : 2;
      this.reviewIndex = (this.reviewIndex + (matchesKey(data, 'down') ? 1 : count - 1)) % count;
    } else if (!input && this.allowRemember && this.reviewIndex === 0 && matchesKey(data, 'space')) this.remember = !this.remember;
    else if (matchesKey(data, 'return')) {
      const empty = input ? (this.fields[this.index].required && !input.value ? this.index : -1) :
        this.inputs.findIndex((field, index) => this.fields[index].required && !field.value);
      if (!input && this.reviewIndex === (this.allowRemember ? 2 : 1)) this.finish(undefined);
      else if (empty >= 0) { this.index = empty; this.error = `${this.labels[empty]} is required.`; }
      else if (input) { this.index++; this.error = ''; }
      else if (this.allowRemember && this.reviewIndex === 0) this.reviewIndex = 1;
      else this.finish({ values: this.inputs.map(field => field.value), remember: this.remember });
    } else if (input) { input.handleInput(data); this.error = ''; }
    this.tui.requestRender();
  }
  render(width) {
    if (this.finished) return [];
    const theme = this.theme;
    this.inputs.forEach((input, index) => { input.focused = this.focused && this.index === index; });
    const chips = [...this.fields.map((field, index) => {
      const label = ` ${this.inputs[index].value ? '■' : '□'} ${truncateToWidth(field.label, 20, '…')} `;
      return this.index === index ? theme.bg('selectedBg', theme.fg('text', label)) : theme.fg(this.inputs[index].value ? 'success' : 'muted', label);
    }), this.index === this.inputs.length ? theme.bg('selectedBg', theme.fg('text', ' ✓ Review ')) : theme.fg('dim', ' ✓ Review ')];
    let start = 0;
    while (start < this.index && visibleWidth(chips.slice(start, this.index + 1).join(' ')) > Math.max(1, width - 3)) start++;
    const tabs = `${start ? ' ← ' : ' '}${chips.slice(start).join(' ')}`;
    const body = [];
    let focusRow;
    let hint;
    const input = this.inputs[this.index];
    if (input) {
      const field = this.fields[this.index];
      body.push('', ` ${theme.fg('accent', `Field ${this.index + 1}/${this.inputs.length}`)} ${theme.bold(field.label)}`,
        ` ${theme.fg('dim', `${field.hidden ? 'Masked' : 'Visible locally'} · ${field.temporary ? 'temporary, never saved' : this.allowRemember ? 'saved only with Remember' : 'not saved'}`)}`,
        ` ${theme.fg('accent', '❯')} ${input.render(Math.max(1, width - 3))}`);
      focusRow = body.length - 1;
      hint = 'Enter next · Tab / Shift+Tab switch · Esc cancel · Ctrl+U clear';
    } else {
      body.push('', ` ${theme.fg('accent', `● Review (${this.inputs.filter(input => input.value).length}/${this.inputs.length})`)}`);
      this.fields.forEach((field, index) => body.push(` ${theme.fg('dim', index === this.fields.length - 1 ? '└─' : '├─')} ${theme.fg(this.inputs[index].value ? 'success' : 'warning', this.inputs[index].value ? '■' : '□')} ${field.label} ${theme.fg('dim', field.temporary ? '(temporary)' : '')}`));
      body.push('');
      const choices = [...(this.allowRemember ? [`${this.remember ? '■' : '□'} Remember eligible fields in encrypted vault`] : []), `✓ ${this.action}`, 'Cancel'];
      choices.forEach((label, index) => body.push(index === this.reviewIndex ? theme.fg('accent', theme.bold(` ❯ ${label}`)) : `   ${label}`));
      focusRow = body.length - choices.length + this.reviewIndex;
      hint = `Enter confirm · ↑/↓ choose${this.allowRemember ? ' · Space toggle' : ''} · Tab review · Esc cancel`;
    }
    const view = panel(this.tui, theme, width, this.title, body, focusRow, hint, this.overlay, this.error, [tabs]);
    this.blocked = view.blocked;
    return view.lines;
  }
  invalidate() {}
  dispose() {
    this.finished = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.inputs.forEach(input => { input.focused = false; input.clear(); });
  }
}

export class PrivateChoice {
  focused = true;
  finished = false;
  blocked = false;
  constructor(tui, theme, done, title, choices, signal, overlay = false) {
    Object.assign(this, { tui, theme, done, title, signal, overlay });
    this.search = new MaskedInput(false);
    this.list = new SelectList(choices.map((label, index) => ({ value: label, label: /^\d+\. /.test(label) ? label : `${index + 1}. ${label}` })), 10, {
      selectedPrefix: text => theme.fg('accent', text.replace('→', '❯')),
      selectedText: text => theme.fg('accent', theme.bold(text.replace(/^→ /, '❯ '))),
      description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text), noMatch: text => theme.fg('warning', text),
    });
    this.list.onSelect = item => this.finish(item.value);
    this.list.onCancel = () => this.finish(undefined);
    this.abort = () => this.finish(undefined);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) queueMicrotask(this.abort);
  }
  finish(result) { if (!this.finished) { this.dispose(); this.done(result); } }
  handleInput(data) {
    if (this.finished) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.finish(undefined);
    else if (this.blocked) return;
    else if (this.search.paste !== null || data.includes('\x1b[200~')) { this.search.handleInput(data); this.list.setFilter(this.search.value); }
    else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) this.list.handleInput(matchesKey(data, 'tab') ? '\x1b[B' : '\x1b[A');
    else if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'return')) this.list.handleInput(data);
    else { this.search.handleInput(data); this.list.setFilter(this.search.value); }
    this.tui.requestRender();
  }
  render(width) {
    if (this.finished) return [];
    this.search.focused = this.focused;
    const lines = this.list.render(Math.max(1, width - 1)).map(line => ` ${line}`);
    const selected = lines.findIndex(line => sliceByColumn(line, 0, 3).includes('❯'));
    const search = ` ${this.theme.fg('dim', 'Search:')} ${this.search.render(Math.max(1, width - 9))}`;
    const body = ['', ...lines];
    const view = panel(this.tui, this.theme, width, this.title, body, Math.max(0, selected) + 1, 'Enter select · ↑/↓ choose · Type to filter · Esc cancel', this.overlay, '', [search]);
    this.blocked = view.blocked;
    return view.lines;
  }
  invalidate() { this.list.invalidate(); }
  dispose() { this.finished = true; this.signal?.removeEventListener('abort', this.abort); this.search.clear(); }
}

const NEED_OVERLAY = Symbol('private-entry-needs-overlay');
async function mountPrivate(ctx, factory) {
  if (ctx.mode !== 'tui') throw new Error('Private credential entry requires interactive Pi TUI. Never enter credentials in chat or RPC dialogs.');
  const mount = overlay => ctx.ui.custom((tui, theme, _keys, done) => {
    // Never give an invisible inline form keyboard focus underneath another overlay.
    if (!overlay && tui.hasOverlay?.()) {
      queueMicrotask(() => done(NEED_OVERLAY));
      return { render: () => [], invalidate() {} };
    }
    return factory(tui, theme, done, overlay);
  }, overlay ? { overlay: true, overlayOptions: { anchor: 'center', width: '90%', maxHeight: '90%' } } : undefined);
  const result = await mount(false);
  return result === NEED_OVERLAY ? mount(true) : result;
}

export function privatePrompt(ctx, title, labels, allowRemember = false, signal, action = 'Fill fields') {
  return mountPrivate(ctx, (tui, theme, done, overlay) => new PrivateDialog(tui, theme, done, title, labels, allowRemember, signal, action, overlay));
}

export function privateSelect(ctx, title, choices, options = {}) {
  return mountPrivate(ctx, (tui, theme, done, overlay) => new PrivateChoice(tui, theme, done, title, choices, options.signal, overlay));
}

export async function privateConfirm(ctx, title, message) {
  return await privateSelect(ctx, `${title}\n${message}`, ['Cancel', 'Confirm']) === 'Confirm';
}
