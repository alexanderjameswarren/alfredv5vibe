/* eslint-disable */
//
// SAM round-trip diff — paste into the BROWSER CONSOLE, on the tab where SAM
// is open and you are logged in.
//
//   1. Open the app (localhost:3000 or the deployed URL) and sign in.
//   2. Open DevTools → Console.
//   3. Paste this whole file.
//   4. Run:  samDiff("<source-song-id>", "<round-tripped-copy-id>")
//   5. Copy the printed output back.
//
// It needs no credentials: supabase-js persists the session in localStorage on
// this origin, so we borrow that access token and talk to PostgREST with plain
// fetch. Nothing is written — every request is a GET.
//
// It compares the two songs field by field and prints one PASS/FAIL line per
// check, then a final verdict. A FAIL line names the first few offending
// measures / syllables so you can go look at them.

(function () {
  const SUPABASE_URL = "https://zuqjyfqnvhddnchhpbcz.supabase.co";
  const ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo";

  function accessToken() {
    // supabase-js v2 key format: sb-<project-ref>-auth-token
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        const tok = v?.access_token || v?.currentSession?.access_token;
        if (tok) return tok;
      } catch (_) {}
    }
    throw new Error(
      "No Supabase session in localStorage. Sign in to SAM on this origin first."
    );
  }

  async function q(pathAndQuery) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${accessToken()}`,
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  // ---- reporting --------------------------------------------------------
  let pass = 0;
  let fail = 0;
  function check(label, ok, detail) {
    if (ok) {
      pass++;
      console.log(`%cPASS%c ${label}`, "color:#0a0;font-weight:bold", "");
    } else {
      fail++;
      console.log(
        `%cFAIL%c ${label}${detail ? "\n       " + detail : ""}`,
        "color:#c00;font-weight:bold",
        ""
      );
    }
  }

  // A check with nothing to compare is not a pass. When the source side is
  // empty (no lyrics, no fingerings) or every counterpart is missing, saying
  // PASS is a lie that reads as evidence — report SKIP and keep it out of the
  // pass tally.
  let skipped = 0;
  function checkOrSkip(label, comparedCount, ok, detail) {
    if (comparedCount === 0) {
      skipped++;
      console.log(
        `%cSKIP%c ${label} — nothing to compare`,
        "color:#b80;font-weight:bold",
        ""
      );
      return;
    }
    check(`${label} (compared ${comparedCount})`, ok, detail);
  }

  const j = (v) => JSON.stringify(v);

  // rh events can carry a STALE inline `lyric` in the stored JSONB on older
  // rows (recompileMeasures strips them on read for exactly this reason, and
  // the exporter strips them too). Comparing them would report a difference
  // that is not one, so normalise both sides before diffing.
  function stripLyric(events) {
    return (events || []).map((e) => {
      if (!e || typeof e !== "object" || !("lyric" in e)) return e;
      const { lyric, ...rest } = e;
      return rest;
    });
  }

  window.samDiff = async function samDiff(sourceId, copyId) {
    pass = 0;
    fail = 0;
    console.log(`\n=== SAM round-trip diff ===\n  source: ${sourceId}\n  copy:   ${copyId}\n`);

    const SONG_COLS =
      "id,title,artist,key_signature,time_signature,default_bpm,song_type,parent_song_id,difficulty_tier,source_xml_path";
    const MEASURE_COLS =
      "number,rh,lh,time_signature,audio_offset_ms,chord,section,source_measure";

    const [srcSong] = await q(`sam_songs?id=eq.${sourceId}&select=${SONG_COLS}`);
    const [cpySong] = await q(`sam_songs?id=eq.${copyId}&select=${SONG_COLS}`);
    if (!srcSong) throw new Error("source song not found (or not yours)");
    if (!cpySong) throw new Error("copy song not found (or not yours)");

    const srcM = await q(
      `sam_song_measures?song_id=eq.${sourceId}&select=${MEASURE_COLS}&order=number.asc`
    );
    const cpyM = await q(
      `sam_song_measures?song_id=eq.${copyId}&select=${MEASURE_COLS}&order=number.asc`
    );

    const srcL = await q(
      `sam_song_lyrics?song_id=eq.${sourceId}&select=word_order,syllable,measure_num,rh_index&order=word_order.asc`
    );
    const cpyL = await q(
      `sam_song_lyrics?song_id=eq.${copyId}&select=word_order,syllable,measure_num,rh_index&order=word_order.asc`
    );

    const FCOLS = "measure_num,rh_index,note_index,finger,source";
    const srcF = await q(
      `sam_song_fingerings?song_id=eq.${sourceId}&select=${FCOLS}&order=measure_num.asc&order=rh_index.asc`
    );
    const cpyF = await q(
      `sam_song_fingerings?song_id=eq.${copyId}&select=${FCOLS}&order=measure_num.asc&order=rh_index.asc`
    );

    // ---- song level ------------------------------------------------------
    // title is expected to differ (the copy is deliberately renamed).
    for (const col of [
      "artist", "key_signature", "time_signature", "default_bpm",
      "song_type", "parent_song_id", "difficulty_tier", "source_xml_path",
    ]) {
      check(
        `song.${col}`,
        j(srcSong[col] ?? null) === j(cpySong[col] ?? null),
        `source=${j(srcSong[col] ?? null)}  copy=${j(cpySong[col] ?? null)}`
      );
    }

    // ---- measure count ---------------------------------------------------
    check(
      `measure count (${srcM.length})`,
      srcM.length === cpyM.length,
      `source=${srcM.length}  copy=${cpyM.length}`
    );

    // ---- per-measure -----------------------------------------------------
    const n = Math.min(srcM.length, cpyM.length);
    const bad = { number: [], ts: [], rh: [], lh: [], offset: [], chord: [], section: [], src: [] };
    let nonNullOffsets = 0;

    for (let i = 0; i < n; i++) {
      const a = srcM[i];
      const b = cpyM[i];
      if (a.number !== b.number) bad.number.push(a.number);
      if (j(a.time_signature) !== j(b.time_signature)) bad.ts.push(a.number);
      if (j(stripLyric(a.rh)) !== j(stripLyric(b.rh))) bad.rh.push(a.number);
      if (j(stripLyric(a.lh)) !== j(stripLyric(b.lh))) bad.lh.push(a.number);
      // Strict: null must stay null, 0 must stay 0.
      if ((a.audio_offset_ms ?? null) !== (b.audio_offset_ms ?? null)) bad.offset.push(a.number);
      if (a.audio_offset_ms !== null && a.audio_offset_ms !== undefined) nonNullOffsets++;
      if ((a.chord ?? null) !== (b.chord ?? null)) bad.chord.push(a.number);
      if ((a.section ?? null) !== (b.section ?? null)) bad.section.push(a.number);
      if ((a.source_measure ?? null) !== (b.source_measure ?? null)) bad.src.push(a.number);
    }

    const preview = (arr) =>
      `${arr.length} differing at m${arr.slice(0, 8).join(", m")}${arr.length > 8 ? ", …" : ""}`;

    check("every measure number", bad.number.length === 0, preview(bad.number));
    check("every time_signature (incl. common/cut symbol)", bad.ts.length === 0, preview(bad.ts));
    check("every rh event (pitches + durations + ties + tuplets)", bad.rh.length === 0, preview(bad.rh));
    check("every lh event (pitches + durations + ties + tuplets)", bad.lh.length === 0, preview(bad.lh));
    check(
      `every audio_offset_ms (${nonNullOffsets} non-null of ${n})`,
      bad.offset.length === 0,
      preview(bad.offset)
    );
    check("every chord", bad.chord.length === 0, preview(bad.chord));
    check("every section", bad.section.length === 0, preview(bad.section));
    check("every source_measure", bad.src.length === 0, preview(bad.src));

    // ---- lyrics ----------------------------------------------------------
    check(
      `lyric count (${srcL.length})`,
      srcL.length === cpyL.length,
      `source=${srcL.length}  copy=${cpyL.length}`
    );

    const cpyByWO = new Map(cpyL.map((l) => [l.word_order, l]));
    const lyricBad = { missing: [], syllable: [], placement: [] };
    let lyricsCompared = 0;
    for (const s of srcL) {
      const c = cpyByWO.get(s.word_order);
      if (!c) {
        // word_order was regenerated rather than carried — the exact failure
        // mode this check exists for.
        lyricBad.missing.push(s.word_order);
        continue;
      }
      lyricsCompared++;
      if (s.syllable !== c.syllable) lyricBad.syllable.push(s.word_order);
      if ((s.measure_num ?? null) !== (c.measure_num ?? null) ||
          (s.rh_index ?? null) !== (c.rh_index ?? null)) {
        lyricBad.placement.push(s.word_order);
      }
    }
    checkOrSkip("every word_order carried verbatim", srcL.length,
      lyricBad.missing.length === 0, preview(lyricBad.missing));
    // These two can only speak for syllables that were actually found. Without
    // the guard they reported PASS on a copy with zero lyrics.
    checkOrSkip("every syllable text", lyricsCompared,
      lyricBad.syllable.length === 0, preview(lyricBad.syllable));
    checkOrSkip("every measure_num + rh_index", lyricsCompared,
      lyricBad.placement.length === 0, preview(lyricBad.placement));

    // ---- fingerings ------------------------------------------------------
    const fkey = (f) => `${f.measure_num}:${f.rh_index}:${f.note_index}:${f.source}`;
    const cpyByF = new Map(cpyF.map((f) => [fkey(f), f]));
    const fBad = [];
    for (const s of srcF) {
      const c = cpyByF.get(fkey(s));
      if (!c || c.finger !== s.finger) fBad.push(fkey(s));
    }
    check(
      `fingering count (${srcF.length})`,
      srcF.length === cpyF.length,
      `source=${srcF.length}  copy=${cpyF.length}`
    );
    checkOrSkip("every fingering coordinate, finger and source", srcF.length,
      fBad.length === 0, `${fBad.length} differing: ${fBad.slice(0, 8).join(", ")}`);

    console.log(
      `\n=== ${fail === 0 ? "ALL CHECKS PASSED" : "DIFFERENCES FOUND"} — ` +
        `${pass} passed, ${fail} failed, ${skipped} skipped ===\n`
    );

    // Wrong-pair detector. If the measure counts differ AND every single
    // measure's notation differs, these are almost certainly two different
    // songs rather than a song and its round-tripped copy — which is a much
    // more likely mistake than the format losing everything at once.
    if (srcM.length !== cpyM.length && bad.rh.length === n && n > 0) {
      console.warn(
        `⚠ These do not look like a source/copy pair: ${srcM.length} vs ` +
          `${cpyM.length} measures and every measure's notation differs.\n` +
          `  source_xml_path — source: ${srcSong.source_xml_path}\n` +
          `                  copy:   ${cpySong.source_xml_path}\n` +
          `  Re-check the ids with samList(). A round-tripped copy inherits ` +
          `its source's source_xml_path, so a mismatch there names the real parent.`
      );
    }
    return { pass, fail, skipped };
  };

  // The UI never shows a song's UUID, and samDiff needs two of them. This
  // prints every song whose title matches, newest first, so you can copy the
  // id of the copy you just imported.
  window.samList = async function samList(titleContains) {
    const rows = await q(
      `sam_songs?title=ilike.*${encodeURIComponent(titleContains)}*` +
        `&select=id,title,created_at,song_type&order=created_at.desc`
    );
    console.table(rows);
    return rows;
  };

  // Safe deletion of a throwaway round-trip copy.
  //
  // Dry-run by default — it reports what references the song and deletes
  // nothing. Pass {apply: true} to actually remove it.
  //
  // The reference check is not decoration. sam_sessions.song_id is the one
  // child FK with NO `ON DELETE` clause, so it defaults to NO ACTION: if you
  // pressed play on the copy even once, the DELETE fails with a foreign-key
  // violation. Everything else (measures, lyrics, fingerings, snippets)
  // cascades, and sam_songs.parent_song_id is ON DELETE SET NULL — so a child
  // song is NOT deleted with its parent, it is silently orphaned into a root.
  // That last one is why we look before deleting.
  window.samSafeDelete = async function samSafeDelete(songId, opts = {}) {
    const [song] = await q(`sam_songs?id=eq.${songId}&select=id,title,song_type`);
    if (!song) {
      console.log(`%cnot found%c ${songId} — already gone, or not yours`, "color:#b80", "");
      return { deleted: false, reason: "not-found" };
    }
    console.log(`\n=== samSafeDelete: "${song.title}" (${song.song_type}) ===`);

    const count = async (table, filter) =>
      (await q(`${table}?${filter}&select=id`)).length;

    const blockers = {
      // NO ACTION — these BLOCK the delete.
      sam_sessions: await count("sam_sessions", `song_id=eq.${songId}`),
      // SET NULL — these survive, orphaned as roots.
      child_songs: await count("sam_songs", `parent_song_id=eq.${songId}`),
    };
    const cascades = {
      sam_song_measures: await count("sam_song_measures", `song_id=eq.${songId}`),
      sam_song_lyrics: await count("sam_song_lyrics", `song_id=eq.${songId}`),
      sam_song_fingerings: await count("sam_song_fingerings", `song_id=eq.${songId}`),
      sam_snippets: await count("sam_snippets", `song_id=eq.${songId}`),
    };
    console.log("  will cascade away:", cascades);
    console.log("  references to check:", blockers);

    if (blockers.sam_sessions > 0) {
      console.log(
        `%cBLOCKED%c ${blockers.sam_sessions} practice session(s) reference this song. ` +
          `sam_sessions.song_id has no ON DELETE rule, so the delete would fail. ` +
          `Delete those sessions first if the practice history is genuinely disposable.`,
        "color:#c00;font-weight:bold", ""
      );
      return { deleted: false, reason: "sessions-exist", blockers };
    }
    if (blockers.child_songs > 0) {
      console.log(
        `%cWARNING%c ${blockers.child_songs} song(s) name this as parent_song_id. ` +
          `They will NOT be deleted — they will be orphaned into roots.`,
        "color:#b80;font-weight:bold", ""
      );
    }

    if (!opts.apply) {
      console.log("  dry run — nothing deleted. Re-run with {apply: true} to delete.");
      return { deleted: false, reason: "dry-run", blockers, cascades };
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/sam_songs?id=eq.${songId}`, {
      method: "DELETE",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken()}` },
    });
    if (!res.ok) {
      console.log(`%cFAILED%c ${res.status} ${await res.text()}`, "color:#c00;font-weight:bold", "");
      return { deleted: false, reason: "http-error" };
    }
    console.log(`%cDELETED%c "${song.title}"`, "color:#0a0;font-weight:bold", "");
    return { deleted: true };
  };

  console.log(
    'samDiff loaded.\n' +
      '  samList("Someone Like You")           → find song ids\n' +
      '  samDiff("<source-id>", "<copy-id>")   → run the diff\n' +
      '  samSafeDelete("<id>")                 → dry-run delete check\n' +
      '  samSafeDelete("<id>", {apply: true})  → actually delete'
  );
})();
