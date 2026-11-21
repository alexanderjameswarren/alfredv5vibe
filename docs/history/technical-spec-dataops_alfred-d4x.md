# Switchboard data operations, Alfred side (dataops_alfred-d4x)

**Path in main:** `C:\Users\Alex\projects\alfred-v5\docs\technical-spec-dataops_alfred-d4x.md`

Written 2026-11-18. Progress: [progress-dataops_alfred-d4x.md](progress-dataops_alfred-d4x.md).

The overall flow, its decisions D1 to D12, and the switchboard side are in `C:\Users\Alex\projects\switchboard\docs\technical-spec-switchboard_dataops-d4x.md`. This file holds only what alfred-v5 builds, and the **sf_dataop payload contract** that switchboard s8 (Runner 2 and the desktop helper) must read.

## Scope

| Part | What | Files | Must land before |
|---|---|---|---|
| A1 | The new action kind `sf_dataop` (the production data run, started only from an approval link, D1); its queue tool `queue_switchboard_sf_dataop`; `queue_switchboard_sf_read` takes an `objects` list (1 to 20) at level metadata | `supabase/migrations/<NNN>_sf_dataop.sql`, `supabase/functions/switchboard-runner/` (`core.ts`, `index.ts`, `core.test.mjs`), `supabase/functions/_shared/tools/switchboard.ts` and `.test.mjs`, `supabase/functions/mcp/index.ts`, `supabase/tests/dataops_alfred-d4x/` | switchboard s8; today, Nov 18 |
| A2 | The approve page for `sf_dataop` | `src/switchboard/ApprovePage.jsx` and `.test.jsx` | switchboard s8; before Fix C, Nov 19 |
| A3 | The full skill update, as the switchboard spec's part 10 lists it (O9) | `.claude/skills/salesforce-workflow/SKILL.md`, `.claude/skills/cli-workflow/SKILL.md` | Fix C, Nov 19 |

### A1, database (one migration)

- `switchboard_actions`:
  - its kind check takes `sf_dataop`;
  - a new payload check, `switchboard_actions_sf_dataop_payload`, enforces the contract below;
  - a new check, `kind <> 'sf_dataop' or needs_click`;
  - the sf_read payload check (235's) also takes `objects` at level metadata.
- `switchboard_needs_click`: `sf_dataop` is always true, whoever queued it.
- `switchboard_queue_helper`: accepts `sf_dataop`. It needs the project code, because none is derived from the alias.
- `switchboard_pickup_helper`:
  - It takes `p_kinds text[]` (O3). A helper that doesn't name `sf_dataop` is never handed one.
  - An `sf_dataop` is handed out only once it is consumed and its link was used.
  - One not picked up within 15 minutes of the click fails, with a run saying why (O6).
- `switchboard_sf_read_log`: a new `objects jsonb` column (O4).
- `switchboard_issue_link`: unchanged (O5). The url already carries `kind=sf_dataop`, and `switchboard_stakes` already gives `change`.

As built (s3b):
- The one-running-per-project rule counts `sf_dataop` too, so nothing else of the helper's runs in that project during a production data run.
- An objects list with a name twice is refused by the tool and by the helper, not by the database: a CHECK can't hold a subquery.
- **Deploy order at s4:** the migration first, then both functions, because both write the read log's new `objects` column.

### A1, functions

- **switchboard-runner:**
  - `sf_dataop` joins the helper kinds.
  - The pickup passes `p_kinds` only for a helper that names all five kinds, `sf_dataop` included.
  - Today's helper (git, sf_check, sb_setup, sf_read) and the one from before s89c (git, sf_check, sb_setup) are still served, with no `p_kinds`, so they are never handed an `sf_dataop`.
  - A pick with no result fails after 30 minutes, except an `sf_dataop`, which gets 4 hours (O10).
  - `/result` keeps only the summary for an `sf_dataop`, as for an sf_read (O8). The receipt is a clip push (D6).
  - `/sf-result` logs an objects read under `objects`.
- **The queue tool `queue_switchboard_sf_dataop`** (tier 2; the link click is the gate):
  - It checks the payload as the database does.
  - It queues the action with `switchboard_queue_helper` and issues the link.
  - It never approves.
  - Its headline is `PRODUCTION DATA RUN <code> ON <alias>: ABOUT TO CHANGE <N> LIVE RECORDS OF <object> BY BULK` (or `BY BATCH <class>`), with N written with commas (26,571).
- **The sf_read tool** takes `objects` at metadata, 1 to 20 API names, instead of `object`.

### A2, approve page

For `kind=sf_dataop`, in this order:

1. An orange PRODUCTION banner, `bg-orange-400 text-black` (O7). It is a warning, not red, built like the page's existing `bg-red-700` banners.
2. "About to change N live records", where N is `expected`.
3. The plan's `problem` sentence.
4. The preflight stamp: its first 12 characters and `preflight_at`.
5. The Before and Goal rows. Knock-on rows carry the "Knock-on check:" label.

Red is used only for problems. The sf_read PRODUCTION FULL DATA banner stays red. The page reuses `Shell`, the `BUTTON` and `SECOND_BUTTON` buttons, `ResultLine` (with the line word `dataop`), the `bg-primary-bg` bordered panels, and the same Approve and Don't run controls. There is no dry run.

### A3, skills (full, O9)

salesforce-workflow, and cli-workflow where they overlap, change to the switchboard spec's flow:
- preflight;
- the plan file with state rows;
- Runner 1 in the CLI;
- Runner 2 by an `sf_dataop` link, with the tool's arguments passed through verbatim from what `sb` prints (O2);
- the receipt as a clip push;
- one production read link for every object (`objects`).

They also say:
- no hand edits and no hand comparisons;
- production steps come in their own reply, and only after a sandbox PASS;
- finish is one gitpush finish link, with no manual window close;
- the diagnosis rule: read-only anonymous Apex, run by Alex, is still allowed. Each script starts with `// READ-ONLY`, and Claude checks it holds no `insert`, `update`, `delete`, `upsert`, `merge` or `Database.*` write call before handing it over.

## The sf_dataop payload contract

**For switchboard s8: Runner 2 and the desktop helper read this section.**

The action row carries the project code (`project_code`), the headline, `chat_url` and the fingerprint. The payload is a JSON object with exactly these keys. Any other key is refused. Its whole text is at most 16,000 characters.

| Key | Type | Limits | Required | What the helper checks |
|---|---|---|---|---|
| `alias` | string | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$` | yes | It equals the plan's `orgs.production`. orgs.json and Salesforce both say the org is production. |
| `repo` | string | an absolute Windows path, as `queue_switchboard_git`'s `repo` | yes, **to be confirmed by switchboard s8** | The checkout that holds the plan, and its project code is the action's `project_code`. |
| `plan` | string | a path relative to `repo`, ending `.json`, with no `..` and no drive, at most 260 characters | yes, **to be confirmed by switchboard s8** | The file exists in `repo`. |
| `stamp` | string | 64 lower-case hex characters (sha256, D7) | yes | It equals the plan's `lastStamp`, recomputed now (`checkStamp`), and a sandbox pass is recorded for this stamp (D8). Otherwise: "The plan changed after preflight: run sb preflight again." |
| `preflight_at` | string | an ISO 8601 time | yes | It equals the plan's `preflightAt`. |
| `object` | string | `^[A-Za-z][A-Za-z0-9_]{0,79}$` | yes | It equals the plan's `object`. |
| `problem` | string | 20 to 600 characters | yes | It equals the plan's `problem`. |
| `expected` | integer | 1 or more | yes | It equals the plan's `write.expected`. This is the N in "About to change N live records". |
| `write` | object | `{kind: "bulk" \| "batch", class}`; `class` (`^[A-Za-z][A-Za-z0-9_]{0,79}$`) only and always for batch | yes | It equals the plan's `write` kind and class. |
| `rows` | array | 1 to 40 of `{label, before, goal, knock_on?}`: `label` a string of 1 to 200 characters, `before` and `goal` integers of 0 or more, `knock_on` a boolean (true for the plan's `knockOn` rows) | yes | Same order, labels and numbers as the plan's `rows` followed by its `knockOn`. |
| `rehearsal` | object | `{sandbox, at}`: `sandbox` an alias as above, `at` an ISO time | no, **to be confirmed by switchboard s8** | When present, it equals the sandbox pass recorded for the stamp. |

- **Every display key is a copy, checked against the stamped plan.** That is every key but `repo`, `plan` and `stamp`. On any difference the helper refuses before step 1, with nothing changed. So the approve page can never show something other than what runs, and the fingerprint binds Alex's click to that stamp.
- **Not in the payload:**
  - the Id list (Fix C has 26,571; the stamp covers it),
  - SOQL,
  - scripts.
- **Where the arguments come from (O2):** switchboard s8's `sb` prints the tool's arguments. Claude passes them to `queue_switchboard_sf_dataop` verbatim.
- **The result line word is `dataop`:** `dataop <action id> done` or `dataop <action id> failed` (switchboard s4c).
- **Pickup:**
  - The helper must name `sf_dataop` in its pickup `kinds`.
  - It gets one only after Alex's click.
  - It doesn't get one more than 15 minutes after the click; by then the action has failed (O6).
- **Result:** the run keeps its one-line summary only (O8). The receipt goes as a clip push (D6).
- **Time limit:** a picked `sf_dataop` must post its `/result` within 4 hours, or the next pickup marks it failed (O10).

## Claude-started production runs stay refused (D1): four layers

| Layer | How | Test |
|---|---|---|
| Database | `switchboard_needs_click` is true for `sf_dataop` whoever queued it. A check refuses a row with `needs_click` false. The guard trigger already refuses any change to `needs_click`. The pickup hands an `sf_dataop` out only when it is consumed with its link used, and only to a helper that names the kind. | `supabase/tests/dataops_alfred-d4x/1_verify_sf_dataop.sql` (`--test`) checks that: needs_click is true when queued as cli and as claude; an update to false is refused; an unclicked `sf_dataop` is never picked; the old kinds list is never handed one; one clicked more than 15 minutes ago fails; bad payloads are refused; an objects list of 20 is accepted and one of 21 refused. |
| Runner | Approve needs Alex's signed-in session, the link token and the fingerprint. The CLI's `/queue` route makes `sql` only. | `core.test.mjs`: the pickup kinds (the old set never gets `sf_dataop`), the approve route without a session, and `/queue` never making another kind. |
| Tool | `queue_switchboard_sf_dataop` queues and issues a link. No tool approves. | `switchboard.test.mjs`: the payload refusals, and the headline naming PRODUCTION and N. |
| Switchboard | The guard keeps `sb prod` refused in Claude sessions. Runner 2 runs only from a picked `sf_dataop`. | switchboard s8's tests |

## Decisions (Alex, 2026-11-18)

| # | Decision |
|---|---|
| O1 | The payload is as in the contract above. `repo`, `plan` and `rehearsal` are to be confirmed by switchboard s8. |
| O2 | switchboard s8's `sb` prints the tool's arguments, and Claude passes them through verbatim. |
| O3 | `switchboard_pickup_helper` takes `p_kinds`. A helper that doesn't name `sf_dataop` is never handed one. |
| O4 | A new `objects jsonb` column on `switchboard_sf_read_log`. |
| O5 | `switchboard_issue_link` is unchanged. |
| O6 | An approved `sf_dataop` not picked up within 15 minutes of the click fails. **Later:** this expiry should eventually cover every action kind, because of Alfred bug e12efcee (https://alfredv5vibe.vercel.app/e12efcee), where an approved git link that never ran stayed live. For now it applies to `sf_dataop` only. |
| O7 | The orange banner is raw `bg-orange-400 text-black`, like the existing `bg-red-700` banners. The sf_read PRODUCTION FULL DATA banner stays red. |
| O8 | An `sf_dataop` run keeps its summary only, like sf_read. |
| O9 | Step s7 is the full A3 from the switchboard spec's A list, not a minimal one. |
| O10 | A picked `sf_dataop` with no result is failed after 4 hours. Every other kind keeps 30 minutes. A production run's batch and waits can take far longer than 30 minutes. (Alex, s3b) |

## Additions (Alex, 2026-11-18)

- **(a)** The payload contract has its own section above, so that switchboard s8 can read it. The s5 checkpoint takes this spec and the progress file to main with A1.
- **(b)** The pickup expiry should eventually cover every kind. This is the "Later" note under O6, and it is also in the progress file.
