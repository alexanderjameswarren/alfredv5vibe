// Splice src/sam/lib/noteDuplicates.js into the browser-console repair tool.
//
// scripts/sam-repair-duplicates.js has to be a single paste-able file — it runs
// in the DevTools console on the app's origin, where there is no module loader
// and no bundler. It still must use the SAME duplicate-pitch predicate as the
// parser and the three write paths, not a restatement of it. So the module's
// source is copied in mechanically, between markers, and a parity test
// (src/sam/lib/repairDuplicates.test.js) fails if the two ever disagree.
//
// Same shape as the two copy mechanisms already in the repo: prebuild.js for
// the JSON Schema, `npm run sync` for tools/sam-tools/vendor.
//
//   node scripts/inline-note-duplicates.js
//
// Run it after any edit to noteDuplicates.js. The parity test will tell you if
// you forget.

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'src', 'sam', 'lib', 'noteDuplicates.js');
const TARGET = path.join(__dirname, 'sam-repair-duplicates.js');

const BEGIN = '  // ==== BEGIN INLINED noteDuplicates.js — generated, do not edit ====';
const END = '  // ==== END INLINED noteDuplicates.js ====';

/**
 * ESM -> plain statements. The console has no module system, so the `export`
 * keywords come off; nothing else about the source is touched, which is what
 * makes the parity check a straight comparison rather than a judgement call.
 */
function toPlainStatements(src) {
  return src.replace(/^export /gm, '');
}

/** Indent by two spaces to sit inside the tool's IIFE. Blank lines stay blank. */
function indent(src) {
  return src
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : '  ' + l))
    .join('\n');
}

function build() {
  const module_ = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  return indent(toPlainStatements(module_)).trimEnd();
}

function main() {
  const target = fs.readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n');
  const start = target.indexOf(BEGIN);
  const end = target.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    console.error(
      `[inline-note-duplicates] Could not find the marker pair in ${TARGET}.\n` +
        `Expected these two lines:\n${BEGIN}\n${END}`
    );
    process.exit(1);
  }
  const next =
    target.slice(0, start + BEGIN.length) +
    '\n' +
    build() +
    '\n' +
    target.slice(end);
  fs.writeFileSync(TARGET, next);
  console.log(`[inline-note-duplicates] ${path.basename(TARGET)} updated from ${path.basename(SOURCE)}.`);
}

module.exports = { build, BEGIN, END, SOURCE, TARGET };

if (require.main === module) main();
