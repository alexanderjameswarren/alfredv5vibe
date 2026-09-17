import {
  loadActivePlan, loadTodayProgress, matchPlanItem, planLinkFor,
  itemState, planSummary, itemTargetText, itemRangeText, todayKey,
  heardTempo, itemForLoadedRange, planSongFor, planLineText, planBadgeText, snippetTagText,
} from "./activePlan";

const PLAN = {
  id: "plan-1",
  items: [
    { id: "i-whole", song_id: "song-a", snippet_id: null, target_passes: 2, is_free_play: false },
    { id: "i-snip", song_id: "song-a", snippet_id: "snip-1", target_passes: 4, is_free_play: false },
    { id: "i-free", song_id: "song-b", snippet_id: null, target_passes: 2, is_free_play: true },
  ],
};

describe("matchPlanItem / planLinkFor — the recording link rule", () => {
  test("same song and same snippet; a null snippet is the whole song", () => {
    expect(matchPlanItem(PLAN, "song-a", null).id).toBe("i-whole");
    expect(matchPlanItem(PLAN, "song-a", undefined).id).toBe("i-whole");
    expect(matchPlanItem(PLAN, "song-a", "snip-1").id).toBe("i-snip");
    expect(matchPlanItem(PLAN, "song-b", null).id).toBe("i-free");
  });

  test("no item for another snippet, another song, or no song", () => {
    expect(matchPlanItem(PLAN, "song-a", "snip-2")).toBeNull();
    expect(matchPlanItem(PLAN, "song-b", "snip-1")).toBeNull();
    expect(matchPlanItem(PLAN, "song-c", null)).toBeNull();
    expect(matchPlanItem(PLAN, null, null)).toBeNull();
  });

  test("the link carries the plan even when no item matches (an on-the-fly snippet)", () => {
    expect(planLinkFor(PLAN, "song-a", "snip-1")).toEqual({ plan_id: "plan-1", plan_item_id: "i-snip" });
    expect(planLinkFor(PLAN, "song-a", "snip-9")).toEqual({ plan_id: "plan-1", plan_item_id: null });
  });

  test("no plan, or not loaded yet: both null, never a throw", () => {
    expect(planLinkFor(null, "song-a", null)).toEqual({ plan_id: null, plan_item_id: null });
    expect(planLinkFor(undefined, "song-a", null)).toEqual({ plan_id: null, plan_item_id: null });
    expect(planLinkFor({ id: "p", items: null }, "song-a", null)).toEqual({ plan_id: "p", plan_item_id: null });
    const broken = { id: "p", get items() { throw new Error("boom"); } };
    expect(planLinkFor(broken, "song-a", null)).toEqual({ plan_id: null, plan_item_id: null });
  });
});

describe("itemState", () => {
  const item = { id: "x", target_passes: 4 };
  const progress = (attempts, qualifying) => new Map([["x", { attempts, qualifying }]]);

  test("no attempts today: 0/4, not done, not amber", () => {
    expect(itemState(item, new Map())).toMatchObject({ shown: 0, target: 4, done: false, amber: false });
    expect(itemState(item, undefined)).toMatchObject({ shown: 0, done: false, amber: false });
  });
  test("attempts but short of the target: amber", () => {
    expect(itemState(item, progress(3, 0))).toMatchObject({ shown: 0, done: false, amber: true });
    expect(itemState(item, progress(5, 3))).toMatchObject({ shown: 3, done: false, amber: true });
  });
  test("qualifying reaches the target: done, never amber, shown capped at the target", () => {
    expect(itemState(item, progress(4, 4))).toMatchObject({ shown: 4, done: true, amber: false });
    expect(itemState(item, progress(9, 7))).toMatchObject({ shown: 4, done: true, amber: false });
  });
});

describe("planSummary and itemTargetText", () => {
  test("summary counts done items, with free play only when the plan has some", () => {
    const progress = new Map([
      ["i-whole", { attempts: 2, qualifying: 2 }],
      ["i-free", { attempts: 1, qualifying: 1 }],
    ]);
    expect(planSummary(PLAN, progress)).toBe("Today's plan · 1 of 2 done · Free play 0 of 1");
    const noFree = { ...PLAN, items: PLAN.items.filter((i) => !i.is_free_play) };
    expect(planSummary(noFree, progress)).toBe("Today's plan · 1 of 2 done");
  });

  test("target text uses the heard tempo; free play has no accuracy", () => {
    expect(itemTargetText({ target_bpm: 67, target_effective_bpm: 60, accuracy_target: 90, target_passes: 4 }))
      .toBe("60 BPM · 90% · 4 passes");
    expect(itemTargetText({ is_free_play: true, target_effective_bpm: 78, target_passes: 2 }))
      .toBe("78 BPM · 2 passes");
    expect(itemTargetText({ target_effective_bpm: 50, accuracy_target: 80, target_passes: 1 }))
      .toBe("50 BPM · 80% · 1 pass");
  });
});

// A minimal Supabase stand-in: canned rows per table, recorded calls.
function fakeSupabase(tables, rpcRows = []) {
  const calls = [];
  return {
    calls,
    rpc: (fn, args) => { calls.push({ rpc: fn, args }); return Promise.resolve({ data: rpcRows, error: null }); },
    from(table) {
      const filters = [];
      const api = {
        select: () => api,
        eq: (c, v) => { filters.push((r) => r[c] === v); return api; },
        in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return api; },
        order: () => api,
        maybeSingle: () => Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        then: (res, rej) => Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
      };
      calls.push({ from: table });
      return api;
    },
  };
}

describe("loadActivePlan", () => {
  const tables = {
    sam_practice_plans: [
      { id: "old", status: "superseded" },
      { id: "p1", status: "active", day_note: "Speed." },
    ],
    sam_practice_plan_songs: [
      { id: "ps1", plan_id: "p1", song_id: "s1", position: 1, song_note: "Master m.5-12." },
    ],
    sam_practice_plan_items: [
      { id: "a", plan_id: "p1", song_id: "s1", snippet_id: "sn-live", position: 1 },
      { id: "b", plan_id: "p1", song_id: "s1", snippet_id: "sn-archived", position: 2 },
      { id: "c", plan_id: "p1", song_id: "s1", snippet_id: "sn-gone", position: 3 },
      { id: "d", plan_id: "p1", song_id: "s1", snippet_id: null, position: 4 },
    ],
    sam_songs: [{ id: "s1", title: "Pastorale", audio_file_path: null, default_bpm: 70 }],
    sam_snippets: [
      { id: "sn-live", song_id: "s1", title: "Bars 5-12", start_measure: 5, end_measure: 12,
        rest_measures: 1, settings: { handMode: "rh" }, archived: false },
      { id: "sn-archived", song_id: "s1", title: "Old bars", start_measure: 1, end_measure: 2,
        rest_measures: 0, settings: {}, archived: true },
    ],
  };

  test("the active plan with titled songs and items; archived or missing snippets flagged", async () => {
    const plan = await loadActivePlan(fakeSupabase(tables));
    expect(plan.id).toBe("p1");
    expect(plan.songs).toEqual([
      { id: "ps1", plan_id: "p1", song_id: "s1", position: 1, song_note: "Master m.5-12.",
        title: "Pastorale", audio_file_path: null, default_bpm: 70 },
    ]);
    const [a, b, c, d] = plan.items;
    expect(a.song_title).toBe("Pastorale");
    expect(a.snippet).toMatchObject({ title: "Bars 5-12", start_measure: 5, end_measure: 12, hand_mode: "rh", archived: false });
    expect(a.snippet_unavailable).toBe(false);
    expect(b.snippet).toMatchObject({ title: "Old bars", archived: true });
    expect(b.snippet_unavailable).toBe(true);
    expect(c.snippet).toBeNull();
    expect(c.snippet_unavailable).toBe(true);
    expect(d.snippet).toBeNull();
    expect(d.snippet_unavailable).toBe(false);
  });

  test("no active plan is null", async () => {
    expect(await loadActivePlan(fakeSupabase({ sam_practice_plans: [{ id: "old", status: "superseded" }] }))).toBeNull();
  });
});

describe("loadTodayProgress", () => {
  test("asks the database for today only and keys the rows by item", async () => {
    const sb = fakeSupabase({}, [{ plan_item_id: "a", day: "2026-09-16", attempts: 3, qualifying: 2 }]);
    const map = await loadTodayProgress(sb, "p1", "2026-09-16");
    expect(sb.calls).toEqual([{ rpc: "sam_plan_item_progress", args: { p_plan_id: "p1", p_from: "2026-09-16", p_to: "2026-09-16" } }]);
    expect(map.get("a")).toEqual({ attempts: 3, qualifying: 2 });
    expect(map.get("b")).toBeUndefined();
  });

  test("today is the Pacific date", () => {
    // 03:00 UTC on the 17th is still the 16th in Los Angeles.
    expect(todayKey(new Date("2026-09-17T03:00:00Z"))).toBe("2026-09-16");
  });
});

describe("itemRangeText", () => {
  const sn = (over) => ({ id: "s", start_measure: 1, end_measure: 2, hand_mode: "both", title: "Measures 1-2 Both No Rest", ...over });
  test("whole song", () => {
    expect(itemRangeText({ snippet_id: null })).toBe("Whole song");
  });
  test("range, hand mode only when not Both, generated titles left out", () => {
    expect(itemRangeText({ snippet_id: "s", snippet: sn() })).toBe("m.1–2");
    expect(itemRangeText({ snippet_id: "s", snippet: sn({ hand_mode: "rh", title: "Measures 1-2 RH Rest: 1" }) })).toBe("m.1–2 · RH");
    expect(itemRangeText({ snippet_id: "s", snippet: sn({ hand_mode: "lh", title: "Measures 1 - 2 LH" }) })).toBe("m.1–2 · LH");
  });
  test("a title that says more than the range is kept", () => {
    expect(itemRangeText({ snippet_id: "s", snippet: sn({ start_measure: 37, end_measure: 44, title: "Chorus leap" }) }))
      .toBe("m.37–44 · Chorus leap");
  });
  test("archived keeps its range; missing says only that", () => {
    expect(itemRangeText({ snippet_id: "s", snippet: sn({ archived: true }), snippet_unavailable: true }))
      .toBe("m.1–2 · (snippet archived)");
    expect(itemRangeText({ snippet_id: "s", snippet: null, snippet_unavailable: true })).toBe("(snippet archived)");
  });
});

describe("player display helpers (§7.4)", () => {
  const item = { id: "i", target_effective_bpm: 60, accuracy_target: 90, target_passes: 4, instruction: "Count out loud" };
  const free = { id: "f", is_free_play: true, target_effective_bpm: 78, accuracy_target: null, target_passes: 1, instruction: null };
  const st = (attempts, qualifying, target = 4) =>
    itemState({ id: "x", target_passes: target }, new Map([["x", { attempts, qualifying }]]));

  test("heard tempo is round(bpm × speed / 100)", () => {
    expect(heardTempo(67, 90)).toBe(60);
    expect(heardTempo(60, 100)).toBe(60);
    expect(heardTempo(65, 85)).toBe(55); // 55.25
    expect(heardTempo(null, 100)).toBeNull();
  });

  test("plan line: item, free play, done, and amber (same text, colour elsewhere)", () => {
    expect(planLineText(item, st(3, 2))).toBe("Plan · 60 BPM · 90% · 2/4 today · Count out loud");
    expect(planLineText(free, st(0, 0, 1))).toBe("Free play · 78 BPM · 0/1 today");
    expect(planLineText(item, st(6, 5))).toBe("Plan · 60 BPM · 90% · Done 4/4 today · Count out loud");
    expect(planLineText({ ...item, instruction: null }, st(1, 0))).toBe("Plan · 60 BPM · 90% · 0/4 today");
    expect(st(1, 0).amber).toBe(true);
  });

  test("playing badge and snippet tag", () => {
    expect(planBadgeText(st(3, 2))).toBe("Plan 2/4");
    expect(planBadgeText(st(4, 4))).toBe("Plan ✓");
    expect(snippetTagText(item, st(3, 2))).toBe("Plan · 60 BPM · 2/4");
    expect(snippetTagText(item, st(9, 9))).toBe("Plan ✓");
  });

  test("the loaded range: a saved snippet, the whole song, and an unsaved range", () => {
    expect(itemForLoadedRange(PLAN, "song-a", null).id).toBe("i-whole");
    expect(itemForLoadedRange(PLAN, "song-a", { dbId: "snip-1" }).id).toBe("i-snip");
    // Typed but never saved: not the whole song, and no item.
    expect(itemForLoadedRange(PLAN, "song-a", { startMeasure: 1, endMeasure: 2 })).toBeNull();
    expect(itemForLoadedRange(null, "song-a", null)).toBeNull();
  });

  test("the plan's row for a song", () => {
    const plan = { songs: [{ song_id: "a", song_note: "Master m.5." }] };
    expect(planSongFor(plan, "a").song_note).toBe("Master m.5.");
    expect(planSongFor(plan, "b")).toBeNull();
    expect(planSongFor(null, "a")).toBeNull();
  });
});
