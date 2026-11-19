# Technical spec: dataquery_fixes-v3n

Two fixes to the `sf_dataquery` link kind, which dataop_link-k7d built (migration 242, live since main 0411809). The
contract it extends is [technical-spec-dataop_link-k7d.md](technical-spec-dataop_link-k7d.md). The Switchboard side
is dataop_v2-m5j (`C:\Users\Alex\projects\switchboard\docs\technical-spec-dataop_v2-m5j.md`).

Progress: [progress-dataquery_fixes-v3n.md](progress-dataquery_fixes-v3n.md).

## Fix 1: repair a lost run (one-off data repair)

Action `7fc72d51-bf6d-44a6-b98d-86efee63af24` (sf_dataquery, project dataop_v2-m5j, alias actblue) was clicked at
19:42:33Z and picked up at 19:45:07Z on 2026-11-19. Its window was then closed before it finished, so the helper never
posted `/result`. Its run `9ab19061-25c1-4f7a-a2c7-0088ac3e97ae` stayed open. `switchboard_pickup_helper` hands out
nothing for a project while one of its actions is picked and unfinished, so every dataop_v2-m5j link was held until
switchboard-runner's 4-hour stale limit (about 23:45Z).

The repair is two guarded updates, queued with `--expect 1,1`:

- `switchboard_actions`: status `failed`, only while that row is still an sf_dataquery, `consumed`, and picked.
- `switchboard_runs`: summary `lost: its window was closed before it finished`, result `{"ok": false, "lost": true}`
  (Decision 1: like the runner's own `timed_out` runs), and `finished_at = now()`, only while it is that action's real
  run and still open.

**Side effects.** None fire. No trigger or function turns a failed action into a chat line, a signal or a
notification. The chat line comes only from the helper, after its own `/result` is accepted. The audit trigger on
`switchboard_actions` logs the change; `switchboard_runs` is not audited. `switchboard_actions_guard` allows a status
change. The row still meets `switchboard_actions_sf_dataquery_payload`, which is re-checked on update.

**Races.** Something else may close the run before the repair is approved: the runner's stale limit, or the helper's
`lostRunReport` (dataop_v2-m5j s6c) on its next start. Then both updates touch 0 rows, the count check fails and
Approve stays disabled. Nothing is overwritten. A later `/result` for this run gets 409 ("no longer waiting").

## Fix 2: org type on the approve page

Until now the page said "PRODUCTION, READ ONLY" for every sf_dataquery, sandbox links (e.g. actblue) included.

### Payload

A new field, `org_type`, exactly `"sandbox"` or `"production"`. sb fills it from orgs.json, and the helper refuses a
link whose type doesn't match the org (dataop_v2-m5j s8). The name and the values are agreed with that thread.

- **The queue tool** (`queue_switchboard_sf_dataquery`, `supabase/functions/_shared/tools/switchboard.ts`,
  `sfDataqueryPayload`) requires it. A missing value is refused with a clear message, and so is any other value. It
  joins `DATAQUERY_KEYS`. Its schema in `supabase/functions/mcp/index.ts` gains
  `org_type: z.enum(["sandbox", "production"])`.
- **The database** (Decision 2):
  - `switchboard_dataquery_payload_ok` adds `org_type` to its allowed keys. It accepts the field missing, and it
    rejects any value other than the two strings, or a value that isn't a string. It must allow the field to be
    missing. A CHECK is re-run on every UPDATE, so a function that required the field would block every status
    change on the rows from before this project (3 at s1, the repaired one included).
  - `switchboard_actions_guard`, in its INSERT branch only, refuses a new `sf_dataquery` without a valid `org_type`
    (errcode 23514, with a message naming the field). This covers `switchboard_queue_helper` and any direct insert.
    Updates and every other kind are unchanged.
  - The column comment on `switchboard_actions.payload` names `org_type`.
  - Explicit grants stay as they are (both functions keep their signatures). The migration ends with
    `platform_check_conformance()`, and the block is closed with `check_platform_conformance`.

### Headline

`sfDataqueryHeadline` starts with `SANDBOX` or `PRODUCTION`, from `org_type`: for example
`SANDBOX COUNTS <code> ON actblue: 3 QUERIES (rules), READ ONLY` and `PRODUCTION EXPORT <code> ON cd-prod: …`.

### Approve page (`src/switchboard/ApprovePage.jsx`)

- `org_type` production: the orange banner as today (`bg-orange-400 text-black`), with the text "Production, read only".
- `org_type` sandbox: a clearly different banner, with the text "Sandbox, read only". It is not orange and not red,
  for example teal or blue with white text. It keeps the size and the mode line (Bulk exports or Counts), and has its
  own test id.
- No `org_type` (rows from before this project): the orange PRODUCTION banner, plus a line saying
  "org type not recorded". This is the louder, safe side. Links last 30 minutes, so this is rare. The headline is
  stored text, so those rows keep their "PRODUCTION …" headline.
- The banners for sf_dataop (`approve-production`), sf_read (`approve-production-full-data`), and every other kind,
  stay unchanged.
- The tool's description and its `next` text say the page shows a PRODUCTION or SANDBOX banner from org_type.
- The dev fixture (`ApproveFixture.jsx`) gains a sandbox sample.

### Out of scope

- Fix 3 (Decision 3): a picked data action still holds back that project's git links. That rule, and any change to
  `switchboard_pickup_helper` or `switchboard_pickup_git`, belong to dataop_v2-m5j, as a later combined change.
- Switchboard's side of org_type (sb and the helper) is dataop_v2-m5j s8.

## Database items, by step

| Item | Step |
|---|---|
| db:table:switchboard_actions, db:table:switchboard_runs | s2 (the repair) |
| db:table:switchboard_actions, db:fn:switchboard_dataquery_payload_ok, db:fn:switchboard_actions_guard, db:deploy (mcp) | fix 2's database step |

## Tests

- `supabase/functions/_shared/tools/switchboard.test.mjs`: org_type required, the two values accepted, others
  refused, and the headline prefix.
- `supabase/functions/mcp/index.test.mjs`: the schema field.
- `src/switchboard/ApprovePage.test.jsx`, `ApproveFixture.test.jsx`: the three banners, and sf_dataop's banner
  unchanged.
- `supabase/tests/dataquery_fixes-v3n/1_verify_org_type.sql` (`--test`): the payload function accepts a missing
  org_type and the two values, and rejects others. The guard refuses an insert without it. An old row can still change
  status. Conformance passes.
