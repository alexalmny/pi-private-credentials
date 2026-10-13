// shortcut: exact text/JSON/URL variants only, use isolated tools for hostile-agent protection.
export class Redactor {
  values = new Set();
  remember(secret) {
    if (!secret) return;
    for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])
      this.values.add(value);
  }
  clear() { this.values.clear(); }
  text(value) {
    for (const secret of [...this.values].sort((a, b) => b.length - a.length))
      value = value.split(secret).join('[credential redacted]');
    return value;
  }
  json(value) {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.json(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.text(key), this.json(item)]));
    return value;
  }
}

export function needsApproval(mode, approved, id) {
  return mode === 'ask' || (mode === 'session' && !approved.has(id)) || !['ask', 'session', 'yolo'].includes(mode);
}
