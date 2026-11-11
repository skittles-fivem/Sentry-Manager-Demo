'use strict';

// Horizon's Encoder speed dial (its tachometer) tops out at fixed steps, the
// highest 3,840 fps, so a fast setup pinned the needle. The demo serves
// Horizon's encoder page with one line changed: up to about 1,000 fps the dial
// keeps its steps; past that its top is the fastest speed seen plus 1,000 to
// 2,000 fps (rounded up to a thousand), so the needle never reaches the end.
// Until the manager does this itself; a manager whose line differs is left as
// it is.

const FIND = 'const want = TACH.find((x) => x >= Math.max(fps, peak) * 1.15) || TACH[TACH.length - 1];';
const WITH = 'const top = Math.max(fps, peak); const want = top * 1.15 <= 960 ? (TACH.find((x) => x >= top * 1.15) || 960) : Math.ceil((top + 1000) / 1000) * 1000;';
const PATH = /\/hz\/pages\/encoder\.js$/;

/** The dial's top for a speed and the fastest seen, as the changed line works it out. */
function tachTop(fps, peak, TACH = [60, 120, 240, 480, 960, 1920, 3840]) {
  const top = Math.max(fps, peak);
  return top * 1.15 <= 960 ? (TACH.find((x) => x >= top * 1.15) || 960) : Math.ceil((top + 1000) / 1000) * 1000;
}

/** Horizon's encoder page with the dial's line changed; the source as it is when the line is not there. */
function patchEncoderPage(src) {
  const s = String(src);
  return s.includes(FIND) ? s.replace(FIND, WITH) : s;
}

module.exports = { tachTop, patchEncoderPage, PATH, FIND };
