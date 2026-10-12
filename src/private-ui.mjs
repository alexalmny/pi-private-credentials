import { CURSOR_MARKER, renderFakeCursor, matchesKey, decodeKittyPrintable, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Pi's Input has no masked mode. Keep secret text out of every render path.
export class MaskedInput {
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
    const length = [...segments.segment(this.value)].length;
    const start = Math.max(0, this.cursor - Math.max(0, width - 1));
    const before = '*'.repeat(Math.max(0, this.cursor - start));
    const after = '*'.repeat(Math.max(0, Math.min(length - this.cursor - 1, width - before.length - 1)));
    return truncateToWidth(before + (this.focused ? CURSOR_MARKER + renderFakeCursor(this.cursor < length ? '*' : ' ') : (this.cursor < length ? '*' : ' ')) + after, width, '');
  }
}

export class PrivateDialog {
  focused = true;
  index = 0;
  remember = false;
  error = '';
  finished = false;
  constructor(tui, theme, done, title, labels, allowRemember = false, signal) {
    Object.assign(this, { tui, theme, done, title, labels, allowRemember, signal });
    this.inputs = labels.map(() => new MaskedInput());
    this.abort = () => this.finish(undefined);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) queueMicrotask(this.abort);
  }
  finish(result) {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(result);
  }
  handleInput(data) {
    if (this.finished) return;
    const input = this.inputs[this.index];
    if ((input && input.paste !== null) || data.includes('\x1b[200~')) {
      input?.handleInput(data);
    } else if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.finish(undefined);
    else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const count = this.inputs.length + (this.allowRemember ? 1 : 0);
      this.index = (this.index + (matchesKey(data, 'tab') ? 1 : count - 1)) % count;
    } else if (!input && matchesKey(data, 'space')) this.remember = !this.remember;
    else if (matchesKey(data, 'return')) {
      if (!this.inputs.at(-1).value) this.error = 'A password is required.';
      else this.finish({ values: this.inputs.map(field => field.value), remember: this.remember });
    } else input?.handleInput(data);
    this.tui.requestRender();
  }
  render(width) {
    const lines = [this.theme.fg('accent', 'Private credentials'), ...this.title.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))), ''];
    this.inputs.forEach((input, index) => {
      input.focused = this.focused && this.index === index;
      lines.push(this.labels[index]);
      lines.push(input.render(Math.max(1, width)));
    });
    if (this.allowRemember) lines.push(`${this.index === this.inputs.length ? '> ' : '  '}[${this.remember ? 'x' : ' '}] Remember in encrypted vault`);
    lines.push('', 'Tab: next  Space: toggle  Enter: fill/confirm', 'Esc: cancel  Ctrl+U: clear current field', this.error);
    return lines.map(line => truncateToWidth(line, width, ''));
  }
  invalidate() {}
  dispose() {
    this.signal?.removeEventListener('abort', this.abort);
    this.inputs.forEach(input => input.clear());
  }
}

export async function privatePrompt(ctx, title, labels, allowRemember = false, signal) {
  if (ctx.mode !== 'tui') throw new Error('Private credential entry requires interactive Pi TUI. Never enter credentials in chat or RPC dialogs.');
  return ctx.ui.custom((tui, theme, _keys, done) => new PrivateDialog(tui, theme, done, title, labels, allowRemember, signal),
    { overlay: true, overlayOptions: { anchor: 'center', width: '90%', maxHeight: '90%' } });
}
