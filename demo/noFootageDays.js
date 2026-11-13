'use strict';

// Sentry Six's Overview warns "No footage on N recent days" for every day since
// the oldest footage with none on the share. The demo's drives keep their real
// dates (the owner's choice), so that count grows by one every day for nothing.
// The demo serves Sentry Six's status script without that one warning; the
// empty days still show on the strip. A script whose line differs is left as it is.

const FIND = '  if (missing.length)\n    out.push({\n      kind: \'missing\',';
const WITH = '  if (false && missing.length)\n    out.push({\n      kind: \'missing\',';
const PATH = /\/s6\/status\.js$/;

/** The status script without the no-footage-days warning; as it is when the line is not there. */
function patchStatus(src) {
  const s = String(src);
  return s.includes(FIND) ? s.replace(FIND, WITH) : s;
}

module.exports = { patchStatus, PATH, FIND };
