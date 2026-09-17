// Handler tests for the SAM practice plan and goal tools (sam-plans.ts).
//
// Run:
//   node --test supabase/functions/_shared/tools/sam-plans.test.mjs
//
// Unlike the sibling suites, platform.ts is loaded REAL here, with only its
// three Deno-specific imports stubbed (the Supabase client constructor, the
// type import and std/crypto). So the tier-3 tests go through defineTool's
// actual confirmation gate — the proposal a tool returns without `confirmed`
// is the one the MCP server returns — and createContext hands every handler
// the fake database below, exactly as ctx.db.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sam-plans-"));

// --- load platform.ts with its Deno imports stubbed ---------------------------
writeFileSync(join(dir, "stub_supabase.ts"),
  "export const createClient = () => globalThis.__fakeDb;\n");
writeFileSync(join(dir, "stub_crypto.ts"),
  "export const crypto = { subtle: { digest: async () => new Uint8Array(16).buffer } };\n");
let platformSrc = readFileSync(join(HERE, "..", "platform.ts"), "utf-8");
for (const [from, to] of [
  ['import { createClient } from "jsr:@supabase/supabase-js@2";', 'import { createClient } from "./stub_supabase.ts";'],
  ['import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";', "type SupabaseClient = any;"],
  ['import { crypto as stdCrypto } from "jsr:@std/crypto";', 'import { crypto as stdCrypto } from "./stub_crypto.ts";'],
]) {
  if (!platformSrc.includes(from)) throw new Error(`platform.ts import changed — update this test: ${from}`);
  platformSrc = platformSrc.replace(from, to);
}
writeFileSync(join(dir, "platform.ts"), platformSrc);

const toolSrc = readFileSync(join(HERE, "sam-plans.ts"), "utf-8");
const IMPORT = 'import { defineTool, clampLimit, envelope } from "../platform.ts";';
if (!toolSrc.includes(IMPORT)) throw new Error("sam-plans.ts import line changed — update this test.");
writeFileSync(join(dir, "sam-plans.ts"), toolSrc.replace(IMPORT, IMPORT.replace("../platform.ts", "./platform.ts")));

globalThis.Deno = { env: { get: () => "stub" } };
const mod = await import(pathToFileURL(join(dir, "sam-plans.ts")).href);

// A request carrying a well-formed (unsigned) JWT; createContext only decodes `sub`.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const REQ = new Request("http://localhost/", {
  headers: { Authorization: `Bearer ${b64({ alg: "none" })}.${b64({ sub: "user-1" })}.sig` },
});

// --- fake database -------------------------------------------------------------
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SONG_AUDIO = U(1);    // Someone Like You: audio, default 67
const SONG_PLAIN = U(2);    // Pastorale: no audio
const SONG_ARCHIVED = U(3);
const SNIP_RH = U(11);      // Pastorale m.5-12 RH
const SNIP_OTHER = U(12);   // belongs to SONG_AUDIO
const PLAN_ACTIVE = U(21);
const PLAN_OLD = U(22);
const ITEM_1 = U(31);
const ITEM_2 = U(32);
const GOAL_1 = U(41);

function baseTables() {
  return {
    sam_songs: [
      { id: SONG_AUDIO, title: "Someone Like You", archived: false, audio_file_path: "u/sly.mp3",
        default_bpm: 67, goal_bpm: 67, goal_playback_speed: 90, goal_effective_bpm: 60, goal_set_at: null },
      { id: SONG_PLAIN, title: "Pastorale", archived: false, audio_file_path: null,
        default_bpm: 70, goal_bpm: 75, goal_playback_speed: 100, goal_effective_bpm: 75,
        goal_set_at: "2026-09-16T20:00:00Z" },
      { id: SONG_ARCHIVED, title: "Old Song", archived: true, audio_file_path: null,
        default_bpm: 60, goal_bpm: 60, goal_playback_speed: 100, goal_effective_bpm: 60, goal_set_at: null },
    ],
    sam_snippets: [
      { id: SNIP_RH, song_id: SONG_PLAIN, title: "Bars 5-12", start_measure: 5, end_measure: 12,
        settings: { handMode: "rh" }, archived: false },
      { id: SNIP_OTHER, song_id: SONG_AUDIO, title: "Chorus", start_measure: 37, end_measure: 44,
        settings: {}, archived: false },
    ],
    sam_practice_plans: [
      { id: PLAN_ACTIVE, status: "active", starts_on: "2026-09-10", ended_at: null,
        supersedes_plan_id: PLAN_OLD, day_note: "Speed on Pastorale.", internal_notes: "why",
        review_instructions: "Post when 90% at 60 three days.", review_note: null, review_noted_at: null,
        created_at: "2026-09-10T16:00:00Z", updated_at: "2026-09-10T16:00:00Z" },
      { id: PLAN_OLD, status: "superseded", starts_on: "2026-08-01", ended_at: "2026-09-10T05:30:00Z",
        supersedes_plan_id: null, day_note: null, internal_notes: null, review_instructions: "x",
        review_note: "Due.", review_noted_at: "2026-09-09T15:00:00Z",
        created_at: "2026-08-01T16:00:00Z", updated_at: "2026-09-10T05:30:00Z" },
    ],
    sam_practice_plan_songs: [
      { id: U(51), plan_id: PLAN_ACTIVE, song_id: SONG_PLAIN, position: 1, song_note: "Master m.5-12.",
        internal_notes: "needs speed", created_at: "2026-09-10T16:00:00Z" },
      { id: U(52), plan_id: PLAN_ACTIVE, song_id: SONG_AUDIO, position: 2, song_note: null,
        internal_notes: null, created_at: "2026-09-10T16:00:00Z" },
      { id: U(53), plan_id: PLAN_OLD, song_id: SONG_PLAIN, position: 1, song_note: "Learn it.",
        internal_notes: null, created_at: "2026-08-01T16:00:00Z" },
    ],
    sam_practice_plan_items: [
      { id: ITEM_2, plan_id: PLAN_ACTIVE, plan_song_id: U(52), song_id: SONG_AUDIO, snippet_id: null,
        position: 2, is_free_play: true, target_bpm: 67, target_playback_speed: 90, target_effective_bpm: 60,
        target_passes: 2, accuracy_target: null, instruction: null, created_at: "x" },
      { id: ITEM_1, plan_id: PLAN_ACTIVE, plan_song_id: U(51), song_id: SONG_PLAIN, snippet_id: SNIP_RH,
        position: 1, is_free_play: false, target_bpm: 60, target_playback_speed: 100, target_effective_bpm: 60,
        target_passes: 4, accuracy_target: 90, instruction: "Count out loud.", created_at: "x" },
      { id: U(33), plan_id: PLAN_OLD, plan_song_id: U(53), song_id: SONG_PLAIN, snippet_id: null,
        position: 1, is_free_play: false, target_bpm: 50, target_playback_speed: 100, target_effective_bpm: 50,
        target_passes: 3, accuracy_target: 80, instruction: null, created_at: "x" },
    ],
    sam_goals: [
      { id: GOAL_1, title: "Play Pastorale", kind: "song", status: "active", song_id: SONG_PLAIN,
        notes: null, completed_at: null, created_at: "a", updated_at: "b" },
    ],
  };
}

function makeDb({ tables = baseTables(), rpc = {} } = {}) {
  const calls = [];
  let seq = 0;
  const db = {
    calls,
    tables,
    rpc(fn, args) {
      calls.push({ kind: "rpc", name: fn, args });
      if (fn === "platform_check_call_budget") {
        return Promise.resolve({ data: [{ allowed: true, message: "" }], error: null });
      }
      const h = rpc[fn];
      return Promise.resolve(h ? h(args) : { data: null, error: { message: `no rpc ${fn}` } });
    },
    from(table) {
      const st = { kind: "from", name: table, op: "select", payload: null, filters: [], order: [], limit: null, count: false, ops: [] };
      calls.push(st);
      const rows = () => (tables[table] ??= []);
      const api = {
        select(_c, o) { if (o?.count) st.count = true; return api; },
        eq(c, v) { st.ops.push(["eq", c, v]); st.filters.push((r) => r[c] === v); return api; },
        is(c, v) { st.ops.push(["is", c, v]); st.filters.push((r) => (r[c] ?? null) === v); return api; },
        in(c, vs) { st.ops.push(["in", c, vs]); st.filters.push((r) => vs.includes(r[c])); return api; },
        gte(c, v) { st.filters.push((r) => r[c] >= v); return api; },
        lte(c, v) { st.filters.push((r) => r[c] <= v); return api; },
        order(c, o = {}) { st.order.push([c, o.ascending !== false]); return api; },
        limit(n) { st.limit = n; return api; },
        insert(p) { st.op = "insert"; st.payload = p; return api; },
        update(p) { st.op = "update"; st.payload = p; return api; },
        maybeSingle() { return run().then((r) => ({ ...r, data: r.data?.[0] ?? null })); },
        single() {
          return run().then((r) => r.data?.length === 1
            ? { ...r, data: r.data[0] }
            : { data: null, error: { message: "expected one row" } });
        },
        then(res, rej) { return run().then(res, rej); },
      };
      function run() {
        if (st.op === "insert") {
          const rec = { id: `new-${++seq}`, status: "someday", notes: null, song_id: null,
            completed_at: null, created_at: "now", updated_at: "now", ...st.payload };
          rows().push(rec);
          return Promise.resolve({ data: [rec], error: null });
        }
        let matched = rows().filter((r) => st.filters.every((f) => f(r)));
        if (st.op === "update") {
          matched.forEach((r) => Object.assign(r, st.payload));
          return Promise.resolve({ data: matched, error: null });
        }
        const count = matched.length;
        for (const [c, asc] of [...st.order].reverse()) {
          matched = [...matched].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
        }
        if (st.limit != null) matched = matched.slice(0, st.limit);
        return Promise.resolve({ data: matched, count: st.count ? count : null, error: null });
      }
      return api;
    },
  };
  return db;
}

async function call(tool, args, db) {
  globalThis.__fakeDb = db;
  return await tool(args, REQ);
}
const writes = (db) => db.calls.filter((c) => c.op === "insert" || c.op === "update" ||
  (c.kind === "rpc" && !["platform_check_call_budget", "sam_plan_item_progress", "sam_plan_unplanned_practice"].includes(c.name)));

// --- create_sam_practice_plan -------------------------------------------------------

const GOOD_PLAN = {
  day_note: "Speed on Pastorale.",
  internal_notes: "He has the notes; this is about tempo.",
  review_instructions: "Post when 90% at 60 on m.5-12 three days running.",
  songs: [
    {
      song_id: SONG_PLAIN,
      song_note: "Master m.5-12 (RH), then hands together.",
      items: [
        { snippet_id: SNIP_RH, target_bpm: 60, target_passes: 4, accuracy_target: 90, instruction: "Count out loud." },
        { target_bpm: 70, target_passes: 1, accuracy_target: 70 },
      ],
    },
    {
      song_id: SONG_AUDIO,
      items: [
        { target_bpm: 67, target_playback_speed: 80, target_passes: 3, accuracy_target: 85 },
        { snippet_id: SNIP_OTHER, is_free_play: true, target_passes: 2 },
      ],
    },
  ],
};

test("create_sam_practice_plan without confirmed: a readable proposal, nothing written", async () => {
  const db = makeDb();
  const out = await call(mod.createSamPracticePlanTool, structuredClone(GOOD_PLAN), db);
  const p = out.data;
  assert.equal(p.confirmation_required, true);
  assert.equal(p.tool, "create_sam_practice_plan");
  const text = p.proposal.text;
  assert.match(text, /Supersedes the active plan that started 2026-09-10/);
  assert.match(text, /Day note \(shown on the Sam tab\): Speed on Pastorale\./);
  assert.match(text, /Review instructions .*: Post when 90% at 60 on m\.5-12/);
  assert.match(text, /SONG: Pastorale\n  Song note \(shown in the player\): Master m\.5-12 \(RH\), then hands together\./);
  assert.match(text, /1\. Bars 5-12 \(m\.5–12, RH\) · 60 BPM heard · 4 passes · 90% accuracy — "Count out loud\."/);
  assert.match(text, /2\. Whole song · 70 BPM heard · 1 pass · 70% accuracy/);
  assert.match(text, /SONG: Someone Like You \(has audio\)/);
  assert.match(text, /3\. Whole song · 54 BPM heard \(67 BPM at 80%\) · 3 passes · 85% accuracy/);
  assert.match(text, /4\. Chorus \(m\.37–44, Both\) · 60 BPM heard \(the song's goal — an unconfirmed placeholder\) · 2 passes · Free Play/);
  assert.deepEqual(p.proposal.supersedes_plan, { id: PLAN_ACTIVE, starts_on: "2026-09-10" });
  assert.equal(p.proposal.item_count, 4);
  assert.equal(p.proposal.free_play_count, 1);
  assert.deepEqual(writes(db), []);
});

test("create_sam_practice_plan: no active plan says nothing is superseded", async () => {
  const tables = baseTables();
  tables.sam_practice_plans[0].status = "superseded";
  const out = await call(mod.createSamPracticePlanTool, structuredClone(GOOD_PLAN), makeDb({ tables }));
  assert.match(out.data.proposal.text, /There is no active plan, so nothing is superseded\./);
  assert.equal(out.data.proposal.supersedes_plan, null);
});

test("create_sam_practice_plan: a plan that would be refused is refused before approval", async () => {
  const db = makeDb();
  const bad = {
    review_instructions: "x",
    songs: [
      { song_id: SONG_AUDIO, items: [
        { target_bpm: 60, target_passes: 2, accuracy_target: 80 },            // audio: bpm must be 67
        { target_bpm: 67, target_passes: 2 },                                  // missing accuracy
        { snippet_id: SNIP_RH, is_free_play: true, target_passes: 1, accuracy_target: 50 }, // other song's snippet; free play with accuracy
      ] },
      { song_id: SONG_PLAIN, items: [
        { target_bpm: 60, target_playback_speed: 90, target_passes: 2, accuracy_target: 80 }, // no audio: speed must be 100
        { is_free_play: false, target_passes: 1, accuracy_target: 80 },        // missing tempo
      ] },
      { song_id: SONG_ARCHIVED, items: [] },
      { song_id: U(99), items: [] },
    ],
  };
  await assert.rejects(call(mod.createSamPracticePlanTool, bad, db), (e) => {
    assert.match(e.message, /^create_sam_practice_plan: 8 validation error\(s\)\. Nothing was proposed or written:/);
    assert.match(e.message, /songs\[0\]\.items\[0\]: "Someone Like You" has audio, so target_bpm must equal its default_bpm \(67\)/);
    assert.match(e.message, /songs\[0\]\.items\[1\]: a non-free-play item needs accuracy_target/);
    assert.match(e.message, /songs\[0\]\.items\[2\]: snippet "Bars 5-12" belongs to a different song/);
    assert.match(e.message, /songs\[0\]\.items\[2\]: a Free Play item must not have accuracy_target/);
    assert.match(e.message, /songs\[1\]\.items\[0\]: "Pastorale" has no audio, so target_playback_speed must be 100/);
    assert.match(e.message, /songs\[1\]\.items\[1\]: a non-free-play item needs target_bpm/);
    assert.match(e.message, /songs\[2\]: "Old Song" is archived/);
    assert.match(e.message, /songs\[3\]: song .* not found/);
    return true;
  });
  assert.deepEqual(writes(db), []);
});

test("create_sam_practice_plan: shape errors are collected, and more than 20 items is refused", async () => {
  const items = Array.from({ length: 21 }, () => ({ target_bpm: 60, target_passes: 1, accuracy_target: 80 }));
  await assert.rejects(
    call(mod.createSamPracticePlanTool, { songs: [{ song_id: SONG_PLAIN, items }, { song_id: SONG_PLAIN, items: [{}] }] }, makeDb()),
    (e) => {
      assert.match(e.message, /`review_instructions` is required/);
      assert.match(e.message, /songs\[1\]\.song_id appears twice/);
      assert.match(e.message, /songs\[1\]\.items\[0\]\.target_passes is required/);
      assert.match(e.message, /at most 20 items; this one has 22/);
      return true;
    });
  await assert.rejects(call(mod.createSamPracticePlanTool, { review_instructions: "x", songs: [] }, makeDb()),
    /`songs` must be a non-empty array/);
});

test("create_sam_practice_plan confirmed: the function receives the §6.2 plan and the new plan comes back", async () => {
  const NEW = U(29);
  let received;
  const db = makeDb({ rpc: { sam_create_practice_plan: (args) => {
    received = args;
    db.tables.sam_practice_plans.push({ ...baseTables().sam_practice_plans[0], id: NEW, starts_on: "2026-09-17" });
    return { data: NEW, error: null };
  } } });
  const out = await call(mod.createSamPracticePlanTool, { ...structuredClone(GOOD_PLAN), confirmed: true }, db);
  assert.deepEqual(Object.keys(received), ["p_plan"]);
  assert.deepEqual(received.p_plan, {
    day_note: "Speed on Pastorale.",
    internal_notes: "He has the notes; this is about tempo.",
    review_instructions: "Post when 90% at 60 on m.5-12 three days running.",
    songs: [
      { song_id: SONG_PLAIN, song_note: "Master m.5-12 (RH), then hands together.", internal_notes: null, items: [
        { snippet_id: SNIP_RH, is_free_play: false, target_bpm: 60, target_passes: 4, accuracy_target: 90, instruction: "Count out loud." },
        { snippet_id: null, is_free_play: false, target_bpm: 70, target_passes: 1, accuracy_target: 70, instruction: null },
      ] },
      { song_id: SONG_AUDIO, song_note: null, internal_notes: null, items: [
        { snippet_id: null, is_free_play: false, target_bpm: 67, target_playback_speed: 80, target_passes: 3, accuracy_target: 85, instruction: null },
        { snippet_id: SNIP_OTHER, is_free_play: true, target_passes: 2, instruction: null },
      ] },
    ],
  });
  assert.equal(out.data.plan.id, NEW);
  assert.ok(Array.isArray(out.data.songs) && Array.isArray(out.data.items));
});

test("create_sam_practice_plan confirmed: a database refusal is a validation error with its message unchanged", async () => {
  const msg = "Snippet 1234 is archived (item 3).";
  const db = makeDb({ rpc: { sam_create_practice_plan: () => ({ data: null, error: { code: "P0001", message: msg } }) } });
  await assert.rejects(call(mod.createSamPracticePlanTool, { ...structuredClone(GOOD_PLAN), confirmed: true }, db),
    { message: `create_sam_practice_plan: validation error: ${msg}` });
  const db2 = makeDb({ rpc: { sam_create_practice_plan: () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) } });
  await assert.rejects(call(mod.createSamPracticePlanTool, { ...structuredClone(GOOD_PLAN), confirmed: true }, db2),
    (e) => { assert.match(e.message, /sam_create_practice_plan failed: canceling statement/); assert.doesNotMatch(e.message, /retry/i); return true; });
});

// --- update_sam_song_goal -------------------------------------------------------------

test("update_sam_song_goal without confirmed: a proposal, nothing written", async () => {
  const db = makeDb();
  const out = await call(mod.updateSamSongGoalTool, { song_id: SONG_AUDIO, goal_playback_speed: 100 }, db);
  const p = out.data.proposal;
  assert.equal(out.data.confirmation_required, true);
  assert.equal(p.song_title, "Someone Like You");
  assert.equal(p.current_goal_effective_bpm, 60);
  assert.equal(p.current_goal_is_placeholder, true);
  assert.equal(p.new_goal_effective_bpm, 67);
  assert.deepEqual(p.writes, { goal_bpm: 67, goal_playback_speed: 100, goal_set_at: "now" });
  assert.match(p.text, /Current goal: 60 BPM heard — a PLACEHOLDER, never confirmed/);
  assert.match(p.text, /New goal: 67 BPM heard/);
  assert.deepEqual(writes(db), []);
});

test("update_sam_song_goal proposal for a confirmed no-audio goal", async () => {
  const out = await call(mod.updateSamSongGoalTool, { song_id: SONG_PLAIN, goal_bpm: 80 }, makeDb());
  const p = out.data.proposal;
  assert.equal(p.current_goal_is_placeholder, false);
  assert.equal(p.new_goal_effective_bpm, 80);
  assert.deepEqual(p.writes, { goal_bpm: 80, goal_playback_speed: 100, goal_set_at: "now" });
  assert.match(p.text, /confirmed 2026-09-16T20:00:00Z/);
});

test("update_sam_song_goal rejects goal_bpm on a song with audio, with or without confirmed", async () => {
  for (const confirmed of [undefined, true]) {
    const db = makeDb();
    await assert.rejects(call(mod.updateSamSongGoalTool, { song_id: SONG_AUDIO, goal_bpm: 70, confirmed }, db), (e) => {
      assert.match(e.message, /^update_sam_song_goal: "Someone Like You" has audio, so its goal is set with `goal_playback_speed`, not `goal_bpm`/);
      assert.match(e.message, /default_bpm \(67\)/);
      return true;
    });
    assert.deepEqual(writes(db), []);
  }
});

test("update_sam_song_goal rejects goal_playback_speed on a song without audio, with or without confirmed", async () => {
  for (const confirmed of [undefined, true]) {
    const db = makeDb();
    await assert.rejects(call(mod.updateSamSongGoalTool, { song_id: SONG_PLAIN, goal_playback_speed: 90, confirmed }, db),
      /update_sam_song_goal: "Pastorale" has no audio, so its goal is set with `goal_bpm`, not `goal_playback_speed`/);
    assert.deepEqual(writes(db), []);
  }
});

test("update_sam_song_goal needs exactly one of the three", async () => {
  await assert.rejects(call(mod.updateSamSongGoalTool, { song_id: SONG_PLAIN }, makeDb()), /exactly one .* got none/);
  await assert.rejects(call(mod.updateSamSongGoalTool, { song_id: SONG_PLAIN, goal_bpm: 80, confirm_only: true }, makeDb()),
    /exactly one .* got goal_bpm, confirm_only/);
  await assert.rejects(call(mod.updateSamSongGoalTool, { song_id: SONG_PLAIN, goal_bpm: 0 }, makeDb()), /positive whole number/);
  await assert.rejects(call(mod.updateSamSongGoalTool, { song_id: U(99), goal_bpm: 80 }, makeDb()), /not found/);
});

test("update_sam_song_goal confirmed: audio holds bpm at default, no-audio sets speed 100, always stamps goal_set_at", async () => {
  const db = makeDb();
  const out = await call(mod.updateSamSongGoalTool, { song_id: SONG_AUDIO, goal_playback_speed: 95, confirmed: true }, db);
  const upd = db.calls.find((c) => c.op === "update");
  assert.equal(upd.name, "sam_songs");
  assert.equal(upd.payload.goal_bpm, 67);
  assert.equal(upd.payload.goal_playback_speed, 95);
  assert.ok(!Number.isNaN(Date.parse(upd.payload.goal_set_at)));
  assert.equal(out.data.previous_goal_effective_bpm, 60);

  const db2 = makeDb();
  await call(mod.updateSamSongGoalTool, { song_id: SONG_PLAIN, confirm_only: true, confirmed: true }, db2);
  const upd2 = db2.calls.find((c) => c.op === "update");
  assert.deepEqual({ ...upd2.payload, goal_set_at: "t" }, { goal_bpm: 75, goal_playback_speed: 100, goal_set_at: "t" });
});

// --- update_sam_plan_review_note ------------------------------------------------------

test("update_sam_plan_review_note: an existing note is returned, never overwritten", async () => {
  const tables = baseTables();
  Object.assign(tables.sam_practice_plans[0], { review_note: "First.", review_noted_at: "2026-09-15T15:00:00Z" });
  const db = makeDb({ tables });
  const out = await call(mod.updateSamPlanReviewNoteTool, { plan_id: PLAN_ACTIVE, review_note: "Second." }, db);
  assert.deepEqual(out.data, { already_noted: true, review_note: "First.", review_noted_at: "2026-09-15T15:00:00Z" });
  assert.deepEqual(writes(db), []);
  assert.equal(tables.sam_practice_plans[0].review_note, "First.");
});

test("update_sam_plan_review_note: writes once on the active plan, guarded in the update itself", async () => {
  const db = makeDb();
  const out = await call(mod.updateSamPlanReviewNoteTool, { plan_id: PLAN_ACTIVE, review_note: "Due now." }, db);
  assert.equal(out.data.already_noted, false);
  assert.equal(out.data.review_note, "Due now.");
  const upd = db.calls.find((c) => c.op === "update");
  assert.deepEqual(upd.ops.filter((o) => o[0] === "is"), [["is", "review_note", null]]);
  assert.deepEqual(upd.ops.filter((o) => o[0] === "eq").map((o) => o[1]), ["id", "status"]);
});

test("update_sam_plan_review_note: refuses a superseded plan, an empty note and an unknown plan", async () => {
  await assert.rejects(call(mod.updateSamPlanReviewNoteTool, { plan_id: PLAN_OLD, review_note: "x" }, makeDb()),
    /plan .* is superseded; a review note can only be written on the active plan/);
  await assert.rejects(call(mod.updateSamPlanReviewNoteTool, { plan_id: PLAN_ACTIVE, review_note: "  " }, makeDb()),
    /`review_note` is required/);
  await assert.rejects(call(mod.updateSamPlanReviewNoteTool, { plan_id: U(98), review_note: "x" }, makeDb()),
    /plan .* not found/);
});

// --- get_sam_plan_progress ---------------------------------------------------------------

const NOW = new Date("2026-09-17T03:00:00Z"); // 2026-09-16 in Pacific time

test("progress range: an active plan defaults to its start through today (Pacific)", () => {
  assert.deepEqual(
    mod.resolveProgressRange({ status: "active", starts_on: "2026-09-10", ended_at: null }, undefined, undefined, NOW),
    { date_from: "2026-09-10", date_to: "2026-09-16", days: 7, capped: false });
});

test("progress range: a superseded plan ends on the Pacific date it ended", () => {
  // 05:30 UTC on 09-10 is 22:30 on 09-09 in Pacific time.
  assert.deepEqual(
    mod.resolveProgressRange({ status: "superseded", starts_on: "2026-08-20", ended_at: "2026-09-10T05:30:00Z" }, undefined, undefined, NOW),
    { date_from: "2026-08-20", date_to: "2026-09-09", days: 21, capped: false });
});

test("progress range: more than 31 days keeps the latest 31 and says so", () => {
  const r = mod.resolveProgressRange({ status: "superseded", starts_on: "2026-08-01", ended_at: "2026-09-10T05:30:00Z" }, undefined, undefined, NOW);
  assert.equal(r.capped, true);
  assert.equal(r.days, 31);
  assert.equal(r.date_to, "2026-09-09");
  assert.equal(r.date_from, "2026-08-10");
  assert.equal(r.requested_from, "2026-08-01");
  assert.match(r.note, /40 days; only the latest 31 \(2026-08-10 to 2026-09-09\)/);
  // Exactly 31 days is not capped.
  const ok = mod.resolveProgressRange({ status: "active", starts_on: "2026-01-01", ended_at: null }, "2026-08-10", "2026-09-09");
  assert.equal(ok.capped, false);
  assert.equal(ok.days, 31);
});

test("progress range: explicit dates win; a reversed range is an error", () => {
  const r = mod.resolveProgressRange({ status: "active", starts_on: "2026-09-10", ended_at: null }, "2026-09-12", "2026-09-13", NOW);
  assert.deepEqual([r.date_from, r.date_to], ["2026-09-12", "2026-09-13"]);
  assert.throws(() => mod.resolveProgressRange({ status: "active", starts_on: "2026-09-10", ended_at: null }, "2026-09-14", "2026-09-13", NOW),
    /date_from \(2026-09-14\) is after date_to \(2026-09-13\)/);
});

test("get_sam_plan_progress: calls both functions with the capped range and joins names", async () => {
  const seen = [];
  const db = makeDb({ rpc: {
    sam_plan_item_progress: (a) => { seen.push(["progress", a]); return { data: [
      { plan_item_id: ITEM_2, day: "2026-08-30", attempts: 1, qualifying: 1, best_accuracy: null, best_effective_bpm: 61, last_completed_at: "t" },
      { plan_item_id: ITEM_1, day: "2026-08-30", attempts: 3, qualifying: 2, best_accuracy: 93, best_effective_bpm: 60, last_completed_at: "t" },
    ], error: null }; },
    sam_plan_unplanned_practice: (a) => { seen.push(["unplanned", a]); return { data: [
      { song_id: SONG_AUDIO, snippet_id: SNIP_OTHER, day: "2026-08-31", attempts: 2, best_accuracy: 70, best_effective_bpm: 55 },
    ], error: null }; },
  } });
  const out = await call(mod.getSamPlanProgressTool, { plan_id: PLAN_ACTIVE, date_from: "2026-07-01", date_to: "2026-09-09" }, db);
  const expectedArgs = { p_plan_id: PLAN_ACTIVE, p_from: "2026-08-10", p_to: "2026-09-09" };
  assert.deepEqual(seen, [["progress", expectedArgs], ["unplanned", expectedArgs]]);
  assert.equal(out.data.range.capped, true);
  assert.deepEqual(out.data.items.map((i) => [i.position, i.song_title, i.snippet_title]),
    [[1, "Pastorale", "Bars 5-12"], [2, "Someone Like You", "Whole song"]]);
  assert.equal(out.data.items[0].accuracy_target, 90);
  assert.deepEqual(out.data.unplanned.map((u) => [u.song_title, u.snippet_title]), [["Someone Like You", "Chorus"]]);
});

test("get_sam_plan_progress: bad dates are refused before any call; no active plan is { plan: null }", async () => {
  for (const bad of ["2026-9-1", "2026-02-30", "yesterday", 20260901]) {
    const db = makeDb();
    await assert.rejects(call(mod.getSamPlanProgressTool, { date_from: bad }, db), /must be a Pacific date "YYYY-MM-DD"/);
    assert.equal(db.calls.filter((c) => c.kind === "from").length, 0);
  }
  const tables = baseTables();
  tables.sam_practice_plans[0].status = "superseded";
  const out = await call(mod.getSamPlanProgressTool, {}, makeDb({ tables }));
  assert.deepEqual(out.data, { plan: null });
});

// --- reads ----------------------------------------------------------------------------------

test("get_sam_practice_plan: the active plan with songs and items in order; none is { plan: null }", async () => {
  const out = await call(mod.getSamPracticePlanTool, {}, makeDb());
  assert.equal(out.data.plan.id, PLAN_ACTIVE);
  assert.equal(out.data.plan.internal_notes, "why");
  assert.deepEqual(out.data.songs.map((s) => [s.position, s.song_title, s.has_audio, s.goal_set_at]),
    [[1, "Pastorale", false, "2026-09-16T20:00:00Z"], [2, "Someone Like You", true, null]]);
  assert.equal(out.data.songs[1].default_bpm, 67);
  assert.equal(out.data.songs[1].goal_effective_bpm, 60);
  const [a, b] = out.data.items;
  assert.deepEqual([a.position, a.snippet_title, a.start_measure, a.end_measure, a.hand_mode, a.target_passes],
    [1, "Bars 5-12", 5, 12, "rh", 4]);
  assert.deepEqual([b.position, b.snippet_title, b.start_measure, b.hand_mode, b.is_free_play],
    [2, "Whole song", null, null, true]);

  const tables = baseTables();
  tables.sam_practice_plans[0].status = "superseded";
  assert.deepEqual((await call(mod.getSamPracticePlanTool, {}, makeDb({ tables }))).data, { plan: null });
  await assert.rejects(call(mod.getSamPracticePlanTool, { plan_id: U(97) }, makeDb()), /not found/);
});

test("get_sam_practice_plans: newest first; with song_id, that song's notes and items from each plan", async () => {
  const all = await call(mod.getSamPracticePlansTool, {}, makeDb());
  assert.deepEqual(all.data.map((p) => p.id), [PLAN_ACTIVE, PLAN_OLD]);
  assert.equal(all.data[0].items, undefined);

  const bySong = await call(mod.getSamPracticePlansTool, { song_id: SONG_PLAIN }, makeDb());
  assert.deepEqual(bySong.data.map((p) => [p.id, p.song.song_note, p.items.map((i) => i.snippet_title)]), [
    [PLAN_ACTIVE, "Master m.5-12.", ["Bars 5-12"]],
    [PLAN_OLD, "Learn it.", ["Whole song"]],
  ]);
  const none = await call(mod.getSamPracticePlansTool, { song_id: U(96) }, makeDb());
  assert.deepEqual(none.data, []);
  const superseded = await call(mod.getSamPracticePlansTool, { status: "superseded", limit: 1 }, makeDb());
  assert.deepEqual(superseded.data.map((p) => p.id), [PLAN_OLD]);
  await assert.rejects(call(mod.getSamPracticePlansTool, { status: "done" }, makeDb()), /must be one of active \| superseded/);
});

test("get_sam_practice_plans reports truncation from the exact count", async () => {
  const out = await call(mod.getSamPracticePlansTool, { limit: 1 }, makeDb());
  assert.deepEqual(out.meta, { count: 1, truncated: true, limit_applied: 1, total: 2 });
});

test("get_sam_goals: default limit 50, song titles joined, filters validated", async () => {
  const db = makeDb();
  const out = await call(mod.getSamGoalsTool, {}, db);
  assert.equal(db.calls.find((c) => c.name === "sam_goals").limit, 50);
  assert.equal(out.data[0].song_title, "Pastorale");
  await assert.rejects(call(mod.getSamGoalsTool, { kind: "scale" }, makeDb()), /`kind` must be one of song \| technique \| progression/);
  const db2 = makeDb();
  await call(mod.getSamGoalsTool, { limit: 500 }, db2);
  assert.equal(db2.calls.find((c) => c.name === "sam_goals").limit, 50);
});

// --- goals writes -----------------------------------------------------------------------------

test("create_sam_goal: inserts, with completed_at only when created done", async () => {
  const db = makeDb();
  const out = await call(mod.createSamGoalTool, { title: "Learn ii-V-I in C", kind: "progression" }, db);
  assert.equal(out.data.title, "Learn ii-V-I in C");
  assert.equal(out.data.song_title, null);
  assert.deepEqual(db.calls.find((c) => c.op === "insert").payload, { title: "Learn ii-V-I in C", kind: "progression" });

  const db2 = makeDb();
  const done = await call(mod.createSamGoalTool, { title: "x", kind: "song", status: "done", song_id: SONG_PLAIN }, db2);
  assert.ok(done.data.completed_at);
  assert.equal(done.data.song_title, "Pastorale");
  await assert.rejects(call(mod.createSamGoalTool, { title: "x" }, makeDb()), /`kind` is required/);
  await assert.rejects(call(mod.createSamGoalTool, { title: "", kind: "song" }, makeDb()), /`title` is required/);
});

test("update_sam_goal: done sets completed_at, leaving done clears it, nothing to change is an error", async () => {
  const db = makeDb();
  const done = await call(mod.updateSamGoalTool, { goal_id: GOAL_1, status: "done" }, db);
  assert.ok(done.data.completed_at);
  const again = await call(mod.updateSamGoalTool, { goal_id: GOAL_1, notes: "still done" }, db);
  assert.equal(again.data.completed_at, done.data.completed_at);
  const back = await call(mod.updateSamGoalTool, { goal_id: GOAL_1, status: "active" }, db);
  assert.equal(back.data.completed_at, null);
  const unlinked = await call(mod.updateSamGoalTool, { goal_id: GOAL_1, song_id: null }, db);
  assert.equal(unlinked.data.song_id, null);
  assert.equal(unlinked.data.song_title, null);

  await assert.rejects(call(mod.updateSamGoalTool, { goal_id: GOAL_1 }, makeDb()), /at least one of/);
  await assert.rejects(call(mod.updateSamGoalTool, { goal_id: U(95), title: "x" }, makeDb()), /goal .* not found/);
});

// --- the gate itself ----------------------------------------------------------------------------

test("tier-3 gate: propose runs read-only instead of the handler; confirmed runs the handler", async () => {
  const { defineTool } = await import(pathToFileURL(join(dir, "platform.ts")).href);
  const seen = [];
  const t = defineTool({
    name: "probe", tier: 3,
    propose: async (args, ctx) => { seen.push(["propose", ctx.userId]); return { text: `would ${args.x}` }; },
    handler: async (args) => { seen.push(["handler"]); return { did: args.x }; },
  });
  const out = await call(t, { x: 1 }, makeDb());
  assert.deepEqual(out.data.proposal, { text: "would 1" });
  assert.equal(out.data.confirmation_required, true);
  assert.deepEqual(seen, [["propose", "user-1"]]);
  const done = await call(t, { x: 2, confirmed: true }, makeDb());
  assert.deepEqual(done.data, { did: 2 });
  // A tier-3 tool without propose keeps the old proposal shape exactly.
  const plain = defineTool({ name: "plain", tier: 3, handler: async () => ({}) });
  const p = await call(plain, { y: 1 }, makeDb());
  assert.deepEqual(Object.keys(p.data), ["tool", "tier", "args", "confirmation_required", "message"]);
});
