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
                      "record_dj_feedback", "record_dj_artist_tag", "get_dj_artist_tags"]) {
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

test("the tool count is 41 after the tag system", () => {
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
  assert.equal(registered.length, 41,
    `expected 41 registered tools, found ${registered.length}: ` +
    registered.map((r) => r.name).join(", "));
});

test("no duplicate tool names", () => {
  const seen = new Set(), dupes = [];
  for (const r of registered) { if (seen.has(r.name)) dupes.push(r.name); seen.add(r.name); }
  assert.deepEqual(dupes, [], `duplicate registrations: ${dupes.join(", ")}`);
});
