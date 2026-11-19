# A1: the production export and count link (dataop_link-k7d)

**Path in main:** `C:\Users\Alex\projects\alfred-v5\docs\technical-spec-dataop_link-k7d.md`

Written 2026-11-19 (s2). Progress: [progress-dataop_link-k7d.md](progress-dataop_link-k7d.md).

**Status: built and live, 2026-11-19.**
- **Migration 242** (`supabase/migrations/242_sf_dataquery.sql`) is applied as run c970c51b-77d8-4c28-ba01-d946df57db83:
  every statement ok, CONFORMANT (119 tables).
- **Verification** (`supabase/tests/dataop_link-k7d/1_verify_sf_dataquery.sql`, --test) passed 87 of 87, as run
  b57ae375-b52f-4705-b218-45c217c85098.
- **Deployed:** mcp (with `queue_switchboard_sf_dataquery`) and switchboard-runner. An unauthenticated /queue gives 401.
- **Checkpointed** to main as ede8d05: the migration, the test script and the function files.
- **The approval page and its dev fixture** reach main with the Finish.

The flow this serves is Data run v2, in `C:\Users\Alex\projects\switchboard\docs\technical-spec-dataop_v2-m5j.md`
(its "A1 contract", part 10, plus parts 4 to 6). This file holds only what alfred-v5 builds. Where the two differ on
alfred-v5's side, this file wins; the differences are listed under "Open points for the Switchboard thread".

## 1. What A1 is

A new action kind, **`sf_dataquery`**: one approval link that lets one or more production **bulk exports** or one or
more production **`SELECT COUNT()` queries** run from the desktop helper on Alex's PC.

- Only Alex's click on Approve starts it, and the pickup only hands it out within 15 minutes of that click, exactly
  as for `sf_dataop`.
- The exported CSVs stay in the run folder on Alex's PC. **Only whole-number counts and a PASS/FAIL come back to
  Alfred**, never rows, Ids or field values.
- Steps covered: `manifest`, `before` and `undo` (exports); `preflight-counts` and `rules` (counts). `gate`, `after`
  and `failures` are not built here (part 8).
- **`undo`** (Alex, s4): Data run v2's undo takes a fresh export of the written records, selected by the selection
  query, not by Id, so it can skip any record changed since the run. It is an export like the others.

**`sf_dataop` is untouched by A1.** Its payload change (the request.json and selection.soql hashes, the run folder,
the gate's SOQL) is **A2**, a separate alfred-v5 piece built after A1, once the Switchboard thread has settled its
production runner's shape. A2 must land before that runner step in dataop_v2-m5j. The Switchboard thread records A2
and its timing in its own spec; nothing for A2 is designed here.

A2's write link covers gate, write, after export and after counts under one approval, so a run needs no extra click
after the write (from the Switchboard thread, dataop_v2-m5j).

## 2. The payload

The action's `project_code` column is the data operation's project code (required; none is derived). The payload:

```
{
  "alias":   "<production org alias>",
  "repo":    "<client checkout, absolute Windows path>",         // as sf_dataop's repo
  "run":     "data-ops/<project code>/<run>",                   // the run folder, relative to repo
  "run_tag": "<project code>-s<n>[letters]-<4 chars>",           // the CLI step that asked for the link
  "request_sha256": "<64 hex>",                                  // required when any query has a label
  "queries": [                                                   // 1 to 40
    { "step": "manifest" | "before" | "undo" | "preflight-counts" | "rules",
      "soql": "<exact SOQL text>",
      "sha256": "<64 hex: SHA-256 of soql's UTF-8 bytes>",
      "file":  "<file name in the run folder, e.g. selection.soql>"      // exactly one of file and label
      "label": "<rule or count label from request.json>" }
  ]
}
```

Rules on the shape:
- No other keys, at the top or in a query.
- `repo`: the same pattern as sf_dataop's (absolute, no `..`, at most 240 characters).
- `run`: `data-ops`, then the action's own project code, then one folder name (`[A-Za-z0-9_.-]{1,80}`), separated
  by `/` or `\`, no `..`.
- `run_tag`: the action's project code, then `-s`, then `[0-9]+[a-z]*-[a-z0-9]{4}` (234's chained-send pattern),
  at most 60 characters.
- `file`: one file name, `[A-Za-z0-9_.-]{1,80}\.soql`, no folder.
- `label`: one line, 1 to 200 characters. Labels are unique within a link.
- **A link is all exports or all counts.** Exports: every step is `manifest`, `before` or `undo` (Q2's read link
  carries the first two). Counts: every step is `preflight-counts`, or every step is `rules` (one round per link).

## 3. The SHA-256, and how a query is tied to its source

`sha256` is always the SHA-256 of the **exact bytes of `soql`** (UTF-8, nothing trimmed or normalised). So:
- the database checks it on insert (`sha256(convert_to(soql, 'UTF8'))`), and the queue tool checks it first to
  refuse with a reason;
- the helper checks it again before running anything.

The source of each query is bound on Alex's PC, by the helper, before anything runs:
- **`file`** (a query that is a file word for word, e.g. the manifest's `selection.soql`): the helper reads
  `<repo>\<run>\<file>` and refuses unless its SHA-256 equals `sha256`. The file's bytes are the SOQL.
- **`label`** (a query sb builds from `request.json`: a rule's count, its wait, its "new since the freeze" count,
  the broad snapshot's count or export, the selection's count): Alfred cannot verify these against a file, because
  the text is derived, not stored. The payload carries `request_sha256`; the helper refuses unless
  `<repo>\<run>\request.json` hashes to it, then rebuilds the query for that label from the request and refuses
  unless it equals `soql` byte for byte. Alfred's part is the shape and the SOQL's own hash; the binding to the
  request is the helper's.

## 4. Safety limits

Enforced in the database's payload check and again in the queue tool (payload), and in the database's run-result
check and again in switchboard-runner (results).

| Limit | Value |
|---|---|
| Queries per link | 1 to 40 |
| Any SOQL | no `;` anywhere |
| Leading blank space | spaces, tabs and newlines (`[ \t\r\n]`, exactly) may come before `SELECT`; the sha256 still covers them, byte for byte. Nothing else may: a comment first is refused |
| A count query | starts `SELECT COUNT() FROM <object> WHERE` (case-insensitive, sb's own rule pattern); no `GROUP BY`; at most 8,000 characters |
| An export query | starts `SELECT Id` followed by `,` or ` FROM`; no `COUNT(`; at most 100,000 characters (the SOQL limit) |
| The whole payload | at most 220,000 characters as Postgres prints the jsonb (two full-size exports plus the rest; sf_dataop's 16,000 can't hold them) |
| Click | `needs_click` always true, and a check constraint holds it, as for sf_dataop |
| Pickup window | unchanged: handed out only consumed by the click, within 15 minutes of it; past that it fails unrun, with a run saying why (sf_dataop's O6 rule, extended to this kind) |
| A picked run's limit | 4 hours (an export can run that long), as sf_dataop's; then it is failed as timed out |

**Counts only.** The 8,000-character count limit allows an Id list at the 200-Id cap (about 21 characters each,
about 4,200 characters) and stays under the ~16,000-character REST URL limit once encoded. sb's own rule limit stays
4,000; Alfred's is the outer bound.

**No grouped counts.** Every rule count in the v2 request is a single `SELECT COUNT()` (the request schema's
`"soql": "SELECT COUNT() FROM ... WHERE ..."`, "One `SELECT COUNT()` per rule", and sb's `COUNT` pattern, which takes
no GROUP BY; each rule has one `goal` number). So `GROUP BY` is not allowed. If a grouped rule is ever added, it is a
change to this contract.

## 5. Results

What the helper reports at `/result` for an `sf_dataquery`, and all that Alfred keeps:

```
{ action_id, run_id, ok, summary, exit_code?,
  query_counts: [<whole number>, ...],   // one per query, in the payload's order; rows exported, or the COUNT()
  pass: true | false }                   // sb's verdict for the step; required when ok
```

- **`query_counts`, not `counts`** (s3): an sql run's result already stores its own `counts`, so the name is new.
- `query_counts` must have exactly as many entries as the payload has queries, each an integer from 0 to
  999,999,999. When `ok` is false it may be left out (a run that failed part way reports nothing partial).
- `output` is dropped, as for sf_read and sf_dataop.
- `summary` (one line, at most 300 characters) is scrubbed with `blankIds` before it is stored.
- The run's `result` is `{ ok, exit_code?, query_counts, pass }`.
- **The database check is keyed on `query_counts`** (`switchboard_runs_dataquery_result`). A CHECK can't see the
  action's kind, so it constrains any result that carries `query_counts`: only ok, exit_code, query_counts (1 to 40
  whole numbers) and pass (boolean, required when ok). **switchboard-runner must therefore always write
  `query_counts` for an sf_dataquery that succeeded**, matched to the payload by position, and nothing else beside it.
- Claude reads them with `get_switchboard_run` (`run.result.query_counts` and `run.result.pass`), keyed by position
  to the action's payload. No new reader, table or view.

**A count can still carry information.** A `COUNT()` with a narrow WHERE is a yes/no answer about the data. That is
accepted because Alex reads every query in full on the approval page before it runs, and the 40-query cap bounds
how much one link can ask.

## 6. Parts and files

### Database (one migration, `_pending_dataop_link-k7d_sf_dataquery.sql`, numbered at s7)

- `switchboard_actions`:
  - the kind check takes `sf_dataquery`;
  - a new payload check `switchboard_actions_sf_dataquery_payload`, all of part 2 to 4, coalesced to false;
  - a new click check: `kind <> 'sf_dataquery' or needs_click`.
- **New function `switchboard_dataquery_payload_ok(jsonb, text) returns boolean`** (the payload and the action's
  project code), **stable, not immutable** (`convert_to` is stable): the per-query checks, including each SHA-256,
  which a CHECK can't do with a subquery. It never raises. Grants: revoked from public and anon, execute to
  authenticated and service_role.
- `switchboard_runs`: the result check of part 5, keyed on `query_counts`.
- `switchboard_needs_click`: `sf_dataquery` is always true.
- `switchboard_queue_helper`: accepts `sf_dataquery`; needs the project code.
- `switchboard_pickup_helper`: `c_all` gains `sf_dataquery`; the default stays the four kinds; the 15-minute
  click rule and the "only consumed by its link" rule apply to `sf_dataquery` as to `sf_dataop`.
- `switchboard_stakes` and `switchboard_issue_link` are unchanged (stakes is change; the url carries
  `kind=sf_dataquery`).
- The payload column's comment gains the kind. It ends with `select public.platform_check_conformance()`.
- No new table or view, so no `register_table`.
- Test script: `supabase/tests/dataop_link-k7d/1_verify_sf_dataquery.sql`, run with `--test`.

### Queue tool (`supabase/functions/_shared/tools/switchboard.ts`, registered in `mcp/index.ts`)

`queue_switchboard_sf_dataquery`, tier 2, tables `{ reads: ["switchboard_actions", "switchboard_settings"],
writes: ["switchboard_actions"] }`. It checks the payload (part 2 to 4) with a reason per refusal, queues it through
`switchboard_queue_helper`, and issues the link. Its rules are the database function's, rule for rule, so the two
can't disagree: the same patterns (blank space as `[ \t\r\n]`, not `\s`), lengths in code points (`char_length`),
each SHA-256 recomputed, and the payload length as Postgres prints jsonb. The arguments are what sb prints, verbatim. Headline:
`PRODUCTION EXPORT <code> ON <alias>: <n> QUERIES (<steps>)` or `PRODUCTION COUNTS <code> ON <alias>: <n> QUERIES
(<step>)`.

### Runner (`supabase/functions/switchboard-runner/core.ts`, `index.ts`)

- `HELPER_KINDS` gains `sf_dataquery`. The pickup serves exactly: git alone; all six (passed as `p_kinds`); the
  five of dataops_alfred-d4x (passed as `p_kinds`, so still handed an sf_dataop and never an sf_dataquery); and the
  older four and three (no `p_kinds`, as now).
- The 4-hour pick limit covers `sf_dataquery` (`stalePicks` in index.ts).
- `/result` for `sf_dataquery`: part 5. The helper sends `query_counts`; the runner refuses a report whose count of
  entries differs from the payload's queries.

### Approval page (`src/switchboard/ApprovePage.jsx`, `ApproveFixture.jsx`)

- The orange PRODUCTION banner, worded for a read: "Production, read only".
- The alias, repo and run folder, the run tag, and the step(s).
- Each query in full, in order: its step, its file or label, its SHA-256 (short and full), and the SOQL in a
  preformatted block that wraps and is never cut. Rendered as text, never as HTML.
- The chat line is `dataquery <action id>`; its line word is the Switchboard thread's to fix (part 8).
- A dev-only fixture at `/approve-fixture/sf_dataquery`, one export link and one count link.

## 7. Compatibility

- Every existing kind, link and run stays valid: the checks only add a kind, and the runs check only constrains a
  result that has `counts` or `pass`, which no existing run has. The test script proves it at s7.
- A helper of today (five kinds) keeps working and is never handed an `sf_dataquery`.
- Until the Switchboard thread's s4 adds the kind, the extension maps an unknown `kind=` to `sql` on the tile;
  nothing should be queued for `sf_dataquery` before then.

## 8. Open points for the Switchboard thread

- **No sf_dataquery link should be queued until the helper and the extension handle the kind** (dataop_v2-m5j's s4).
  The runner serves today's five-kind helper as before, and it never hands that helper an sf_dataquery. The extension
  shows an unknown `kind=` as sql on the tile.
- **Export queries must start with `SELECT Id`.** Blank space (spaces, tabs, newlines) is allowed before it; a comment
  is not. They take no `COUNT(`.
- **Count queries must be `SELECT COUNT() FROM <object> WHERE ...`**, with the same leading blank space allowed and no
  GROUP BY.

- **gate and after** run under the write link (Q2), so they are not `sf_dataquery` steps. They belong with A2.
- **failures** is a ContentVersion download, not an export, so it is not an `sf_dataquery` step.
- **The step is per query**, not one per link, because Q2's read link carries both `manifest` and `before`.
- **Derived queries need labels** sb gives them: the rule's label for its count, and fixed names such as
  `<label>: wait`, `<label>: new since the freeze`, `broad snapshot`, `selection count`. sb and the helper must
  rebuild each one from `request.json` byte for byte (part 3).
- **A rule's wait** is a count the helper may run repeatedly until it settles; its count is the settled value.
- **The run folder** is checked as `data-ops/<the action's project code>/<run>`; if `<code>` there is ever not the
  project code, this check changes.
- **Switchboard files** for the kind (its s4): helper/lib/core.mjs (kinds, plan, and a pickup fallback of six, then
  five, then four kinds), helper/export-window.mjs, extension/lib/bridge-core.js, extension/claude-watch.js,
  extension/bridge.js, panel/bridge/host.mjs, panel/lib/status.ahk, and an sb command that prints the queue tool's
  arguments (sb/lib/prodrun.mjs, sb/sb.mjs).
