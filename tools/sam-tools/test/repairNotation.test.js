// bin/repair-notation.js — the repair plan, its SQL and its verification.

import test from "node:test";
import assert from "node:assert/strict";

const R = await import("../bin/repair-notation.js");

const note = (name, midi, extra = {}) => ({ midi, name, ...extra });
const ev = (duration, notes, extra = {}) => ({ duration, notes, voice: "1", ...extra });
const song = (measures, more = {}) => ({ id: "11111111-1111-1111-1111-111111111111", title: "T", passes: 3, snippets: 1, measures, fingerings: [], lyrics: [], ...more });
const row = (number, rh, lh = [ev("w", [])], printed = String(number)) => ({ number, source_measure: printed, rh, lh });
const play = (number, rh, lh = [ev("w", [])], printed = String(number)) => ({ number, sourceMeasure: printed, rh, lh });

const TREM_OLD = [ev("w", [note("C8", 108)], { tuplet: { actual: 2, normal: 1 } }), ev("w", [note("G7", 103)], { tuplet: { actual: 2, normal: 1 } })];
const TREM_NEW = [ev("h", [note("C8", 108, { tremolo: { type: "start", marks: 3 } })]), ev("h", [note("G7", 103, { tremolo: { type: "stop", marks: 3 } })])];

test("the export reads as bare JSON or as the SQL editor's CSV download", () => {
  const json = JSON.stringify({ songs: [{ id: "a", title: 'Say "hi"' }] });
  assert.equal(R.readExport(json).songs[0].title, 'Say "hi"');
  const csv = `result\n"${json.replace(/"/g, '""')}"\n`;
  assert.equal(R.readExport(csv).songs[0].title, 'Say "hi"');
  assert.equal(R.readExport(`﻿result\r\n"${json.replace(/"/g, '""')}"`).songs[0].id, "a");
});

test("an unchanged measure is not touched; voice and lyric are ignored", () => {
  const stored = song([row(1, [ev("q", [note("C5", 72)], { lyric: "la" })])]);
  const plan = R.planSong(stored, { measures: [play(1, [{ duration: "q", notes: [note("C5", 72)], voice: "2" }])] });
  assert.equal(plan.changes.length, 0);
});

test("a tremolo measure changes and is described plainly", () => {
  const plan = R.planSong(song([row(70, TREM_OLD, undefined, "69")]), { measures: [play(70, TREM_NEW, undefined, "69")] });
  assert.equal(plan.changes.length, 1);
  assert.match(plan.changes[0].what, /RH: tremolo w\(2:1\) w\(2:1\) → h h \(C8 G7\)/);
});

test("unscored and dropped notes are named", () => {
  const plan = R.planSong(
    song([row(1, [ev("q", [note("D8", 110)]), ev("q", [note("C#3", 49)])])]),
    { measures: [play(1, [ev("q", [note("D8", 110, { unscored: true })]), ev("q", [])])] }
  );
  assert.match(plan.changes[0].what, /C#3 dropped; D8 marked unscored/);
});

test("a song whose measure count or numbering changes is skipped", () => {
  assert.match(R.planSong(song([row(1, [])]), { measures: [play(1, []), play(2, [])] }).skip, /measure count 1 stored, 2 re-parsed/);
  assert.match(R.planSong(song([row(1, [], undefined, "0")]), { measures: [play(1, [], undefined, "1")] }).skip, /numbering differs/);
});

test("fingerings and lyrics follow the same note to its new rh_index", () => {
  // Old: four quarters (the nested-triplet fallback); new: the first three fold into one event.
  const oldRh = [ev("q", [note("Ab4", 68), note("C5", 72)]), ev("q", [note("A4", 69)]), ev("q", [note("Ab4", 68)]), ev("q", [note("F4", 65)])];
  const newRh = [ev("h", [note("Ab4", 68), note("C5", 72)]), ev("q", []), ev("q", [note("F4", 65)])];
  const stored = song([row(49, oldRh)], {
    fingerings: [
      { id: "f1", measure_num: 49, rh_index: 0, note_index: 1, finger: 3 }, // C5, stays
      { id: "f2", measure_num: 49, rh_index: 3, note_index: 0, finger: 1 }, // F4 at beat 4 → rh 2
      { id: "f3", measure_num: 49, rh_index: 1, note_index: 0, finger: 2 }, // A4 is gone
    ],
    lyrics: [{ id: "l1", measure_num: 49, rh_index: 3, syllable: "on" }],
  });
  const plan = R.planSong(stored, { measures: [play(49, newRh)] });
  assert.deepEqual(plan.fingerings.map((f) => [f.id, f.to]), [["f2", { rhIndex: 2, noteIndex: 0 }]]);
  assert.deepEqual(plan.lyrics.map((l) => [l.id, l.to]), [["l1", { rhIndex: 2 }]]);
  assert.deepEqual(plan.unmatched.map((u) => u.id), ["f3"]);
});

test("the SQL is one guarded transaction matched on the stored value", () => {
  const stored = song([row(70, TREM_OLD, undefined, "69"), row(71, [ev("w", [note("C5", 72)])])]);
  const plans = [{ song: stored, plan: R.planSong(stored, { measures: [play(70, TREM_NEW, undefined, "69"), play(71, [ev("w", [note("C5", 72)])])] }) }];
  const sql = R.repairSql(plans, "-- header");
  assert.match(sql, /^-- header\nbegin;\n\ndo \$repair\$/);
  assert.match(sql, /commit;\n$/);
  assert.equal((sql.match(/update public\.sam_song_measures/g) || []).length, 1);
  assert.match(sql, /and number = 70 and rh = \$j\$\[\{"duration":"w"/);
  assert.equal((sql.match(/if n <> 1 then raise exception/g) || []).length, 2); // measure + sam_songs
  assert.match(sql, /update public\.sam_songs set measures_edited_at = now\(\)/);
});

test("the verification is one read-only JSON query, and says when there is nothing to check", () => {
  const stored = song([row(70, TREM_OLD)]);
  const plans = [{ song: stored, plan: R.planSong(stored, { measures: [play(70, TREM_NEW)] }) }];
  const v = R.verifySql(plans, "-- h");
  assert.match(v, /select json_build_object\(/);
  assert.doesNotMatch(v, /\b(update|insert|delete)\b/i);
  assert.match(v, /'fingerings_not_moved'.*\(select null::uuid as id, null::int as rh_index, null::int as note_index where false\) v/s);
  assert.match(R.verifySql([], "-- h"), /'nothing_to_verify', true/);
});
