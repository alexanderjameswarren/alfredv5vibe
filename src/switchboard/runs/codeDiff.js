// sb3_pages-h6v A6: inline diffs for the code review page (spec 3.2 f). jsdiff (`diff`, pinned 5.2.0) finds the
// changes; this file turns them into numbered rows and hunks that CodeReviewPage draws itself. Pure functions only.
import { diffLines } from 'diff';

/** Context lines kept around each change in the compact view. */
export const CONTEXT = 3;

const splitLines = (text) => {
  const lines = String(text ?? '').split('\n');
  // A final newline doesn't make an empty last line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * Every line of a file as a row: { type: 'same' | 'add' | 'del', oldNo, newNo, text }. A new file is all added; a
 * deleted file is all removed. Line numbers start at 1; an added row has no oldNo, a removed row no newNo.
 */
export function diffRows(file) {
  const status = file?.status;
  if (status === 'new') return splitLines(file.new_text).map((text, i) => ({ type: 'add', oldNo: null, newNo: i + 1, text }));
  if (status === 'deleted') return splitLines(file.old_text).map((text, i) => ({ type: 'del', oldNo: i + 1, newNo: null, text }));
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  // Both sides end in a newline, so a missing final newline never shows the last line as changed.
  const withEnd = (t) => { const s = String(t ?? ''); return s === '' || s.endsWith('\n') ? s : `${s}\n`; };
  for (const part of diffLines(withEnd(file?.old_text), withEnd(file?.new_text))) {
    for (const text of splitLines(part.value)) {
      if (part.added) rows.push({ type: 'add', oldNo: null, newNo: newNo++, text });
      else if (part.removed) rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text });
      else rows.push({ type: 'same', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return rows;
}

/**
 * The compact view: each run of changes with up to `context` unchanged lines either side, as
 * [{ rows, hiddenBefore }]; hiddenBefore counts the unchanged lines skipped before the hunk.
 */
export function hunks(rows, context = CONTEXT) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.type === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j += 1) keep[j] = true;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (!keep[i]) { skipped += 1; return; }
    if (!out.length || !keep[i - 1]) out.push({ rows: [], hiddenBefore: skipped, hiddenAfter: 0 });
    skipped = 0;
    out[out.length - 1].rows.push(row);
  });
  // The unchanged lines after the last change.
  if (out.length) out[out.length - 1].hiddenAfter = skipped;
  return out;
}

/**
 * The new file's line numbers that changed: added lines, and for a removal the new line it sits before (so a note
 * can explain a deletion). Empty for a deleted file.
 */
export function changedLines(file) {
  const rows = diffRows(file);
  const set = new Set();
  const lastNew = [...rows].reverse().find((r) => r.newNo !== null)?.newNo ?? null;
  rows.forEach((row, i) => {
    if (row.type === 'add') set.add(row.newNo);
    if (row.type === 'del') {
      // A removal counts on the new line after it; one at the very end, on the file's last line.
      const next = rows.slice(i + 1).find((r) => r.newNo !== null);
      if (next) set.add(next.newNo);
      else if (lastNew !== null) set.add(lastNew);
    }
  });
  return set;
}

/**
 * Where a note goes: the row index it sits directly above. That is the first row of the change it explains, so for a
 * replaced or deleted line it steps back over the removed rows just before its start line. -1 when the line isn't drawn.
 */
export function noteAnchor(rows, note) {
  let i = rows.findIndex((r) => r.newNo === note.start_line);
  if (i < 0) return -1;
  // A trailing removal anchors on the last line, after it: put the note above the removals instead.
  const after = rows.slice(i + 1);
  if (after.length && after.every((r) => r.type === 'del')) return i + 1;
  while (i > 0 && rows[i - 1].type === 'del') i -= 1;
  return i;
}

/** Does every line from start to end sit on a changed line? A note must sit on the change it explains. */
export function noteOnChange(file, note) {
  const changed = changedLines(file);
  for (let n = note.start_line; n <= note.end_line; n += 1) if (!changed.has(n)) return false;
  return true;
}
