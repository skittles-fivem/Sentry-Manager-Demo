'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { patchStatus, FIND } = require('../demo/noFootageDays');

test('only the no-footage-days warning is dropped; a script without it is left as it is', () => {
  const src = `a\n${FIND}\n      title: 'x' });\nb`;
  const out = patchStatus(src);
  assert.ok(!out.includes(FIND) && out.includes('if (false && missing.length)'));
  assert.ok(out.startsWith('a\n') && out.endsWith('\nb'));
  assert.equal(patchStatus('other'), 'other');
});
