// Does mcp/index.ts actually LOAD, and do its tools actually REGISTER?
//
// Run (Node 24+, no Deno toolchain needed):
//   node --experimental-strip-types --test supabase/functions/mcp/index.test.mjs
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// On 2026-09-01 the deployed function threw on EVERY request:
//
//   ReferenceError: RUN_STATUS is not defined
//       at createMcpServer (.../mcp/index.ts:768:15)
//
// 125 tests had passed on that build. They could not have caught it: every
// other test loads a HANDLER module (dj-courier.ts, dj-reads.ts, ...) with
// platform.ts stubbed. NOTHING loaded index.ts, so nothing ever executed the
// tool REGISTRATION code where the fault was.
//
// The module even booted cleanly - 70-120ms - because `const` is not hoisted:
// the missing binding only throws when createMcpServer() runs, on first
// dispatch. A green deploy, a healthy boot, and a dead function.
//
// So this asserts the two things the other tests structurally cannot:
//   1. index.ts evaluates at module scope without throwing;
//   2. createMcpServer() runs to completion and registers the expected tools.
//
// EXTERNAL packages are stubbed; the REAL sibling tool modules are kept, so an
// export/import mismatch between index.ts and dj-courier.ts is still caught -
// which is precisely the class VALID_RUN_STATUS belonged to.
// ===========================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "..", "_shared", "tools");

// Chainable stand-in for zod: every access and call returns something both
// callable and property-accessible, so z.string().optional().describe(...) and
// z.coerce.number() both work without the real library.
const ZOD_STUB = `
const chain = () => new Proxy(function () { return chain(); }, {
  get: (_t, k) => (k === "then" ? undefined : chain()),
  apply: () => chain(),
});
export const z = chain();
`;

const MCP_STUB = `
globalThis.__registered = [];
export const McpServer = class {
  registerTool(name, cfg, handler) {
    globalThis.__registered.push({ name, cfg, handler });
    return this;
  }
  connect() { return Promise.resolve(); }
};
`;

// A stub value must survive anything a module does to it at load time:
// property access, calling, chaining, and `new` - sam-authoring.ts constructs
// Ajv and calls .addSchema() at module scope. A plain function stub returns {}
// from `new`, and the next property access dies.
const CHAIN = `
const chain = () => new Proxy(function () { return chain(); }, {
  get: (_t, k) => {
    if (k === "then") return undefined;                  // not a thenable
    if (k === Symbol.toPrimitive) return () => "stub";   // survives \`\${x}\`
    if (k === Symbol.toStringTag) return "stub";
    if (k === "toString" || k === "valueOf") return () => "stub";
    return chain();
  },
  apply: () => chain(),
  construct: () => chain(),
});
`;
const named = (names) => CHAIN +
  names.map((n) => `export const ${n} = chain();`).join("\n");
const DEFAULT_STUB = CHAIN + "export default chain();";

let registered;

test("mcp/index.ts LOADS and REGISTERS - the thing the other tests could not check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-index-"));
  mkdirSync(dir, { recursive: true });

  const stubs = new Map();
  // Every module is written flat into one directory, so a kept import is
  // rewritten to "./<basename>" and an external one to "./stub_N.ts".
  //
  // ⚠️ SCOPE: only the dj-*.ts modules are kept REAL. sam-authoring.ts builds an
  // Ajv instance at module scope and is not worth stubbing around; it is
  // replaced like any external. So this test catches an export/import mismatch
  // between index.ts and the DJ modules - the class that broke - but NOT one
  // against the SAM or alfred modules. Stated rather than left to be assumed
  // from a green run.
  const keep = new Set(readdirSync(TOOLS).filter((f) => f.startsWith("dj-") && f.endsWith(".ts")));

  const neutralise = (src) => {
    const rewrite = (whole, names, spec, isDefault) => {
      const base = spec.split("/").pop();
      if (keep.has(base)) return whole.replace(spec, `./${base}`);
      let id = [...stubs.entries()].find(([, v]) => v.spec === spec)?.[0];
      if (!id) {
        id = `stub_${stubs.size}`;
        stubs.set(id, { spec, kind: spec === "zod" ? "zod"
          : names.includes("McpServer") ? "mcp"
          : isDefault ? "default" : "named", names: new Set() });
      }
      // UNION the names across every file importing this module. Reusing the
      // first importer's list left later importers missing an export - which is
      // itself the "two lists of the same thing" failure this test exists for.
      if (!isDefault) {
        for (const n of names.split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) {
          stubs.get(id).names.add(n);
        }
      }
      return whole.replace(spec, `./${id}.ts`);
    };
    // `A?` tolerates an import-attributes clause - `with { type: "json" }` or
    // the older `assert { ... }`. Without it a JSON import slips through
    // unrewritten and resolves against the temp directory.
    const A = String.raw`(?:\s*(?:with|assert)\s*\{[^}]*\})?\s*;`;
    return src
      .replace(new RegExp('^import "[^"]*"' + A + String.raw`\s*$`, "gm"), "")
      .replace(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*"([^"]+)"` + A, "g"),
        (w, n, s) => rewrite(w, n, s, false))
      .replace(new RegExp(String.raw`import\s+(\w+)\s+from\s*"([^"]+)"` + A, "g"),
        (w, n, s) => rewrite(w, n, s, true));
  };

  for (const f of keep) {
    writeFileSync(join(dir, f), neutralise(readFileSync(join(TOOLS, f), "utf-8")));
  }
  writeFileSync(join(dir, "index.probe.ts"),
    neutralise(readFileSync(join(HERE, "index.ts"), "utf-8")));
  for (const [id, s] of stubs) {
    const body = s.kind === "zod" ? ZOD_STUB
      : s.kind === "mcp" ? MCP_STUB
      : s.kind === "default" ? DEFAULT_STUB
      : named([...s.names]);
    writeFileSync(join(dir, `${id}.ts`), body);
  }

  globalThis.__registered = [];
  // index.ts ends with Deno.serve(app.fetch). Give it a Deno that records the
  // call instead of binding a port - the handler is what we want, not a server.
  globalThis.Deno = {
    serve: (h) => { globalThis.__served = h; return { finished: Promise.resolve() }; },
    env: { get: () => "stub" },
  };

  // THE ASSERTION. This evaluates index.ts at module scope: a missing top-level
  // binding, a bad import, a syntax error all surface right here.
  const mod = await import(pathToFileURL(join(dir, "index.probe.ts")).href);

  // ...and this executes the registration body, where RUN_STATUS was used.
  assert.equal(typeof mod.createMcpServer, "function",
    "createMcpServer must be EXPORTED so this test can run it. An unexercised " +
    "registration path is how a dead function ships green.");
  mod.createMcpServer("test-token");

  registered = globalThis.__registered;
  assert.ok(registered.length > 20, `expected the full tool surface, got ${registered.length}`);
});

test("every tool that reads the shared status enum registers", () => {
  // These three use RUN_STATUS. A missing or stale binding kills all of them.
  for (const name of ["create_platform_run", "update_platform_run", "get_platform_runs"]) {
    assert.ok(registered.some((r) => r.name === name), `${name} not registered`);
  }
});

test("update_platform_run accepts the outcome fields", () => {
  // Their absence from the input schema stripped them silently, before the
  // handler that validates them ever saw them.
  const t = registered.find((r) => r.name === "update_platform_run");
  const keys = Object.keys(t.cfg.inputSchema ?? {});
  for (const k of ["id", "status", "notified_at", "covered_from",
                   "covered_to", "details", "error_message"]) {
    assert.ok(keys.includes(k), `update_platform_run input schema is missing ${k}`);
  }
});

test("the DJ tool surface is registered", () => {
  for (const name of ["record_dj_plays", "get_dj_plays",
                      "get_dj_managed_playlists", "create_platform_schedule",
                      "get_dj_artists", "upsert_dj_artist",
                      "get_dj_concerts", "update_dj_concert",
                      "record_dj_feedback", "record_dj_artist_tag", "get_dj_artist_tags",
                      "record_dj_album", "get_dj_albums"]) {
    assert.ok(registered.some((r) => r.name === name), `${name} not registered`);
  }
});

test("get_dj_jazz_activity is REMOVED, not renamed — one artist definition", () => {
  // 🛑 SECTION 3 IS `get_dj_plays mode=artists tag=jazz`, THE SAME FUNCTION AS
  // SECTION 4 WITH A FILTER. Two overlapping definitions produced §14.19:
  // `in_playlist` and `in_any_playlist` reading opposite ways for Wes
  // Montgomery, in one report, both correct.
  //
  // ⚠️ THIS ASSERTS ABSENCE ON PURPOSE. Re-registering it as a thin wrapper
  // would restore a second NAME for one idea, and the next reader would have to
  // discover they are the same. A removed tool fails loudly at the call site.
  assert.ok(
    !registered.some((r) => r.name === "get_dj_jazz_activity"),
    "get_dj_jazz_activity is back — Section 3 must stay a filter on the rollup",
  );
});

test("dry_run_dj_plays is deliberately NOT an MCP tool", () => {
  // It exists only behind POST /mcp/import-takeout, where the batch is read
  // from disk and never passes through a model's context. Registering it would
  // add a manifest entry with no caller - and every manifest change costs a
  // connector reconnect. This assertion pins the intent: if someone registers
  // it later, that should be a decision, not a drive-by.
  assert.ok(!registered.some((r) => r.name === "dry_run_dj_plays"),
    "dry_run_dj_plays is now registered as an MCP tool - was that deliberate?");
});

test("dry_run_dj_playlist is deliberately NOT an MCP tool either", () => {
  // Same argument, one phase later: it exists only behind
  // POST /mcp/import-playlist?mode=dry_run, where the payload comes off a
  // YouTube read and never enters a model's context. Registering it would cost
  // a connector reconnect to add a tool with no caller.
  assert.ok(!registered.some((r) => r.name === "dry_run_dj_playlist"),
    "dry_run_dj_playlist is now registered as an MCP tool - was that deliberate?");
});

test("the tool count is 72 after the job-search tools", () => {
  // The number quoted at every reconnect. 36 through step 0 and step 1, which
  // added an endpoint and a non-registered tool on purpose. Step 2 adds three:
  // get_dj_concerts, update_dj_concert, record_dj_feedback - batched into ONE
  // deploy because each manifest change costs a reconnect and a fresh
  // conversation, and three separate deploys would spend three to save none.
  //
  // 2026-09-02, NET +1 AND IT IS THREE CHANGES: get_dj_jazz_activity REMOVED
  // (Section 3 became get_dj_plays mode=artists tag=jazz — one artist-level
  // definition, §14.19), record_dj_artist_tag and get_dj_artist_tags ADDED.
  // ⚠️ A NET COUNT HIDES A REMOVAL, which is why the three are named here: a
  // future reader seeing 40 -> 41 would otherwise assume one tool arrived.
  //
  // 2026-09-08, +2 for the Jazz thread: get_dj_albums (coverage as a fraction)
  // and record_dj_album (the memory — the canon is knowledge the model holds,
  // so a suggestion that is not written is a suggestion a later session repeats).
  //
  // 2026-09-11, +11 for Ken, all additions: get_ken_quiz_batch,
  // record_ken_attempts, create_ken_area, create_ken_item, get_ken_areas,
  // get_ken_items, get_ken_lyric_fragments, get_ken_misconceptions,
  // create_ken_misconception, update_ken_misconception, propose_ken_fact_update.
  //
  // 2026-09-11, +1: update_ken_area, so an area created in conversation can be
  // linked to its Alfred seed via source_ref.
  //
  // 2026-09-16, +2 that landed without updating this count (it read 57 against
  // 55 until practice plans M3): get_sam_passes (session playback metrics) and
  // get_sam_song_scores (analyzer port M5).
  //
  // 2026-09-16, +9 for SAM practice plans M3, all additions:
  // get_sam_practice_plan, get_sam_practice_plans, get_sam_plan_progress,
  // get_sam_goals, create_sam_practice_plan, update_sam_plan_review_note,
  // update_sam_song_goal, create_sam_goal, update_sam_goal.
  //
  // 2026-09-17, +1: create_sam_snippet, so a plan can use snippets the app has
  // not made yet.
  //
  // 2026-09-18, +1: get_sam_measure_stats — per-measure telemetry.
  //
  // 2026-09-22, +4 for job search, all additions, ONE deploy:
  // get_job_applications, create_job_application, update_job_application,
  // get_job_application_sources. Batched for the usual reason — each manifest
  // change costs a connector reconnect, so four deploys would spend four to
  // save none.
  assert.equal(registered.length, 72,
    `expected 72 registered tools, found ${registered.length}: ` +
    registered.map((r) => r.name).join(", "));
});

test("the job-search surface is registered, and its schemas match its handlers", () => {
  // Same check the Ken and SAM blocks run, for the same reason: a param a
  // handler honors but the schema does not advertise is invisible to every
  // future session, and one advertised but never read is a lie to the caller.
  // The handler is the source of truth, so this reads job-applications.ts
  // itself — one block per defineTool call, every `args.<key>` inside it.
  const src = readFileSync(join(TOOLS, "job-applications.ts"), "utf-8");
  const blocks = src.split("defineTool({").slice(1);
  assert.equal(blocks.length, 4,
    `expected 4 job tools in job-applications.ts, found ${blocks.length}`);
  for (const b of blocks) {
    const name = /name:\s*"([^"]+)"/.exec(b)[1];
    const tier = Number(/tier:\s*(\d)/.exec(b)[1]);
    const read = new Set([...b.matchAll(/\bargs\.(\w+)/g)].map((m) => m[1]));
    if (tier === 3) read.add("confirmed");
    const t = registered.find((r) => r.name === name);
    assert.ok(t, `${name} not registered`);
    const advertised = Object.keys(t.cfg.inputSchema ?? {}).sort();
    assert.deepEqual(advertised, [...read].sort(),
      `${name}: schema advertises [${advertised}] but the handler reads [${[...read].sort()}]`);
  }
});

test("create_job_application stays UNGATED", () => {
  // ⚠️ ASSERTS AN ABSENCE ON PURPOSE. Alex logs about three applications a day.
  // Promoting this to tier 3 would add a `confirmed` param and turn every
  // capture into two round trips to record a fact he just stated — and a
  // capture step people confirm three times a day is one they stop using. The
  // duplicate guard, not a prompt, is what catches the realistic mistake. If
  // this ever becomes gated, that should be a decision, not a drive-by.
  const t = registered.find((r) => r.name === "create_job_application");
  assert.ok(t, "create_job_application not registered");
  assert.ok(!Object.keys(t.cfg.inputSchema ?? {}).includes("confirmed"),
    "create_job_application now advertises `confirmed` — was the tier change deliberate?");
});

test("Ken schemas advertise exactly the args their handlers read", () => {
  // A param honored but unadvertised is invisible to every future session; one
  // advertised but ignored is a lie to the caller. The handler is the source of
  // truth, so this reads ken.ts itself: one block per defineTool call, and every
  // `args.<key>` inside it. Tier 3 adds `confirmed`, which defineTool's gate reads.
  const src = readFileSync(join(TOOLS, "ken.ts"), "utf-8");
  const blocks = src.split("defineTool({").slice(1);
  assert.equal(blocks.length, 12, `expected 12 Ken tools in ken.ts, found ${blocks.length}`);
  for (const b of blocks) {
    const name = /name:\s*"([^"]+)"/.exec(b)[1];
    const tier = Number(/tier:\s*(\d)/.exec(b)[1]);
    const read = new Set([...b.matchAll(/\bargs\.(\w+)/g)].map((m) => m[1]));
    if (tier === 3) read.add("confirmed");
    const t = registered.find((r) => r.name === name);
    assert.ok(t, `${name} not registered`);
    const advertised = Object.keys(t.cfg.inputSchema ?? {}).sort();
    assert.deepEqual(advertised, [...read].sort(),
      `${name}: schema advertises [${advertised}] but the handler reads [${[...read].sort()}]`);
  }
});

test("the SAM practice plan tools are registered, and the pass/session reads take the plan filters", () => {
  for (const name of ["get_sam_practice_plan", "get_sam_practice_plans", "get_sam_plan_progress",
                      "get_sam_goals", "create_sam_practice_plan", "update_sam_plan_review_note",
                      "update_sam_song_goal", "create_sam_goal", "update_sam_goal"]) {
    assert.ok(registered.some((r) => r.name === name), `${name} not registered`);
  }
  for (const name of ["get_sam_passes", "get_sam_sessions"]) {
    const keys = Object.keys(registered.find((r) => r.name === name).cfg.inputSchema ?? {});
    for (const k of ["plan_id", "plan_item_id"]) {
      assert.ok(keys.includes(k), `${name} input schema is missing ${k}`);
    }
  }
  // The handlers in index.ts must pass them through, or the schema is a lie.
  const src = readFileSync(join(HERE, "index.ts"), "utf-8");
  for (const tool of ["getSamPassesTool", "getSamSessionsTool"]) {
    const block = src.split(`const ${tool} = defineTool({`)[1].split("\n});")[0];
    for (const k of ["plan_id", "plan_item_id"]) {
      assert.match(block, new RegExp(`${k}: args\\.${k}\\b`), `${tool} does not pass ${k}`);
    }
  }
});

test("SAM plan schemas advertise exactly the args their handlers read", () => {
  // Same rule as the Ken test. Two tools read args through helper functions
  // (normalisePlanInput, planSongGoal), so a helper's reads count for every
  // tool body that calls it. `args[k]` lookups inside planSongGoal cover keys
  // that also appear literally, so literal `args.<key>` reads are enough.
  const src = readFileSync(join(TOOLS, "sam-plans.ts"), "utf-8").replace(/\r\n/g, "\n");
  const helpers = {};
  for (const m of src.matchAll(/^export (?:async )?function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)^\}/gm)) {
    if (/\bargs\b/.test(m[2])) helpers[m[1]] = new Set([...m[3].matchAll(/\bargs\.(\w+)/g)].map((x) => x[1]));
  }
  assert.ok(helpers.normalisePlanInput && helpers.planSongGoal, "helper functions not found in sam-plans.ts");
  const blocks = src.split("defineTool({").slice(1).map((b) => b.split("\n});")[0]);
  assert.equal(blocks.length, 9, `expected 9 tools in sam-plans.ts, found ${blocks.length}`);
  for (const b of blocks) {
    const name = /name:\s*"([^"]+)"/.exec(b)[1];
    const tier = Number(/tier:\s*(\d)/.exec(b)[1]);
    const read = new Set([...b.matchAll(/\bargs\.(\w+)/g)].map((m) => m[1]));
    for (const [fn, keys] of Object.entries(helpers)) {
      if (new RegExp(`\\b${fn}\\(`).test(b)) for (const k of keys) read.add(k);
    }
    if (tier === 3) read.add("confirmed");
    const t = registered.find((r) => r.name === name);
    assert.ok(t, `${name} not registered`);
    const advertised = Object.keys(t.cfg.inputSchema ?? {}).sort();
    assert.deepEqual(advertised, [...read].sort(),
      `${name}: schema advertises [${advertised}] but the handler reads [${[...read].sort()}]`);
  }
});

test("create_sam_snippet registers and advertises exactly the args its handler reads", () => {
  const t = registered.find((r) => r.name === "create_sam_snippet");
  assert.ok(t, "create_sam_snippet not registered");
  const src = readFileSync(join(TOOLS, "sam-snippets.ts"), "utf-8");
  const block = src.split("defineTool({")[1];
  assert.match(block, /tier:\s*1\b/);
  const read = [...new Set([...block.matchAll(/\bargs\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(Object.keys(t.cfg.inputSchema ?? {}).sort(), read);
  assert.deepEqual(read, ["end_measure", "hand_mode", "rest_measures", "song_id", "start_measure"]);
});

test("get_sam_measure_stats registers with the params its handler reads", () => {
  const t = registered.find((r) => r.name === "get_sam_measure_stats");
  assert.ok(t, "get_sam_measure_stats not registered");
  assert.deepEqual(Object.keys(t.cfg.inputSchema ?? {}).sort(),
    ["date_from", "date_to", "end_measure", "limit", "snippet_id", "song_id", "start_measure"]);
  // The description must carry the calibration-vs-error warning: a future
  // reader must not take a large mean offset as bad playing.
  assert.match(t.cfg.description, /CALIBRATION PLUS ERROR/);
  assert.match(t.cfg.description, /interval_ratio/);
});

test("no duplicate tool names", () => {
  const seen = new Set(), dupes = [];
  for (const r of registered) { if (seen.has(r.name)) dupes.push(r.name); seen.add(r.name); }
  assert.deepEqual(dupes, [], `duplicate registrations: ${dupes.join(", ")}`);
});

// ===========================================================================
// JOB-SEARCH HANDLER TESTS — considering and passed
// ===========================================================================
// The tests above this line assert REGISTRATION with zod stubbed, which cannot
// reach a handler. These run the real handlers against a fake database, using
// the harness from sam-snippets.test.mjs: platform.ts loaded REAL with only its
// Deno/JSR imports stubbed, so calls go through defineTool and ctx.db is the
// fake below.
//
// ⚠️ THE CONDITIONAL-EFFORT RULE LIVES IN TWO PLACES ON PURPOSE. The handlers
// enforce it (so the caller gets a sentence naming the rule) AND
// job_applications_effort_when_applied enforces it in the database, which is the
// authority. A fake database cannot check a CHECK constraint, so what these
// assert is that the HANDLER refuses FIRST — which is exactly the layer that
// would rot silently, because the constraint would keep catching the write
// either way and the caller would merely stop being told why.

const JOB_DIR = mkdtempSync(join(tmpdir(), "job-apps-"));

writeFileSync(join(JOB_DIR, "stub_supabase.ts"),
  "export const createClient = () => globalThis.__fakeJobDb;\n");
writeFileSync(join(JOB_DIR, "stub_crypto.ts"),
  "export const crypto = { subtle: { digest: async () => new Uint8Array(16).buffer } };\n");

let jobPlatformSrc = readFileSync(join(HERE, "..", "_shared", "platform.ts"), "utf-8");
for (const [from, to] of [
  ['import { createClient } from "jsr:@supabase/supabase-js@2";', 'import { createClient } from "./stub_supabase.ts";'],
  ['import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";', "type SupabaseClient = any;"],
  ['import { crypto as stdCrypto } from "jsr:@std/crypto";', 'import { crypto as stdCrypto } from "./stub_crypto.ts";'],
]) {
  if (!jobPlatformSrc.includes(from)) throw new Error(`platform.ts import changed — update this test: ${from}`);
  jobPlatformSrc = jobPlatformSrc.replace(from, to);
}
writeFileSync(join(JOB_DIR, "platform.ts"), jobPlatformSrc);

const JOB_IMPORT = 'import { clampLimit, defineTool, envelope } from "../platform.ts";';
const jobSrc = readFileSync(join(TOOLS, "job-applications.ts"), "utf-8");
if (!jobSrc.includes(JOB_IMPORT)) throw new Error("job-applications.ts import line changed — update this test.");
writeFileSync(join(JOB_DIR, "job-applications.ts"),
  jobSrc.replace(JOB_IMPORT, 'import { clampLimit, defineTool, envelope } from "./platform.ts";'));

globalThis.Deno ??= { env: { get: () => "stub" } };
const jobs = await import(pathToFileURL(join(JOB_DIR, "job-applications.ts")).href);

const jb64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JOB_REQ = new Request("http://localhost/", {
  headers: { Authorization: `Bearer ${jb64({ alg: "none" })}.${jb64({ sub: "user-1" })}.sig` },
});

// --- fake database ---------------------------------------------------------
// Only the operators these four handlers actually use. ilike keeps the
// database's own semantics — case-insensitive, with % and _ as wildcards —
// because the duplicate guard and the same-org scan both NARROW with ilike and
// then re-check in the handler, and a fake that treated the pattern literally
// would make that re-check look unnecessary.
function makeJobDb(rows = []) {
  const table = rows.map((r) => ({ ...r }));
  let seq = 0;
  const ilikeRe = (pat) =>
    new RegExp(
      "^" + String(pat)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")
        .replace(/_/g, ".") + "$",
      "i",
    );
  return {
    table,
    rpc() { return Promise.resolve({ data: [{ allowed: true, message: "" }], error: null }); },
    from() {
      const st = { op: "select", payload: null, filters: [], orders: [], limit: null };
      const api = {
        select() { return api; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
        neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
        in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
        gte(c, v) { st.filters.push((r) => String(r[c]) >= String(v)); return api; },
        lt(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) < String(v)); return api; },
        ilike(c, pat) { const re = ilikeRe(pat); st.filters.push((r) => re.test(String(r[c] ?? ""))); return api; },
        order(c, o = {}) { st.orders.push([c, o.ascending !== false]); return api; },
        limit(n) { st.limit = n; return api; },
        insert(p) { st.op = "insert"; st.payload = p; return api; },
        update(p) { st.op = "update"; st.payload = p; return api; },
        maybeSingle() { return run().then((r) => ({ ...r, data: r.data[0] ?? null })); },
        single() {
          return run().then((r) => r.data.length === 1
            ? { ...r, data: r.data[0] }
            : { data: null, error: { message: "not one row" } });
        },
        then(res, rej) { return run().then(res, rej); },
      };
      function run() {
        if (st.op === "insert") {
          const rec = {
            id: `00000000-0000-4000-8000-9${String(++seq).padStart(11, "0")}`,
            user_id: "user-1", effort: null, deadline: null, next_action: null,
            next_action_due: null, notes: null, created_at: "2026-09-23T10:00:00Z",
            ...st.payload,
          };
          table.push(rec);
          return Promise.resolve({ data: [rec], error: null });
        }
        let matched = table.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === "update") {
          matched.forEach((r) => Object.assign(r, st.payload));
          return Promise.resolve({ data: matched, error: null });
        }
        // Multi-key, string-safe and STABLE — the job reads order by applied_on
        // then created_at, and a numeric subtraction on date strings is NaN,
        // which silently leaves rows in insertion order instead of sorting.
        for (const [c, asc] of [...st.orders].reverse()) {
          matched = matched
            .map((r, i) => [r, i])
            .sort(([a, ai], [b, bi]) => {
              const x = String(a[c] ?? ""), y = String(b[c] ?? "");
              return ((x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1)) || (ai - bi);
            })
            .map(([r]) => r);
        }
        if (st.limit != null) matched = matched.slice(0, st.limit);
        return Promise.resolve({ data: matched, error: null });
      }
      return api;
    },
  };
}

async function callJob(tool, args, db) {
  globalThis.__fakeJobDb = db;
  return (await tool(args, JOB_REQ)).data;
}
async function jobError(tool, args, db) {
  try {
    await callJob(tool, args, db);
  } catch (e) {
    return e.message;
  }
  throw new Error(`expected a rejection for ${JSON.stringify(args)}, got none`);
}

test("VALID_JOB_STATUS carries considering and passed, and every job status enum is the SAME list", () => {
  // Enum parity. All three status-taking schemas build z.enum from this one
  // array, so the failure guarded against is a status added to the database and
  // to one description but not to the shared constant — which presents as the
  // tool rejecting a value the table accepts.
  for (const s of ["applied", "screening", "interview", "rejected", "offer",
                   "closed_no_response", "withdrawn", "considering", "passed"]) {
    assert.ok(jobs.VALID_JOB_STATUS.includes(s), `VALID_JOB_STATUS is missing ${s}`);
  }
  assert.equal(jobs.VALID_JOB_STATUS.length, 9,
    `VALID_JOB_STATUS has ${jobs.VALID_JOB_STATUS.length} entries: ${jobs.VALID_JOB_STATUS.join(", ")}`);

  // index.ts must DERIVE all three from that constant rather than re-listing.
  const src = readFileSync(join(HERE, "index.ts"), "utf-8");
  assert.match(src, /const JOB_STATUS = z\.enum\(VALID_JOB_STATUS/,
    "index.ts no longer builds JOB_STATUS from VALID_JOB_STATUS — a second list of statuses has appeared");
  for (const name of ["get_job_applications", "create_job_application", "update_job_application"]) {
    const t = registered.find((r) => r.name === name);
    assert.ok(t, `${name} not registered`);
    assert.ok(Object.keys(t.cfg.inputSchema ?? {}).includes("status"), `${name} does not advertise status`);
  }

  // And the vocabulary every description repeats must define both new statuses,
  // keep `withdrawn` meaning "applied, THEN pulled out", and say what
  // applied_on means on a row where nothing was submitted.
  assert.match(jobs.JOB_VOCAB, /considering \(seen the role, not yet decided/);
  assert.match(jobs.JOB_VOCAB, /passed \(seen the role, chose not to apply/);
  assert.match(jobs.JOB_VOCAB, /withdrawn \(Alex APPLIED and then pulled out/);
  assert.match(jobs.JOB_VOCAB, /date the ROLE WAS LOGGED/);

  // ⚠️ CHECKED IN index.ts's SOURCE, NOT IN cfg.description. The registration
  // harness above stubs job-applications.ts, so JOB_VOCAB reaches the
  // description as the chain stub's "stub" and the real sentence is not there to
  // find. The rule worth pinning is structural anyway: all four descriptions
  // APPEND the one constant, rather than paraphrasing it four times — which is
  // the drift the constant exists to prevent.
  for (const name of ["get_job_applications", "create_job_application",
                      "update_job_application", "get_job_application_sources"]) {
    const block = src.split(`"${name}",`)[1];
    assert.ok(block, `${name} is not registered in index.ts`);
    const description = block.split("inputSchema:")[0];
    assert.match(description, /\+\s*JOB_VOCAB,/,
      `${name}'s description does not end by appending the shared JOB_VOCAB constant`);
  }
});

test("create_job_application: effort is optional for considering and passed, required for every other status", async () => {
  // The point of the two new statuses is logging a role Alex has only LOOKED
  // at, where there is no effort to record because nothing was written.
  const base = { org: "Acme", role: "Engineer", source: "linkedin", fit: "high" };

  for (const status of ["considering", "passed"]) {
    const db = makeJobDb();
    const row = await callJob(jobs.createJobApplicationTool, { ...base, status }, db);
    assert.equal(row.status, status);
    assert.equal(row.effort, null, `${status} must be insertable with no effort`);
    assert.equal(db.table.length, 1, `${status} did not write a row`);
  }

  // Every other status still needs it, and the refusal must NAME the rule
  // rather than leave the caller to interpret a constraint name.
  for (const status of [undefined, "applied", "screening", "interview",
                        "rejected", "offer", "closed_no_response", "withdrawn"]) {
    const db = makeJobDb();
    const msg = await jobError(jobs.createJobApplicationTool, { ...base, status }, db);
    assert.match(msg, /`effort` is required unless status is considering or passed/,
      `status ${status ?? "(default)"}: the refusal does not name the rule: ${msg}`);
    assert.match(msg, /Nothing was written/);
    assert.equal(db.table.length, 0,
      `status ${status ?? "(default)"}: a row was written despite the missing effort`);
  }

  // With an effort, the ordinary path is unchanged.
  const ok = makeJobDb();
  const row = await callJob(jobs.createJobApplicationTool, { ...base, effort: "full" }, ok);
  assert.equal(row.status, "applied");
  assert.equal(row.effort, "full");

  // And the duplicate guard is UNTOUCHED by the new statuses: a role already
  // logged as `considering` is the row to UPDATE, not a second row to insert.
  const dupDb = makeJobDb();
  await callJob(jobs.createJobApplicationTool, { ...base, status: "considering" }, dupDb);
  const dupMsg = await jobError(jobs.createJobApplicationTool, { ...base, effort: "full" }, dupDb);
  assert.match(dupMsg, /already logged/);
  assert.match(dupMsg, /update_job_application/);
  assert.equal(dupDb.table.length, 1, "the duplicate guard let a second row through");
});

test("update_job_application: leaving considering or passed needs an effort, and the caller is TOLD so", async () => {
  const ROW = "00000000-0000-4000-8000-000000000001";
  const seed = (over) => makeJobDb([{
    id: ROW, applied_on: "2026-09-20", org: "Acme", role: "Engineer",
    source: "linkedin", fit: "high", effort: null, status: "considering",
    deadline: null, next_action: null, next_action_due: null, notes: null,
    created_at: "2026-09-20T10:00:00Z", ...over,
  }]);

  // ⚠️ THE RAW CONSTRAINT MESSAGE MUST NOT BE WHAT THE CALLER SEES. It names no
  // field that was passed and none that should be, so the next move is a guess.
  for (const status of ["applied", "screening", "interview", "rejected", "offer",
                        "closed_no_response", "withdrawn"]) {
    for (const from of ["considering", "passed"]) {
      const db = seed({ status: from });
      const msg = await jobError(jobs.updateJobApplicationTool, { id: ROW, status }, db);
      assert.match(msg, /no `effort`/, `${from} -> ${status}: ${msg}`);
      assert.match(msg, /send `effort` in the SAME call/, `${from} -> ${status}: ${msg}`);
      assert.match(msg, /Nothing was written/, `${from} -> ${status}: ${msg}`);
      assert.doesNotMatch(msg, /check constraint|job_applications_effort_when_applied/,
        `${from} -> ${status}: the database's raw constraint error reached the caller: ${msg}`);
      assert.equal(db.table[0].status, from, "the status changed despite the refusal");
    }
  }

  // Sent in the same call: allowed, and both fields land.
  const db = seed();
  const moved = await callJob(jobs.updateJobApplicationTool,
    { id: ROW, status: "applied", effort: "quick" }, db);
  assert.equal(moved.status, "applied");
  assert.equal(moved.effort, "quick");

  // Already stored on the row: no new effort needed. This is why the check is
  // made on the row that would RESULT and not on the patch alone.
  const held = seed({ status: "passed", effort: "quick" });
  assert.equal(
    (await callJob(jobs.updateJobApplicationTool, { id: ROW, status: "offer" }, held)).status,
    "offer",
  );

  // Moving INTO considering or passed needs nothing, effort stored or not.
  for (const to of ["considering", "passed"]) {
    const d = seed({ status: "applied", effort: "full" });
    assert.equal(
      (await callJob(jobs.updateJobApplicationTool, { id: ROW, status: to }, d)).status,
      to,
    );
  }
});

test("get_job_applications open_only: passed is terminal, considering is still live", async () => {
  const rows = ["applied", "screening", "interview", "offer", "considering",
                "rejected", "closed_no_response", "withdrawn", "passed"]
    .map((status, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i + 1}`, applied_on: "2026-09-20",
      org: `Org ${i}`, role: "Engineer", source: "linkedin", fit: "high",
      effort: status === "considering" || status === "passed" ? null : "full",
      status, deadline: null, next_action: null, next_action_due: null,
      notes: null, created_at: `2026-09-20T10:0${i}:00Z`,
    }));
  const open = await callJob(jobs.getJobApplicationsTool, { open_only: true }, makeJobDb(rows));
  assert.deepEqual([...open.map((r) => r.status)].sort(),
    ["applied", "considering", "interview", "offer", "screening"],
    "open_only must drop rejected, closed_no_response, withdrawn AND passed, and keep considering");
});

test("get_job_application_sources excludes considering and passed from every count", async () => {
  // Two sources with identical applications, but `browse` also carries four
  // roles Alex only looked at. If those counted, browse would read 1/5 = 0.2
  // against linkedin's 1/1 — the source he checks most often would look like
  // the worst one, purely for having been checked.
  const mk = (source, status, i) => ({
    id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
    applied_on: "2026-09-20", org: `Org ${i}`, role: "Engineer", source,
    fit: "high", effort: status === "considering" || status === "passed" ? null : "full",
    status, deadline: null, next_action: null, next_action_due: null, notes: null,
    created_at: "2026-09-20T10:00:00Z",
  });
  const rows = [
    mk("linkedin", "interview", 1),
    mk("browse", "interview", 2),
    mk("browse", "considering", 3),
    mk("browse", "considering", 4),
    mk("browse", "passed", 5),
    mk("browse", "passed", 6),
  ];
  const out = await callJob(jobs.getJobApplicationSourcesTool, {}, makeJobDb(rows));

  assert.deepEqual(out.sources.map((s) => s.source).sort(), ["browse", "linkedin"]);
  assert.deepEqual(out.sources.find((s) => s.source === "browse"), {
    source: "browse", total: 1, responded: 1, response_rate: 1,
    reached_interview: 1, offers: 0, waiting: 0,
  }, "the four never-submitted rows leaked into browse's counts");
  assert.equal(out.applications_counted, 2, "applications_counted must count submissions only");
  assert.equal(out.not_applied_excluded, 4);

  // A source with NOTHING but considering/passed rows must not appear at all —
  // its total would be 0 and response_rate would be 0/0, i.e. NaN.
  const onlyLooked = await callJob(jobs.getJobApplicationSourcesTool, {},
    makeJobDb([mk("browse", "considering", 7), mk("browse", "passed", 8)]));
  assert.deepEqual(onlyLooked.sources, []);
  assert.equal(onlyLooked.applications_counted, 0);
  assert.equal(onlyLooked.not_applied_excluded, 2);

  // The reading text is the only place the caller learns WHY the numbers
  // exclude them, so it has to say so — as does the tool description.
  assert.match(onlyLooked.reading, /considering or passed were never submitted/);
  assert.match(onlyLooked.reading, /lower every source's response rate/);
  assert.match(
    registered.find((r) => r.name === "get_job_application_sources").cfg.description,
    /excluded from EVERY count here, `total` included/,
  );
});
