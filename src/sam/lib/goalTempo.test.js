import {
  inheritsGoalTempo,
  goalTempoInsertFields,
  fetchParentGoalTempo,
  parseGoalInput,
  heardGoalTempo,
  goalFromEditor,
} from "./goalTempo";

const PARENT_ID = "22222222-2222-2222-2222-222222222222";
const PARENT_GOAL = { goal_bpm: 72, goal_playback_speed: 90 };

describe("goalTempoInsertFields", () => {
  test("a source goal is used as given, with its speed when present", () => {
    expect(goalTempoInsertFields({ goalBpm: 80, goalPlaybackSpeed: 95 })).toEqual({
      goal_bpm: 80, goal_playback_speed: 95,
    });
    expect(goalTempoInsertFields({ goalBpm: 80 })).toEqual({ goal_bpm: 80 });
    expect(goalTempoInsertFields({ goalBpm: 80, goalPlaybackSpeed: null })).toEqual({ goal_bpm: 80 });
  });

  test("no goal in the source means no goal columns — defaultBpm is never copied", () => {
    for (const doc of [
      { defaultBpm: 65 },
      { defaultBpm: 65, goalBpm: null, goalPlaybackSpeed: null },
      // A speed without a bpm is not a goal on its own.
      { defaultBpm: 65, goalPlaybackSpeed: 90 },
      { songType: "original", defaultBpm: 65 },
    ]) {
      expect(goalTempoInsertFields(doc, PARENT_GOAL)).toEqual({});
    }
  });

  test("a simplified song with no goal of its own inherits the parent's pair", () => {
    const doc = { songType: "simplified", parentSongId: PARENT_ID, defaultBpm: 50 };
    expect(goalTempoInsertFields(doc, PARENT_GOAL)).toEqual(PARENT_GOAL);
  });

  test("a simplified song's own goal wins, and never borrows the parent's speed", () => {
    const doc = { songType: "simplified", parentSongId: PARENT_ID, goalBpm: 60 };
    expect(goalTempoInsertFields(doc, PARENT_GOAL)).toEqual({ goal_bpm: 60 });
  });

  test("drills never inherit, even with a parent", () => {
    const doc = { songType: "drill", parentSongId: PARENT_ID };
    expect(inheritsGoalTempo(doc)).toBe(false);
    expect(goalTempoInsertFields(doc, PARENT_GOAL)).toEqual({});
  });

  test("an unreadable parent falls back to the trigger", () => {
    const doc = { songType: "simplified", parentSongId: PARENT_ID };
    expect(goalTempoInsertFields(doc, null)).toEqual({});
  });
});

describe("fetchParentGoalTempo", () => {
  function fakeClient(result) {
    const calls = [];
    const chain = {
      from(t) { calls.push(["from", t]); return chain; },
      select(c) { calls.push(["select", c]); return chain; },
      eq(k, v) { calls.push(["eq", k, v]); return chain; },
      maybeSingle: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    };
    return { client: chain, calls };
  }

  test("reads the parent's goal columns only when the song inherits", async () => {
    const { client, calls } = fakeClient({ data: PARENT_GOAL, error: null });
    await expect(
      fetchParentGoalTempo({ songType: "simplified", parentSongId: PARENT_ID }, client)
    ).resolves.toEqual(PARENT_GOAL);
    expect(calls).toContainEqual(["eq", "id", PARENT_ID]);

    const idle = fakeClient({ data: PARENT_GOAL, error: null });
    await expect(fetchParentGoalTempo({ songType: "drill", parentSongId: PARENT_ID }, idle.client))
      .resolves.toBeNull();
    await expect(
      fetchParentGoalTempo({ songType: "simplified", parentSongId: PARENT_ID, goalBpm: 60 }, idle.client)
    ).resolves.toBeNull();
    expect(idle.calls).toEqual([]);
  });

  test("never rejects — a failed lookup resolves to null", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const doc = { songType: "simplified", parentSongId: PARENT_ID };
    await expect(fetchParentGoalTempo(doc, fakeClient({ data: null, error: { message: "x" } }).client))
      .resolves.toBeNull();
    await expect(fetchParentGoalTempo(doc, fakeClient(new Error("offline")).client))
      .resolves.toBeNull();
    await expect(fetchParentGoalTempo(doc, fakeClient({ data: null, error: null }).client))
      .resolves.toBeNull();
    warn.mockRestore();
  });
});

describe("parseGoalInput", () => {
  test("accepts a positive whole number, trimming whitespace", () => {
    expect(parseGoalInput("72")).toEqual({ value: 72, error: null });
    expect(parseGoalInput(" 5 ")).toEqual({ value: 5, error: null });
  });

  test("blank is an error, not a fallback", () => {
    for (const t of ["", "   ", null, undefined]) {
      const r = parseGoalInput(t);
      expect(r.value).toBeNull();
      expect(r.error).toMatch(/required/i);
    }
  });

  test("zero, negatives, decimals and junk are errors", () => {
    for (const t of ["0", "00", "-5", "7.5", "1e2", "abc", "72bpm"]) {
      const r = parseGoalInput(t);
      expect(r.value).toBeNull();
      expect(r.error).toBeTruthy();
    }
  });
});

describe("heardGoalTempo", () => {
  test("is round(goal_bpm * speed / 100), matching goal_effective_bpm", () => {
    expect(heardGoalTempo(72, 100)).toBe(72);
    expect(heardGoalTempo(60, 80)).toBe(48);
    expect(heardGoalTempo(65, 85)).toBe(55); // 55.25
    expect(heardGoalTempo(67, 75)).toBe(50); // 50.25
    expect(heardGoalTempo(90, 75)).toBe(68); // 67.5 rounds up
  });

  test("is null when either input is missing or not positive", () => {
    expect(heardGoalTempo(null, 100)).toBeNull();
    expect(heardGoalTempo(72, null)).toBeNull();
    expect(heardGoalTempo(0, 100)).toBeNull();
    expect(heardGoalTempo(NaN, 100)).toBeNull();
  });
});

describe("goalFromEditor", () => {
  test("without audio, the field is the goal BPM and speed is 100", () => {
    expect(goalFromEditor({ hasAudio: false, goalText: "80", defaultBpm: 65 })).toEqual({
      goal_bpm: 80, goal_playback_speed: 100, error: null,
    });
  });

  test("with audio, the field is the goal speed of the calibrated default BPM", () => {
    expect(goalFromEditor({ hasAudio: true, goalText: "80", defaultBpm: 60 })).toEqual({
      goal_bpm: 60, goal_playback_speed: 80, error: null,
    });
  });

  test("an invalid field is reported, and nothing is saved in its place", () => {
    for (const hasAudio of [false, true]) {
      const r = goalFromEditor({ hasAudio, goalText: "", defaultBpm: 60 });
      expect(r.error).toBeTruthy();
      expect(r.goal_bpm).toBeNull();
      expect(r.goal_playback_speed).toBeNull();
    }
  });
});
