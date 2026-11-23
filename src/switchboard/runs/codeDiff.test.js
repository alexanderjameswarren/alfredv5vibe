import { changedLines, diffRows, hunks, noteAnchor, noteOnChange } from './codeDiff';

const OLD = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n');
const NEW = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].join('\n');

describe('codeDiff', () => {
  test('rows are numbered on both sides; a changed line is a removal then an addition', () => {
    const rows = diffRows({ status: 'modified', old_text: OLD, new_text: NEW });
    expect(rows.filter((r) => r.type !== 'same').map((r) => [r.type, r.oldNo, r.newNo, r.text]))
      .toEqual([['del', 4, null, 'd'], ['add', null, 4, 'D'], ['add', null, 13, 'm']]);
  });

  test('a new file is all added, a deleted file all removed; a final newline adds no empty line', () => {
    expect(diffRows({ status: 'new', new_text: 'x\ny\n' }).map((r) => [r.type, r.newNo])).toEqual([['add', 1], ['add', 2]]);
    expect(diffRows({ status: 'deleted', old_text: 'x\n' }).map((r) => [r.type, r.oldNo])).toEqual([['del', 1]]);
  });

  test('hunks keep 3 lines of context and count what they skip', () => {
    const hk = hunks(diffRows({ status: 'modified', old_text: OLD, new_text: NEW }));
    expect(hk).toHaveLength(2);
    expect(hk[0].hiddenBefore).toBe(0);
    expect(hk[0].rows.map((r) => r.text)).toEqual(['a', 'b', 'c', 'd', 'D', 'e', 'f', 'g']);
    // h and i are more than 3 lines from either change.
    expect(hk[1].hiddenBefore).toBe(2);
    expect(hk[1].rows.map((r) => r.text)).toEqual(['j', 'k', 'l', 'm']);
  });

  test('changed lines, and a note must sit on them', () => {
    const file = { status: 'modified', old_text: OLD, new_text: NEW };
    expect([...changedLines(file)]).toEqual([4, 13]);
    expect(noteOnChange(file, { start_line: 4, end_line: 4 })).toBe(true);
    expect(noteOnChange(file, { start_line: 3, end_line: 4 })).toBe(false);
    // A removal counts on the new line it sits before.
    expect([...changedLines({ status: 'modified', old_text: 'a\nb\nc', new_text: 'a\nc' })]).toEqual([2]);
    // A removal at the very end counts on the last line.
    expect([...changedLines({ status: 'modified', old_text: 'a\nb\nc', new_text: 'a\nb' })]).toEqual([2]);
  });

  test('a note goes above the change: before its removed lines, never between removed and added', () => {
    const rows = diffRows({ status: 'modified', old_text: OLD, new_text: NEW });
    // Line 4 replaced: the note sits above the removed 'd'.
    expect(rows[noteAnchor(rows, { start_line: 4 })].text).toBe('d');
    // A pure deletion: the note sits above the removed line, not below it.
    const del = diffRows({ status: 'modified', old_text: 'a\nb\nc', new_text: 'a\nc' });
    expect(del[noteAnchor(del, { start_line: 2 })]).toMatchObject({ type: 'del', text: 'b' });
    // A deletion at the end: above the removed line, after the last kept one.
    const end = diffRows({ status: 'modified', old_text: 'a\nb\nc', new_text: 'a\nb' });
    expect(end[noteAnchor(end, { start_line: 2 })]).toMatchObject({ type: 'del', text: 'c' });
  });

  test('the last hunk counts the unchanged lines after it', () => {
    const hk = hunks(diffRows({ status: 'modified', old_text: 'a\nb\nc\nd\ne\nf\ng\nh', new_text: 'A\nb\nc\nd\ne\nf\ng\nh' }));
    expect(hk[hk.length - 1].hiddenAfter).toBe(4);
  });
});
