// The warm-up ladder rules (spec §3, §4, §6). Every case here is one the player
// can reach at the piano.

import {
  MIN_RUNG_BPM, OFF_PLAN_ACCURACY, applyPass, ladderSummaryText, resolveLadder, resolveTarget,
  rungAccuracyTarget, rungProgressText, rungTempo, shouldSuggestEasier, sourceLabel, startRun,
  stripModel,
} from "./warmupLadder";

const rung = (percent, over = {}) => ({
  target_percent: percent, accuracy_target: null, target_passes: 2, consecutive: true, ...over,
});
const LADDER = [rung(50), rung(70), rung(100)];
const pass = (hits, misses, notesPlayed = hits + misses) => ({ hits, misses, notesPlayed });

describe("resolveLadder: plan item, then snippet, then song, then default (§4)", () => {
  const DEF = [rung(70), rung(100)];

  test("the plan item wins over everything", () => {
    expect(resolveLadder({
      planItem: { warmup_ladder: LADDER }, snippet: { warmupLadder: DEF },
      song: { warmupLadder: DEF }, defaultLadder: DEF,
    })).toEqual({ ladder: LADDER, source: "plan" });
  });

  test("null at a level falls through to the next", () => {
    expect(resolveLadder({
      planItem: { warmup_ladder: null }, snippet: { warmupLadder: null },
      song: { warmupLadder: LADDER }, defaultLadder: DEF,
    })).toEqual({ ladder: LADDER, source: "song" });
  });

  test("the default is the last resort", () => {
    expect(resolveLadder({ song: {}, defaultLadder: DEF })).toEqual({ ladder: DEF, source: "default" });
  });

  test("an empty array means NO warm-up here and stops the chain", () => {
    expect(resolveLadder({
      snippet: { warmupLadder: [] }, song: { warmupLadder: LADDER }, defaultLadder: DEF,
    })).toEqual({ ladder: [], source: "snippet" });
  });

  test("no default yet and nothing else: no ladder, and no invented one", () => {
    expect(resolveLadder({ snippet: {}, song: {}, defaultLadder: null }))
      .toEqual({ ladder: null, source: null });
  });

  test("the level is reported, because the player has to say where it came from", () => {
    expect(sourceLabel("plan")).toBe("from the plan");
    expect(sourceLabel("snippet")).toBe("from this snippet");
    expect(sourceLabel("song")).toBe("from the song");
    expect(sourceLabel("default")).toBe("default");
  });
});

describe("resolveTarget: what the percents are percentages of (§4)", () => {
  test("the plan item's heard target comes first", () => {
    expect(resolveTarget({
      planItem: { target_effective_bpm: 48 },
      song: { goalSetAt: "2026-09-01", goalEffectiveBpm: 60 }, bpm: 90, playbackSpeed: 100,
    })).toEqual({ effectiveBpm: 48, source: "plan" });
  });

  test("then the song's CONFIRMED goal", () => {
    expect(resolveTarget({
      song: { goalSetAt: "2026-09-01", goalEffectiveBpm: 60 }, bpm: 90, playbackSpeed: 100,
    })).toEqual({ effectiveBpm: 60, source: "song" });
  });

  test("a placeholder goal is not a target — the tempo box is used instead", () => {
    expect(resolveTarget({
      song: { goalSetAt: null, goalEffectiveBpm: 60 }, bpm: 90, playbackSpeed: 100,
    })).toEqual({ effectiveBpm: 90, source: "box" });
  });

  test("the tempo box is read as a HEARD tempo, speed included", () => {
    expect(resolveTarget({ song: {}, bpm: 80, playbackSpeed: 75 }))
      .toEqual({ effectiveBpm: 60, source: "box" });
  });
});

describe("rungTempo: how the box reaches a rung (§4)", () => {
  test("no audio: BPM is the tempo and speed stays at 100", () => {
    expect(rungTempo({ targetEffectiveBpm: 60, percent: 70, song: {} }))
      .toEqual({ bpm: 42, playbackSpeed: 100, effectiveBpm: 42 });
  });

  test("with audio: BPM stays pinned to default_bpm and SPEED carries the rung", () => {
    // 50% of a 60 BPM target is 30, reached as 100 BPM at 30% speed.
    expect(rungTempo({ targetEffectiveBpm: 60, percent: 50, song: { audioFilePath: "a.mp3", defaultBpm: 100 } }))
      .toEqual({ bpm: 100, playbackSpeed: 30, effectiveBpm: 30 });
  });

  test("the floor is 20 BPM heard, however low the percent", () => {
    expect(rungTempo({ targetEffectiveBpm: 30, percent: 10, song: {} }).effectiveBpm).toBe(MIN_RUNG_BPM);
  });

  test("100% of the target IS the target", () => {
    expect(rungTempo({ targetEffectiveBpm: 44, percent: 100, song: {} }).effectiveBpm).toBe(44);
  });

  test("an audio song with no calibration cannot express a rung", () => {
    expect(rungTempo({ targetEffectiveBpm: 60, percent: 70, song: { audioFilePath: "a.mp3", defaultBpm: null } }))
      .toBeNull();
  });
});

describe("the accuracy bar for a rung (§3)", () => {
  test("the rung's own wins", () => expect(rungAccuracyTarget(rung(70, { accuracy_target: 95 }), 80)).toBe(95));
  test("then the plan item's", () => expect(rungAccuracyTarget(rung(70), 80)).toBe(80));
  test("off plan it is 85", () => expect(rungAccuracyTarget(rung(70), null)).toBe(OFF_PLAN_ACCURACY));
});

describe("the engine (§6.3-§6.5)", () => {
  test("a run starts at rung one with every counter at zero", () => {
    const run = startRun(LADDER);
    expect(run.rung).toBe(0);
    expect(run.counts).toEqual([0, 0, 0]);
    expect(run.complete).toBe(false);
  });

  test("an empty ladder is not a run", () => {
    expect(startRun([])).toBeNull();
    expect(startRun(null)).toBeNull();
  });

  test("a qualifying pass increments the current rung, and says which rung it was", () => {
    const r = applyPass(startRun(LADDER), { playthrough: pass(10, 0), itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("credited");
    expect(r.state.counts).toEqual([1, 0, 0]);
    expect(r.pass).toEqual({ warmupRung: 1, warmupTargetPercent: 50 });
  });

  test("the rung's count reaching target_passes advances, and the next rung starts at zero", () => {
    let s = startRun(LADDER);
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    const r = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("advanced");
    expect(r.state.rung).toBe(1);
    // The finished rung KEEPS its count, so the strip still shows it filled.
    expect(r.state.counts).toEqual([2, 0, 0]);
    // The pass that caused the advance is still recorded at the rung it was played at.
    expect(r.pass).toEqual({ warmupRung: 1, warmupTargetPercent: 50 });
  });

  test("a failed pass resets a CONSECUTIVE rung to zero", () => {
    let s = startRun(LADDER);
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    expect(s.counts).toEqual([1, 0, 0]);
    const r = applyPass(s, { playthrough: pass(5, 5), itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("failed");
    expect(r.state.counts).toEqual([0, 0, 0]);
  });

  test("a failed pass leaves a CUMULATIVE rung alone", () => {
    const ladder = [rung(50, { consecutive: false }), rung(100, { consecutive: false })];
    let s = startRun(ladder);
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    const r = applyPass(s, { playthrough: pass(0, 10), itemAccuracyTarget: 90 });
    expect(r.state.counts).toEqual([1, 0]);
  });

  test("a pass with no notes is not an attempt: it changes nothing at all", () => {
    let s = startRun(LADDER);
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    const r = applyPass(s, { playthrough: { hits: 0, misses: 8, notesPlayed: 0 }, itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("ignored");
    expect(r.state.counts).toEqual([1, 0, 0]);
    expect(r.state.fails).toBe(0);
  });

  test("notes played but nothing scored is a FAILED attempt, as it is in the database", () => {
    const s = startRun(LADDER);
    // notesPlayed > 0 with no scored beats: accuracy is null, which is not
    // "good enough" — and sam_plan_item_progress counts it as a non-qualifying
    // attempt, which breaks a streak.
    const r = applyPass(s, { playthrough: { hits: 0, misses: 0, notesPlayed: 3 }, itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("failed");
    expect(r.state.fails).toBe(1);
  });

  test("the last rung's count being met completes the ladder", () => {
    let s = startRun([rung(50), rung(100)]);
    for (let i = 0; i < 3; i++) s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    const r = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("completed");
    expect(r.state.complete).toBe(true);
  });

  test("after completion it keeps looping: passes are still marked with the last rung", () => {
    let s = startRun([rung(50), rung(100)]);
    for (let i = 0; i < 4; i++) s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    const r = applyPass(s, { playthrough: pass(3, 7), itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("after-complete");
    expect(r.pass).toEqual({ warmupRung: 2, warmupTargetPercent: 100 });
    // A bad pass after completion does not un-complete it or reset anything.
    expect(r.state.complete).toBe(true);
    expect(r.state.counts).toEqual([2, 2]);
  });

  test("a rung's own accuracy target is stricter than the item's, and is used", () => {
    const ladder = [rung(50, { accuracy_target: 100 }), rung(100)];
    const r = applyPass(startRun(ladder), { playthrough: pass(9, 1), itemAccuracyTarget: 90 });
    expect(r.outcome).toBe("failed");
  });
});

describe("three failures at one rung earn a suggestion, never an adjustment (§6.7)", () => {
  test("it appears on the third failed attempt and not before", () => {
    let s = startRun(LADDER);
    for (let i = 0; i < 2; i++) s = applyPass(s, { playthrough: pass(0, 10), itemAccuracyTarget: 90 }).state;
    expect(shouldSuggestEasier(s)).toBe(false);
    s = applyPass(s, { playthrough: pass(0, 10), itemAccuracyTarget: 90 }).state;
    expect(shouldSuggestEasier(s)).toBe(true);
    // And the ladder has NOT moved: the rung is still rung one.
    expect(s.rung).toBe(0);
  });

  test("one good pass clears it", () => {
    let s = startRun(LADDER);
    for (let i = 0; i < 3; i++) s = applyPass(s, { playthrough: pass(0, 10), itemAccuracyTarget: 90 }).state;
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    expect(shouldSuggestEasier(s)).toBe(false);
  });
});

describe("what the strip and the plan line say (§7.2, §7.3)", () => {
  test("one group per rung, marked done, current or still to come", () => {
    let s = startRun(LADDER);
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    expect(stripModel(s)).toEqual([
      { percent: 50, target: 2, filled: 2, consecutive: true, state: "done" },
      { percent: 70, target: 2, filled: 0, consecutive: true, state: "current" },
      { percent: 100, target: 2, filled: 0, consecutive: true, state: "todo" },
    ]);
  });

  test("a completed ladder shows every rung done", () => {
    let s = startRun([rung(50), rung(100)]);
    for (let i = 0; i < 4; i++) s = applyPass(s, { playthrough: pass(10, 0), itemAccuracyTarget: 90 }).state;
    expect(stripModel(s).map((r) => r.state)).toEqual(["done", "done"]);
  });

  test("the ladder as one line", () => {
    expect(ladderSummaryText(LADDER)).toBe("50% → 70% → 100%");
    expect(ladderSummaryText([])).toBe("");
  });

  test("rung progress for a warm-up item's plan line", () => {
    const s = startRun(LADDER);
    expect(rungProgressText(s)).toBe("rung 1 of 3");
    expect(rungProgressText({ ...s, rung: 1 })).toBe("rung 2 of 3");
    expect(rungProgressText({ ...s, complete: true })).toBe("warm-up complete");
  });
});
