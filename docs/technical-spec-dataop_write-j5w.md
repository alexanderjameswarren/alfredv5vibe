# A2: the production write link, `sf_datawrite` (dataop_write-j5w)

**Path in main:** `C:\Users\Alex\projects\alfred-v5\docs\technical-spec-dataop_write-j5w.md`

Written 2026-11-19 (s2); the Switchboard thread's answers added at s3. Progress:
[progress-dataop_write-j5w.md](progress-dataop_write-j5w.md).

**Status: the migration and its test script are written (s3), not numbered, queued or applied.** Nothing is deployed.

The flow this serves is Data run v2, in `C:\Users\Alex\projects\switchboard\docs\technical-spec-dataop_v2-m5j.md`
(part 5 steps 3 to 6, part 6, "A2"). Its s9, the production runner, waits for this. A1 is
[technical-spec-dataop_link-k7d.md](technical-spec-dataop_link-k7d.md) (`sf_dataquery`, migration 242), with `org_type`
from [technical-spec-dataquery_fixes-v3n.md](technical-spec-dataquery_fixes-v3n.md) (migrations 243, 244). This file
holds only what alfred-v5 builds. The last section, "Contract for Switchboard s9", is what the Switchboard thread
builds against. Every point in it is settled (s3).

## 1. What A2 is

A new action kind, **`sf_datawrite`**: one approval link that runs, in order, from the desktop helper on Alex's PC:

1. **The gate.** Fresh exports, compared on Alex's PC with `manifest.csv` and `before.csv` (for an undo, with
   `after.csv`). Problems stop the run for Alex: stop, or leave the records out (`exclude.csv`).
2. **The write.** The named Batch class (`new <Class>()`), a bulk update, or an undo (a reverse batch). The helper
   asks for Enter before the live write (Switchboard's side). **Uploading `exclude.csv` or the undo Id file is a
   write to production too, so the helper uploads only after Alex's Enter; a declined Enter uploads nothing.**
3. **The after export and the after counts.** The after export feeds step 5, the per-record check, which gives
   PASS or FAIL. The after counts are the rule counts, with their waits.

- Only Alex's click on Approve starts it. The pickup hands it out only within **15 minutes** of that click, and a
  picked run is failed as timed out after **4 hours**, exactly as for `sf_dataquery`.
- **Only counts, the expected and changed numbers, and pass or fail come back to Alfred**, never records. Every
  file stays in the run folder on Alex's PC.
- **The link's arguments** are printed by `sb prod datawrite-link <code> --run <folder> --tag <run tag> [--undo]`
  (Switchboard's s9; it reads files only) and passed to `queue_switchboard_sf_datawrite` verbatim.
- **Undo by link is a reverse batch only** (s10). A bulk undo is on Switchboard's Later list; the payload already
  allows only `{kind: "undo", class, ids_file, ids_sha256}`, a reverse batch class.
- **Sandbox links are accepted** (`org_type: "sandbox"`, the blue banner). `sb rehearse` stays the usual sandbox
  path; a sandbox link is allowed, not required.
- The chat line (Alex, s6) is one of three, returned by the runner as `line` in its `/result` reply and posted by
  the helper exactly as returned:
  - **`datawrite <id> done: PASS`** when `ok` is true and `pass` is true;
  - **`datawrite <id> done: FAIL`** when `ok` is true and `pass` is false;
  - **`datawrite <id> failed`** when `ok` is false, or when the runner refused the report.
- **A stop at the gate** reports `ok: false` with `stage: "gate"`. **A declined Enter** reports `ok: false` with
  `stage: "write"`. In both, nothing is written or uploaded.

### Why a new kind, not a v2 shape of sf_dataop (decided s2)

The pickup knows a helper only by the kinds it lists. Under one kind name a v1 helper can't be told apart from a v2
one, so it could be handed a v2 payload. A new kind is handed out only to a helper that names it.

### v1 keeps working

**`sf_dataop` does not change at all**: its payload check, click check, queue tool, approve page, banner and result
path stay as they are. The six-kind helper (k7d), the five-kind helper (d4x) and the older sets are served exactly as
now, and never handed an `sf_datawrite`. Switchboard's s9 retires v1 on its side; removing `sf_dataop` from alfred-v5
is a later piece, not this one.

## 2. The payload

The action's `project_code` is the data operation's project code (required; none is derived).

```
{
  "alias":            "<org alias>",
  "org_type":         "sandbox" | "production",
  "repo":             "<client checkout, absolute Windows path>",
  "run":              "data-ops/<project code>/<run>",
  "run_tag":          "<project code>-s<n>[letters]-<4 chars>",
  "request_sha256":   "<64 hex: request.json>",
  "selection_sha256": "<64 hex: selection.soql>",
  "object":           "<sObject API name>",
  "problem":          "<the request's problem sentence>",          // optional
  "expected":         <whole number of records the write changes>,
  "write":            { "kind": "batch", "class": "<Class>" }
                    | { "kind": "bulk", "operation": "update", "csv": "<name>.csv", "csv_sha256": "<64 hex>" }
                    | { "kind": "undo", "class": "<Class>", "ids_file": "<name>.csv", "ids_sha256": "<64 hex>" },
  "uploads":          [ { "purpose": "exclude" | "undo-ids", "file": "<name>.csv", "sha256": "<64 hex>", "rows": <n> } ],  // optional
  "queries":          [ { "step": "gate" | "after" | "after-counts",
                          "soql": "<exact SOQL>", "sha256": "<64 hex of soql's UTF-8 bytes>",
                          "file": "<name>.soql" | "label": "<label from request.json>",   // exactly one
                          "wait": { "stable_minutes": <n>, "limit_minutes": <n> } } ]      // after-counts ": wait" only
}
```

### Rules

- **No other keys**, at the top, in `write`, in an upload, in a query or in a wait.
- `alias`, `repo`, `run`, `run_tag`, `file` and `label`: exactly A1's rules (spec k7d part 2). `org_type`: exactly
  `"sandbox"` or `"production"`, **required** (no older rows exist, so the payload function requires it; the guard
  trigger needs no change).
- `request_sha256`, `selection_sha256`, `csv_sha256`, `ids_sha256` and an upload's `sha256`: `^[0-9a-f]{64}$`.
- `object`: `^[A-Za-z][A-Za-z0-9_]{0,79}$`. `problem`: 20 to 600 characters, one line.
- `expected`: an integer from 1 to 999,999,999. Alfred checks only the shape. The helper checks it against the run
  folder: for a batch or bulk write, `manifest.csv`'s row count (Q7), which must also be inside `expectedRange`;
  for an undo, the Id file's row count.
- **`write`**, one of three:
  - `batch`: `class` only (`^[A-Za-z][A-Za-z0-9_]{0,79}$`). Production starts `new <Class>()`, which runs its own
    `SELECTION` (preflight has matched it to `selection.soql`) and reads the exclusion file. No Ids, and no
    `(String, Set<Id>)` start: that constructor is the sandbox rehearsal's only.
  - `bulk`: `operation` exactly `"update"`, and `csv` (`^[A-Za-z0-9_.-]{1,80}\.csv$`, a file in the run folder)
    with `csv_sha256`. The CSV stays on Alex's PC; the hash binds it. **A bulk write
    uploads nothing** (s6b, from the Switchboard thread): records left out at the gate are removed from the CSV on
    Alex's PC before the Bulk API job starts (only their count comes back, as `write.excluded`); failures come from the
    Bulk API job's own failed-records result, kept on his PC (only their count comes back, as `write.failed`);
    `csv_sha256` stays the hash of the CSV as approved. A bulk payload with `uploads`, even empty, is refused: "a bulk
    write uploads nothing; remove uploads."
  - `undo`: a reverse batch. `class` as for batch; `ids_file` (`.csv` file name as above) and `ids_sha256`. The
    helper uploads the Id file as a ContentVersion and the reverse class reads it. `expected` is the Id file's row
    count. It gets the same banner, approval, Enter and counts-only result as a forward write.
- **`uploads`** (optional, 0 to 2): the files known before the run that the run uploads to the org. `purpose`
  `exclude` (an `exclude.csv` already in the run folder) or `undo-ids`; `file` a `.csv` name; `sha256`; `rows`
  1 to 999,999,999. At most one of each purpose. An undo must have exactly one `undo-ids` upload, equal to `write`
  (`file = ids_file`, `sha256 = ids_sha256`, `rows = expected`); no other write may have one. An `exclude` upload's
  `rows` is not compared with `expected` (s11c, from the Switchboard thread): exclude.csv also holds records added at
  the gate, which were never in `expected`, so it may hold more rows than the manifest records it leaves out. An
  `exclude.csv` written at the gate during the run is not in the payload; only the manifest records it leaves out come
  back, as `write.excluded`.
- **The files' titles in the org** (s5, from the Switchboard thread). The batch can't know the action id
  (production starts it as `new <Class>()`, with no arguments), so the files use fixed titles:
  - the exclusion upload is titled `dataop-exclude:<ClassName>`;
  - the undo Id file is titled `dataop-undo:<ClassName>`;
  - the helper refuses to upload if a file with that title already exists, and `sb closeout` deletes them;
  - the failure file the batch writes is titled `dataop-failures:<ClassName>:<18-character job Id>` (s10).
- **`queries`**: 2 to 44, each a query object under A1's rules (sha256 recomputed from the exact bytes; no `;`;
  blank space `[ \t\r\n]` before `SELECT`; exports `SELECT Id …` with no `COUNT(` and at most 100,000 characters;
  counts `SELECT COUNT() FROM <object> WHERE …`, no `GROUP BY`, at most 8,000 characters). Every query belongs to a
  step, the steps come in the order gate, after, after-counts, and **labels are unique within a payload**.
  - **Batch or bulk:**
    - `gate`: 1 or 2 exports. The first is `file: "selection.soql"` with `sha256 = selection_sha256`. The second, if
      any, is labelled: the gate's broad snapshot (`gate: broad snapshot`), or for Fix C the GiftCommitment export
      used to work out expected values.
    - `after`: 1 or 2 labelled exports. **`after: broad snapshot` is required** (the same fields as the before
      broad snapshot, `LastModifiedById` included). **`after: selection`** is optional: `selection.soql` run again,
      so its `sha256` must equal `selection_sha256`. No other label.
  - **Undo:**
    - `gate`: exactly 1 labelled export, a fresh export of the broad snapshot (its label ends `broad snapshot`).
      Every record in the undo Id file must still hold the after values, or the undo stops at the gate.
    - `after`: exactly 1, `after: broad snapshot`.
  - `after-counts`: 0 to 40 counts, the rule counts and their waits, labelled.
  - Exports may name `LastModifiedById` (A1's pattern already allows any field after `Id`).
- **Ids in queries: at most 200 per query** (s10, from the Switchboard thread). The limit exists because a
  Salesforce query can't take a longer Id list; how many Ids Alfred stores is not a concern, and there is no limit
  across the link (the 200,000-character payload limit still applies). A quoted SOQL literal of exactly 15 or 18
  letters and digits counts as an Id (counted conservatively: a non-Id value that looks like one counts too).
  - **May list Ids, at most 200 each:** the gate's `selection.soql`, `after: selection` (the same query), every
    after-count, and every export whose label ends in `broad snapshot` (`gate: broad snapshot`,
    `after: broad snapshot`).
  - **Lists none:** every other export, for example Fix C's `gate: gift commitments`.
  - Fix C passes: its selection names 136 Ids, and 4 of its rule counts name 136 each.
  - At 201 the refusal gives the reason: "the query 'X' lists 201 Ids; a Salesforce query takes at most 200. Select
    by criteria instead, or split the run." An Id where none may go: "the query 'X' lists N Ids; Ids go only in
    selection.soql, "after: selection", an after-count or an export labelled "... broad snapshot". Select by criteria
    instead."
  - A 201-Id `after: selection` is never refused on its own: it is `selection.soql` run again, so `selection.soql`,
    first in the gate, is refused first.
- **`wait`** only on an `after-counts` query whose label ends `: wait`: `stable_minutes` 1 to 60, `limit_minutes`
  1 to 240, and the `limit_minutes` of all waits together at most 180, so the waits fit the 4-hour run limit with
  the gate, the write and the after export. The helper checks them against `request.json` when it rebuilds the
  labelled queries.
- **The whole payload: at most 200,000 characters** as Postgres prints the jsonb (A1's `jsonbTextLength`).
- **Refusals say what to do.** The database's `switchboard_datawrite_payload_problem` returns one sentence for the
  first problem it finds, with the fix where it is obvious, for example: "the query 'gate: broad snapshot' lists
  340 Ids; a Salesforce query takes at most 200. Select by criteria instead, or split the run."
  `switchboard_queue_helper` raises that
  sentence (23514), and the queue tool gives the same sentences.

### Do A1's query rules allow the Id exception? (checked s2)

Yes, as they stand: A1 limits an export's shape and length, not its Ids, so an `Id IN ('…', …)` broad snapshot
passes them, and so does `LastModifiedById` in the field list. What A1 lacks is the per-query limit of 200. A2 adds
the Id count above in its own payload function and its queue tool. A1's `sf_dataquery` is not changed here; giving
it the same limit is a separate fix, if wanted.

## 3. The result

What the helper reports at `/result` for an `sf_datawrite`, and all that Alfred keeps:

```
{ action_id, run_id, ok, summary, exit_code?,
  pass: true | false,                                // required when ok
  datawrite: {
    stage: "gate" | "write" | "after" | "counts" | "done",   // how far it got
    query_counts: [<n>, ...],                        // one per query, in payload order; rows exported or COUNT()
    gate:  { added: <n>, dropped: <n>, edited: <n> },
    write: { expected: <n>, changed: <n>, failed: <n>, excluded: <n> },
    check: { problems: <n>, extras: <n>, new_records: <n> }
  } }
```

- **Allowed fields, and nothing else**: at the top `ok`, `exit_code`, `pass`, `datawrite`; in `datawrite` exactly
  the five keys above; in each of `gate`, `write` and `check` exactly the keys shown. Every `<n>` is an integer from
  0 to 999,999,999; `stage` is one of the five words; `pass` a boolean. There is no free text and no `output`
  field (dropped, as for sf_dataop). So nothing but counts can get through.
- `summary`: one line, at most 300 characters, scrubbed with `blankIds` before it is stored.
- **The meanings:**
  - `write.expected`: must equal the payload's `expected`.
  - `write.changed`: step 5's count of records whose written fields differ between the before and after exports.
    For an undo, the records whose written fields are back to their before values.
  - `write.failed`: the failure file's rows. `write.excluded` (s11c): manifest records the gate left out; records
    added at the gate are left out too but never counted, since they were never in `expected`. It is checked only
    through `changed + failed + excluded = expected`, never against `exclude.csv`'s rows or `uploads`.
  - `gate.added`, `dropped`, `edited`: the gate's findings (Switchboard part 5's local gate).
  - `check.problems`: step 5's problem rows; `check.extras`: its **unexplained** extras only (s10: an extra that step
    5 explains is not counted); `check.new_records`: new in the broad set (for the drift check, not a failure).
- **`pass` comes from step 5 only**, and is true only when step 5 passes **and**
  `changed + failed + excluded = expected`. The database and the runner refuse `pass: true` unless `ok` is true,
  that sum holds and `check.problems = 0`.
- **After counts are reported, never judged**: their numbers are in `query_counts` and nothing in Alfred compares
  them with anything. Diagnosis reads them.
- **When `ok` is true**: `pass` and `datawrite` are required, `stage` is `done`, `gate`, `write` and `check` are
  all present, and `query_counts` has exactly as many entries as the payload has queries (the count match is the
  runner's; the database checks 2 to 44).
- **When `ok` is false** (stopped at the gate, the Enter declined, an error, a timeout): `pass` and `datawrite` may
  be left out. When `datawrite` is sent, `stage` says where it stopped, `query_counts` has at most as many entries
  as queries (the ones that ran, in order), and `gate`, `write` and `check` may each be left out.
- The runner refuses a report that doesn't fit, closes the run as failed saying why, and returns 400, as for
  `sf_dataquery`.
- The run's `result` is `{ ok, exit_code?, pass?, datawrite? }`. Claude reads it with `get_switchboard_run`
  (`run.result.datawrite`, `run.result.pass`), keyed by position to the payload's queries. No new reader.
- **The database check `switchboard_runs_datawrite_result` is keyed on `datawrite`**, so it constrains any result
  that carries it. 242's `switchboard_runs_dataquery_result` is keyed on a top-level `query_counts`, which an
  sf_datawrite result never has.

## 4. The approve page

`src/switchboard/ApprovePage.jsx`, a new `DatawriteRun` section, shown for `kind = sf_datawrite`:

- **The banner, from `org_type`:**
  - `production`: orange (`bg-orange-400 text-black`), **"Production, changes live records"**
    (`approve-production-write`).
  - `sandbox`: blue (`bg-sky-700 text-white`), **"Sandbox, changes records"** (`approve-sandbox-write`). Never says
    production.
- **The count, plainly:** "This run changes live records: about to change **N** live records of `<object>`"
  (sandbox: "N records in the sandbox"), with N from `expected`.
- **The org, object, problem, repo and run folder, run tag**, and the request and selection hashes (short and full).
- **The write in full:**
  - batch: "Batch Apex `new <Class>()`: runs its own SELECTION, which preflight matched to selection.soql
    (`<short selection hash>`), and skips the exclusion file's records".
  - bulk: "Bulk update from `<csv>` (`<short hash>`)".
  - undo: "Undo: reverse batch `<Class>` reading `<ids_file>` (`<short hash>`, N rows)".
- **The three stages in order**, each with its queries in full: step, file or label, SHA-256 (short and full), the
  wait's minutes, and the SOQL in a preformatted block that wraps and is never cut, rendered as text. **Any query
  that lists Ids** (s10: selection.soql, after: selection, an after-count or a broad snapshot) says how many: "This
  query lists N record Ids." (N by the same count as the payload rule).
- **Files the run uploads to the org, after your Enter** (batch and undo): each `uploads` entry (purpose, file, short
  hash, rows); "exclude.csv, if you leave records out at the gate", shown only when there is no `exclude` upload, so
  exclude.csv appears once (s6b); and "**creates** the failure file, a ContentVersion titled
  `dataop-failures:<ClassName>:<18-character job Id>`" with the write's real class name (s10).
  Then: "Deleting these files is `sb closeout`, in your terminal".
- **A bulk write** (s6b): the section is titled "Records left out at the gate" and says only "Records left out at the
  gate are removed from the CSV before the write." No upload, failure-file or leftover-file line.
- **The fixed titles, in full (s6):** the page shows `dataop-exclude:<ClassName>` and, for an undo,
  `dataop-undo:<ClassName>`, with the write's real class name, and says: "A file with this title left over from a run
  that wasn't closed out makes the helper refuse to upload; `sb closeout` clears it."
- "The helper asks for Enter before the live write and before any upload." For a sandbox it says "before the write"
  (s6b), and for a bulk write it leaves out "and before any upload".
- The chat line is `datawrite <action id> done: PASS`, `… done: FAIL` or `… failed` (part 1).
- A dev-only fixture at `/approve-fixture/sf_datawrite`: production batch, sandbox bulk, production undo, and
  (s10) `?sample=ids`, a batch whose selection, after: selection and two counts each list 136 Ids.
- Every other kind's banner, sf_dataop's included, is unchanged.

## 5. Parts and files

### Database (one migration, `supabase/migrations/_pending_dataop_write-j5w_sf_datawrite.sql`, numbered at s7)

- `switchboard_actions`:
  - the kind check takes `sf_datawrite`;
  - a new payload check `switchboard_actions_sf_datawrite_payload`, calling `switchboard_datawrite_payload_ok`,
    coalesced to false;
  - a new click check `switchboard_actions_sf_datawrite_click`: `kind <> 'sf_datawrite' or needs_click`.
- **New function `switchboard_datawrite_payload_problem(jsonb, text) returns text`** (payload, project code), stable,
  never raises: all of part 2. It returns null for a payload that passes, or one sentence saying what is wrong and
  what to do.
- **New function `switchboard_datawrite_payload_ok(jsonb, text) returns boolean`**: the problem is null. Used by
  the check.
- Both: revoked from public and anon, execute to authenticated and service_role.
- `switchboard_runs`: the result check `switchboard_runs_datawrite_result` (part 3).
- `switchboard_needs_click`: `sf_datawrite` always true.
- `switchboard_queue_helper`: accepts `sf_datawrite`; needs the project code; raises the payload's problem sentence
  (23514) before inserting.
- `switchboard_pickup_helper`: `c_all` and `c_prod` gain `sf_datawrite`, so the 15-minute click rule and the
  "only consumed by its link" rule cover it, and so does the one-running-per-project rule. The default kinds stay
  the four, and the six-kind list never includes it.
- The payload column's comment gains the kind. `switchboard_stakes`, `switchboard_issue_link` and
  `switchboard_actions_guard` are unchanged.
- No new table or view, so no `register_table`. Every replaced function keeps its signature and grants. It ends
  with `select public.platform_check_conformance()`, and the block is closed with `check_platform_conformance`.
- Test script: `supabase/tests/dataop_write-j5w/1_verify_sf_datawrite.sql`, run with `--test`. It returns its checks
  as a result row from a block that undoes itself.

### Queue tool (`supabase/functions/_shared/tools/switchboard.ts`, registered in `mcp/index.ts`)

`queue_switchboard_sf_datawrite`, tier 2, tables `{ reads: ["switchboard_actions", "switchboard_settings"],
writes: ["switchboard_actions"] }`. It checks part 2 rule for rule with the database function (the same patterns,
`char_length`, each SHA-256 recomputed, the same Id count, `jsonbTextLength`, the same sentences), queues it through
`switchboard_queue_helper` and issues the link. The arguments are what sb prints, verbatim. Headline:
`PRODUCTION DATA WRITE <code> ON <alias>: ABOUT TO CHANGE <n> LIVE RECORDS OF <object> BY BATCH <Class>`
(`BY BULK UPDATE`, `BY UNDO <Class>`; `SANDBOX DATA WRITE …` for a sandbox).

### Runner (`supabase/functions/switchboard-runner/core.ts`, `index.ts`)

- `HELPER_KINDS` gains `sf_datawrite` (seven). The pickup serves exactly: git alone; all seven (passed as
  `p_kinds`); the six of k7d (passed as `p_kinds`, never handed an sf_datawrite); the five of d4x; the older four
  and three.
- `LONG_PICK_KINDS` gains `sf_datawrite` (the 4-hour limit).
- `/result` for `sf_datawrite`: part 3, by a `datawriteReportProblem` beside A1's `dataqueryReportProblem`.

### Approve page (`src/switchboard/ApprovePage.jsx`, `ApproveFixture.jsx`)

Part 4.

### Skills

- `.claude/skills/cli-workflow/SKILL.md`, "Salesforce data runs" and the result lines: the `datawrite <id>` line,
  and the v2 write link beside v1's `dataop` link until s9 retires v1.
- `.claude/skills/salesforce-workflow/SKILL.md`, rule 1 and the data operations section: the production write
  starts only from an `sf_datawrite` link (v2) or an `sf_dataop` link (v1, until s9).

### Tests

- `switchboard.test.mjs`: every payload rule (each write kind, uploads, the per-query Id limit, waits, the 200,000 cap) and
  its sentence, the headline. `mcp/index.test.mjs`: the schema.
- `core.test.mjs`: the seven-kind pickup, the six never handed an sf_datawrite, the 4-hour limit, every result rule.
- `ApprovePage.test.jsx`, `ApproveFixture.test.jsx`: both banners, the count line, the three writes, uploads, the
  Id line, sf_dataop's banner unchanged.
- The `--test` script: every payload rule, the sentences, the result check, needs_click, the pickup (the six-kind
  call never gets one; the 15-minute rule), sf_dataop and sf_dataquery rows still valid, the grants.

## 6. Database items, by step

| Item | Step |
|---|---|
| db:table:switchboard_actions, db:table:switchboard_runs | s7 |
| db:fn:switchboard_datawrite_payload_problem (new), db:fn:switchboard_datawrite_payload_ok (new) | s7 |
| db:fn:switchboard_needs_click, db:fn:switchboard_queue_helper, db:fn:switchboard_pickup_helper | s7 |
| db:deploy (mcp, switchboard-runner) | s7 |
| db:table:switchboard_actions, db:fn:switchboard_datawrite_payload_problem, db:deploy (mcp): the s10 Id rule, `_pending_dataop_write-j5w_ids_rule.sql` | s11 |

## 7. Compatibility

- Every existing kind, link and run stays valid: the checks only add a kind, and the new result check only
  constrains a result that has `datawrite`, which no existing run has. The test script proves it at s7.
- Until Switchboard's helper and extension add the kind, nothing should be queued as `sf_datawrite`. An older
  helper is never handed one, and the extension shows an unknown `kind=` as sql on the tile.

## 8. Contract for Switchboard s9

**Kind:** `sf_datawrite`. **Chat line**, the `line` field of the runner's `/result` reply, which the helper posts
exactly as returned: `datawrite <action id> done: PASS` (ok and pass true), `datawrite <action id> done: FAIL` (ok
true, pass false), or `datawrite <action id> failed` (ok false, or the report refused). Handed out
only to a helper whose `kinds` list includes it (all seven: git, sf_check, sb_setup, sf_read, sf_dataop,
sf_dataquery, sf_datawrite); the six-kind list is still served without it. Only after Alex's click; picked up
within 15 minutes of the click or failed unrun; a picked run times out after 4 hours.

**Payload** (no other keys at any level; at most 200,000 characters as Postgres prints the jsonb):

| Field | Type | Required | Rule |
|---|---|---|---|
| `alias` | string | yes | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$` |
| `org_type` | string | yes | `"sandbox"` or `"production"` |
| `repo` | string | yes | absolute Windows path, no `..`, at most 240 characters (as sf_dataquery) |
| `run` | string | yes | `data-ops/<project code>/<one folder [A-Za-z0-9_.-]{1,80}>`, `/` or `\`, no `..` |
| `run_tag` | string | yes | `<project code>-s<digits>[a-z]*-<4 [a-z0-9]>`, at most 60 |
| `request_sha256` | string | yes | 64 lower-case hex, of request.json |
| `selection_sha256` | string | yes | 64 lower-case hex, of selection.soql |
| `object` | string | yes | `^[A-Za-z][A-Za-z0-9_]{0,79}$` |
| `problem` | string | no | one line, 20 to 600 characters |
| `expected` | integer | yes | 1 to 999,999,999; manifest rows (batch, bulk) or the Id file's rows (undo), checked by the helper |
| `write` | object | yes | one of: `{kind:"batch", class}`; `{kind:"bulk", operation:"update", csv, csv_sha256}`; `{kind:"undo", class, ids_file, ids_sha256}`. `class` `^[A-Za-z][A-Za-z0-9_]{0,79}$`; `csv`, `ids_file` `^[A-Za-z0-9_.-]{1,80}\.csv$`; hashes 64 hex |
| `uploads` | array | no | 0 to 2 of `{purpose:"exclude"\|"undo-ids", file, sha256, rows}`, one per purpose, `rows` 1 to 999,999,999; an undo has exactly one `undo-ids` equal to `write` (file, sha256, rows = expected), no other write has one; an `exclude` upload's rows are not compared with expected (s11c). **Never on a bulk write**, not even empty: "a bulk write uploads nothing; remove uploads." An exclude.csv written at the gate during the run is not in the payload (its rows come back as `write.excluded`). The helper uploads only after Alex's Enter |
| `queries` | array | yes | 2 to 44 of `{step, soql, sha256, file \| label, wait?}`, A1's rules, steps in the order gate, after, after-counts, labels unique within the payload. Batch or bulk: `gate` 1–2 exports, the first `file:"selection.soql"` with sha256 = selection_sha256, the second labelled; `after` 1–2 exports labelled `after: broad snapshot` (required) and `after: selection` (optional, sha256 = selection_sha256). Undo: `gate` exactly 1 export labelled `… broad snapshot`; `after` exactly `after: broad snapshot`. `after-counts` 0–40 counts |
| `queries[].wait` | object | no | only on an `after-counts` query labelled `…: wait`: `{stable_minutes 1–60, limit_minutes 1–240}`; all limit_minutes together at most 180; the helper checks them against request.json |

**Ids in queries (s10):** a quoted literal of exactly 15 or 18 letters and digits counts as an Id. A Salesforce query
takes at most 200 listed Ids, so `selection.soql`, `after: selection`, every after-count and every export labelled
`… broad snapshot` may list up to 200 each. Every other export lists none. There is no limit across the link; the
200,000-character payload limit still applies. 201: "the query 'X' lists 201 Ids; a Salesforce query takes at most
200. Select by criteria instead, or split the run."

**Link arguments:** `sb prod datawrite-link <code> --run <folder> --tag <run tag> [--undo]` prints them; Claude passes
them to `queue_switchboard_sf_datawrite` verbatim. Undo by link is a reverse batch only (a bulk undo is on
Switchboard's Later list). A sandbox link (`org_type: "sandbox"`) is accepted; `sb rehearse` stays the usual sandbox
path.

**Result** at `/result` (only these keys; every count an integer 0 to 999,999,999; no `output`; the `summary` one
line, at most 300 characters, Id- and email-scrubbed):

| Field | Type | When |
|---|---|---|
| `ok` | boolean | always |
| `exit_code` | integer | optional |
| `pass` | boolean | required when ok. Step 5 only; true only when ok, step 5 passes, `changed + failed + excluded = expected` and `check.problems = 0` |
| `datawrite.stage` | `gate`, `write`, `after`, `counts` or `done` | required with `datawrite`; `done` when ok; where it stopped when not |
| `datawrite.query_counts` | integer[] | one per payload query in order when ok; at most that many, in order, when not. After counts are reported, never judged |
| `datawrite.gate` | `{added, dropped, edited}` | required when ok |
| `datawrite.write` | `{expected, changed, failed, excluded}` | required when ok. `expected` = payload's; `changed` = step 5's records whose written fields differ before to after (undo: back to their before values); `failed` = the failure file's rows; `excluded` = manifest records the gate left out; records added at the gate are left out too but never counted, since they were never in expected |
| `datawrite.check` | `{problems, extras, new_records}` | required when ok. Step 5's problems; its unexplained extras only (an explained extra isn't counted); new records in the broad set |

When `ok` is false, `pass` and `datawrite` may be left out, and so may any of `gate`, `write` and `check`. A report
that doesn't fit is refused (400) and the run closed as failed with the reason. **A gate stop** reports `ok: false`,
`stage: "gate"`; **a declined Enter** `ok: false`, `stage: "write"`; in both, nothing is written or uploaded.

**Uploads and created files** (batch and undo): the page lists each `uploads` entry, "exclude.csv, if you leave
records out at the gate" (only when there is no `exclude` upload), and "creates the failure file, a ContentVersion
titled `dataop-failures:<ClassName>:<18-character job Id>`". Every upload happens only after Alex's Enter. Deleting them is `sb closeout` in Alex's
terminal; there is no link for it.

**A bulk write uploads nothing.** Records left out at the gate are removed from the CSV on Alex's PC before the Bulk
API job starts, and only their count comes back (`write.excluded`). Failures come from the Bulk API job's own
failed-records result, kept on his PC, and only their count comes back (`write.failed`). `csv_sha256` stays the hash of
the CSV as approved. The page says "Records left out at the gate are removed from the CSV before the write." and shows
no file lines.

**The files' titles in the org:** the batch can't know the action id (production starts it as `new <Class>()`), so:
- the exclusion upload is titled `dataop-exclude:<ClassName>`;
- the undo Id file is titled `dataop-undo:<ClassName>`;
- the helper refuses to upload if a file with that title already exists, and `sb closeout` deletes them;
- the failure file is titled `dataop-failures:<ClassName>:<18-character job Id>`.

The page shows the fixed titles in full, with the write's class name, and says that a file left over from a run that
wasn't closed out makes the helper refuse; `sb closeout` clears it.
