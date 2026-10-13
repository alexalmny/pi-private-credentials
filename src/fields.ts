export function validateFields(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 12) throw new Error('Request between 1 and 12 fields.');
  const labels = new Set(); const selectors = new Set();
  for (const field of fields) {
    if (!field || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120 ||
        /[\x00-\x1f\x7f-\x9f]/.test(field.label) || labels.has(field.label) ||
        typeof field.selector !== 'string' || !field.selector.trim() || field.selector.length > 2048 ||
        selectors.has(field.selector) || typeof field.hidden !== 'boolean' || typeof field.temporary !== 'boolean')
      throw new Error('Fields need unique labels/selectors and explicit hidden/temporary flags.');
    labels.add(field.label); selectors.add(field.selector);
  }
  return fields;
}

export function fieldKey(field) { return JSON.stringify([field.label, field.selector, field.hidden]); }

export function savedFields(data, origin, fields) {
  return fields.map(field => field.temporary ? undefined :
    (data.fields ?? []).find(saved => saved.origin === origin && fieldKey(saved) === fieldKey(field)));
}
