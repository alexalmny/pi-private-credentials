import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFields, savedFields } from '../src/fields.mjs';

const reusable = { label: 'Account ID', selector: '#account', hidden: false, temporary: false };

test('field definitions are explicit, bounded, uniquely named, and terminal-safe', () => {
  assert.deepEqual(validateFields([reusable]), [reusable]);
  for (const fields of [[], Array(13).fill(reusable), [reusable, reusable],
    [{ ...reusable, hidden: undefined }], [{ ...reusable, temporary: undefined }],
    [{ ...reusable, label: 'evil\x1b[31m' }], [{ ...reusable, selector: '' }],
    [reusable, { ...reusable, selector: '#other' }], [reusable, { ...reusable, label: 'Other' }]])
    assert.throws(() => validateFields(fields));
});

test('temporary values never reuse saved fields; match exact origin, label, selector, visibility', () => {
  const stored = { ...reusable, id: 'field', origin: 'https://example.com', value: 'account' };
  const data = { fields: [stored] };
  assert.equal(savedFields(data, stored.origin, [reusable])[0], stored);
  for (const changed of [{ ...reusable, temporary: true }, { ...reusable, label: 'OTP' },
    { ...reusable, selector: '#code' }, { ...reusable, hidden: true }])
    assert.equal(savedFields(data, stored.origin, [changed])[0], undefined);
  assert.equal(savedFields(data, 'https://other.example', [reusable])[0], undefined);
  assert.equal(savedFields({ accounts: [] }, stored.origin, [reusable])[0], undefined);
});
