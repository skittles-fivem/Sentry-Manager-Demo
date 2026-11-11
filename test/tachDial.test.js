'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tachTop, patchEncoderPage, FIND } = require('../demo/tachDial');

test('the dial keeps its steps up to about 1,000 fps, then tops out 1,000 to 2,000 fps above the fastest seen', () => {
  assert.equal(tachTop(0, 0), 60);
  assert.equal(tachTop(400, 400), 480);
  assert.equal(tachTop(3802, 3802), 5000);
  assert.equal(tachTop(9850, 9850), 11000);
  assert.equal(tachTop(5000, 10400), 12000);
  for (let f = 900; f < 20000; f += 37) {
    const top = tachTop(f, f);
    assert.ok(top - f >= 1000 && top - f <= 2000, `${f} -> ${top}`);
  }
});

test('only the dial line changes; a page without it is left as it is', () => {
  const page = `a\n      ${FIND}\nb`;
  const out = patchEncoderPage(page);
  assert.notEqual(out, page);
  assert.ok(out.startsWith('a\n') && out.endsWith('\nb'));
  assert.ok(!out.includes(FIND));
  assert.equal(patchEncoderPage('other'), 'other');
});
