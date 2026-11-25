// switchboard-panel: the key, the shape and the lane order, against fake dependencies.
// Run: node --experimental-strip-types --test supabase/functions/switchboard-panel/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPanel, handle, projectOfTag } from "./core.ts";

const KEY = "k".repeat(40);
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

const DATA = {
  // Newest first, as the query returns them.
  clips: [
    { run_tag: "aa-a1a-s3-aaaa", inbox_id: "in-a3" },
    { run_tag: "bb-b2b-s9b-bbbb", inbox_id: "in-b9" },
    { run_tag: "aa-a1a-s2-cccc", inbox_id: "in-a2" },
    { run_tag: "not a tag", inbox_id: "in-x" },
    { run_tag: "gone-g1g-s1-dddd", inbox_id: "in-gone" },
    { run_tag: "nolink-n1n-s1-eeee", inbox_id: null },
  ],
  inbox: [
    { id: "in-a3", archived: false }, { id: "in-b9", archived: true },
    { id: "in-a2", archived: true },
  ],
  actions: [{ project_code: "bb-b2b" }, { project_code: "bb-b2b" }, { project_code: "cc-c3c" }],
  portfolios: [{ id: "pf-2", position: 1 }, { id: "pf-1", position: 0 }],
  plans: [{ id: "pl-1", portfolio_id: "pf-1" }, { id: "pl-2", portfolio_id: "pf-2" }],
  lanes: [
    { id: "l-main", plan_id: "pl-1", name: "Main", position: 2 },
    { id: "l-fast", plan_id: "pl-1", name: "Fast track", position: 1 },
    { id: "l-client", plan_id: "pl-2", name: "Client", position: 1 },
  ],
  slices: [
    { plan_id: "pl-2", lane_id: "l-client", position: 1, group_id: "g-c", status: "in_progress" },
    { plan_id: "pl-1", lane_id: "l-main", position: 1, group_id: "g-a", status: "planned" },
    // Done in Fast track, still to do in Main: the work left decides.
    { plan_id: "pl-1", lane_id: "l-fast", position: 1, group_id: "g-a", status: "done" },
    { plan_id: "pl-1", lane_id: "l-fast", position: 2, group_id: "g-b", status: "done" },
    { plan_id: "pl-1", lane_id: "l-fast", position: 3, group_id: "g-none", status: "planned" },
  ],
  projectPlans: [
    { group_id: "g-a", project_code: "aa-a1a" }, { group_id: "g-b", project_code: "bb-b2b" },
    { group_id: "g-c", project_code: "cc-c3c" }, { group_id: "g-none", project_code: null },
  ],
};

function deps(over = {}) {
  return {
    panelKey: KEY,
    latestCliClips: async () => DATA.clips,
    inboxRows: async (ids) => DATA.inbox.filter((r) => ids.includes(r.id)),
    waitingActions: async () => DATA.actions,
    portfolios: async () => DATA.portfolios,
    activePlans: async () => DATA.plans,
    lanes: async () => DATA.lanes,
    slices: async () => DATA.slices,
    projectPlans: async () => DATA.projectPlans,
    liveLinks: async () => [],
    ...over,
  };
}

const get = (headers = {}, method = "GET") =>
  new Request("https://x/functions/v1/switchboard-panel", { method, headers });

test("refused without the right key, and reads nothing", async () => {
  let reads = 0;
  const counted = deps({ latestCliClips: async () => { reads++; return []; } });
  for (const req of [get(), get({ "x-switchboard-panel-key": "wrong" }), get({ "x-switchboard-panel-key": "k".repeat(39) })]) {
    const res = await handle(req, counted);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });
  }
  assert.equal(reads, 0);
});

test("an unset or short key on the server refuses everyone", async () => {
  for (const panelKey of ["", "short"]) {
    const res = await handle(get({ "x-switchboard-panel-key": panelKey }), deps({ panelKey }));
    assert.equal(res.status, 401);
  }
});

test("only GET, even with the key", async () => {
  const res = await handle(get({ "x-switchboard-panel-key": KEY }, "POST"), deps());
  assert.equal(res.status, 405);
});

test("per project: report unread, waiting on Alex, lane and order", async () => {
  const res = await handle(get({ "x-switchboard-panel-key": KEY }), deps());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    projects: {
      "aa-a1a": { report_unread: true, waiting_on_alex: false, lane: "Main", lane_order: 2, live_link: null },
      "bb-b2b": { report_unread: false, waiting_on_alex: true, lane: "Fast track", lane_order: 1, live_link: null },
      "cc-c3c": { report_unread: false, waiting_on_alex: true, lane: "Client", lane_order: 3, live_link: null },
      "gone-g1g": { report_unread: false, waiting_on_alex: false, lane: null, lane_order: null, live_link: null },
      "nolink-n1n": { report_unread: false, waiting_on_alex: false, lane: null, lane_order: null, live_link: null },
    },
  });
});

test("run tags: any step segment s<digit><letters or digits>", () => {
  assert.equal(projectOfTag("switchboard2-h8r-s86kd-f2mx"), "switchboard2-h8r");
  assert.equal(projectOfTag("switchboard2-h8r-s86l-a1b2"), "switchboard2-h8r");
  assert.equal(projectOfTag("switchboard2-h8r-s86-a1b2"), "switchboard2-h8r");
  assert.equal(projectOfTag("parallel_threads-p2q-s1-zz99"), "parallel_threads-p2q");
  for (const bad of ["not a tag", "switchboard2-h8r-x86-a1b2", "switchboard2-h8r-s-a1b2", "switchboard2-h8r-s86kd", null]) {
    assert.equal(projectOfTag(bad), null, String(bad));
  }
  const out = buildPanel({ ...DATA, clips: [{ run_tag: "dd-d4d-s86ke-p9dk", inbox_id: "in-a3" }] });
  assert.equal(out.projects["dd-d4d"].report_unread, true);
});

test("only the latest report counts, and a stray field never comes through", async () => {
  const out = buildPanel({
    ...DATA,
    clips: [{ run_tag: "aa-a1a-s3-aaaa", inbox_id: "in-a2", page_text: "SECRET" }, { run_tag: "aa-a1a-s2-cccc", inbox_id: "in-a3" }],
    actions: [{ project_code: "bb-b2b", payload: { sql: "drop table x" } }],
  });
  assert.equal(out.projects["aa-a1a"].report_unread, false);
  assert.doesNotMatch(JSON.stringify(out), /SECRET|drop table/);
});

test("the function only reads, and never selects SQL or results", () => {
  const index = read("./index.ts");
  assert.doesNotMatch(index, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.doesNotMatch(index, /payload|switchboard_runs|page_text|captured_text|SUPABASE_DB_URL|select\("\*"\)/);
  assert.match(index, /\.is\("link_used_at", null\)/);
  assert.match(index, /\.eq\("needs_click", true\)/);
});

// s5 (sb3_runner-r4q): a project's live link, as 189 defines one.
const NOW = Date.parse("2026-11-25T12:00:00Z");
const at = (min) => new Date(NOW + min * 60000).toISOString();
const LIVE = [
  { project_code: "aa-a1a", kind: "sf_deploy", status: "link_issued", link_expires_at: at(20), link_used_at: null, chat_url: "https://claude.ai/chat/a" },
  { project_code: "bb-b2b", kind: "sql", status: "link_issued", link_expires_at: at(5), link_used_at: null, chat_url: null },
  // Newer for bb-b2b: the newest wins.
  { project_code: "bb-b2b", kind: "git", status: "link_issued", link_expires_at: at(25), link_used_at: null, chat_url: "https://claude.ai/chat/b" },
  // Not live: expired, used, or no longer link_issued.
  { project_code: "cc-c3c", kind: "sql", status: "link_issued", link_expires_at: at(-1), link_used_at: null, chat_url: null },
  { project_code: "cc-c3c", kind: "sql", status: "link_issued", link_expires_at: at(10), link_used_at: at(-2), chat_url: null },
  { project_code: "cc-c3c", kind: "sql", status: "consumed", link_expires_at: at(10), link_used_at: null, chat_url: null },
  // A project with only a live link still gets a row.
  { project_code: "ee-e5e", kind: "sf_test", status: "link_issued", link_expires_at: at(1), link_used_at: null, chat_url: null },
];

test("live_link: per project, null where none; kind in the panel's words; the newest when there are two", async () => {
  const res = await handle(get({ "x-switchboard-panel-key": KEY }), deps({ liveLinks: async () => LIVE }), NOW);
  const { projects } = await res.json();
  assert.deepEqual(projects["aa-a1a"].live_link, { kind: "deploy", expires_at: at(20), chat_url: "https://claude.ai/chat/a" });
  assert.deepEqual(projects["bb-b2b"].live_link, { kind: "git", expires_at: at(25), chat_url: "https://claude.ai/chat/b" });
  assert.equal(projects["cc-c3c"].live_link, null);
  assert.deepEqual(projects["ee-e5e"], {
    report_unread: false, waiting_on_alex: false, lane: null, lane_order: null,
    live_link: { kind: "deploy", expires_at: at(1), chat_url: null },
  });
  for (const code of Object.keys(projects)) assert.ok("live_link" in projects[code], code);
});

test("live_link: waiting_on_alex is unchanged by it", async () => {
  const plain = await (await handle(get({ "x-switchboard-panel-key": KEY }), deps({ liveLinks: async () => [] }), NOW)).json();
  const live = await (await handle(get({ "x-switchboard-panel-key": KEY }), deps({ liveLinks: async () => LIVE }), NOW)).json();
  for (const code of Object.keys(plain.projects)) {
    assert.equal(live.projects[code].waiting_on_alex, plain.projects[code].waiting_on_alex, code);
    assert.equal(plain.projects[code].live_link, null, code);
  }
  assert.equal(live.projects["ee-e5e"].waiting_on_alex, false);
});

test("live_link: a failed live-link read leaves the other fields as they were, every live_link null", async () => {
  const plain = await (await handle(get({ "x-switchboard-panel-key": KEY }), deps(), NOW)).json();
  const failed = await (await handle(get({ "x-switchboard-panel-key": KEY }),
    deps({ liveLinks: async () => { throw new Error("boom"); } }), NOW)).json();
  assert.deepEqual(failed, plain);
});

test("live_link: no stray field, never the link hash", () => {
  const out = buildPanel({ ...DATA, links: [{ ...LIVE[0], link_hash: "SECRETHASH", payload: { sql: "drop table x" } }] }, NOW);
  assert.doesNotMatch(JSON.stringify(out), /SECRETHASH|drop table/);
  assert.deepEqual(Object.keys(out.projects["aa-a1a"].live_link).sort(), ["chat_url", "expires_at", "kind"]);
});

test("index.ts: the live-link read is 189's live link, and selects no hash", () => {
  const index = read("./index.ts");
  const q = /liveLinks:[\s\S]*?\)\),/.exec(index)?.[0] ?? "";
  assert.match(q, /from\("switchboard_actions", "project_code, kind, status, link_expires_at, link_used_at, chat_url"\)/);
  assert.match(q, /\.eq\("status", "link_issued"\)/);
  assert.match(q, /\.not\("link_hash", "is", null\)/);
  assert.match(q, /\.is\("link_used_at", null\)/);
  assert.match(q, /\.gt\("link_expires_at", /);
  assert.doesNotMatch(index, /select\([^)]*link_hash/);
});

test("config: verify_jwt off, with an empty import map", () => {
  const toml = readFileSync(new URL("../../config.toml", import.meta.url), "utf8");
  const entry = /\[functions\.switchboard-panel\]([\s\S]*?)(\n\[|$)/.exec(toml)?.[1] ?? "";
  assert.match(entry, /^verify_jwt = false$/m);
  assert.match(entry, /functions\/switchboard-panel\/index\.ts/);
  assert.deepEqual(JSON.parse(read("./deno.json")), { imports: {} });
});
