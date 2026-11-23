# Switchboard 3: the run and code review pages (sb3_pages-h6v)

The pages thread of Switchboard 3: new Alfred approve pages for Salesforce data runs, and a code review page for
Salesforce code. The design's source of truth is the Claude Doc "Switchboard 3: the agreed paper walk"; this spec holds
everything the thread needs from it, the screens Alex agreed in chat, and three later changes from the design thread.
Plan agreed at sb3_pages-h6v-s1-m2p7; Alex's decisions on its twelve questions are in part 12.

## 1. Rules for this thread

- **Beside, not instead.** The new pages are built beside today's approve page. src/switchboard/ApprovePage.jsx, its
  link kinds, switchboard_issue_link, switchboard_consume_link and switchboard-runner are not changed: client fixes run
  on them. Switching over is its own later item (part 11, C), approved separately.
- **NO HEARTBEAT.** No polling of Supabase, no continuous checks, no last-seen pings, no timer that checks in. Work
  starts only from Alex's action. Status is read at the moment it is needed: when a page opens and when Alex clicks a
  button. Nothing refreshes on a timer. The one exception agreed (Q6) is a single 2-second wait for the extension's one
  reply to one question, never repeated.
- **Sample data first.** Until the data runs thread exists, every page is built against made-up sample data. Every page
  shown that way carries the SIMULATION strip and can touch no org.
- **The look.** New UI reuses today's approve page: its classes, banners, primary-bg panels, pills and the
  "Reason for not running (optional)" input (copied into src/switchboard/runs/look.js; what ApprovePage exports is
  imported). Confirmations follow today's page: one click, buttons disabled while busy (Q12).
- **Testing** is in desktop Chrome against this worktree's local dev server.
- **Database** work follows mcp-platform: register_table on every new table, explicit grants (authenticated and
  service_role, nothing for anon), SQL queued with scripts/sql-queue.mjs, check_platform_conformance CONFORMANT at the end
  of every migration block, _pending_ file naming, db: claims just in time (after gitsync and the drift check).
- At double the agreed estimate, stop and ask. Never commit, push or merge.

## 2. Owned elsewhere

| What | Owner |
|---|---|
| The new helper action kind (proposed `sf_run`): switchboard_actions' kind constraint, the guard trigger branch, switchboard_needs_click, inserting a row already consumed, and the pickup that hands it out. Today's guard forces every new row to queued with no link. Phase B waits on it (Q5). | plumbing (sb3_plumbing-n7c) |
| The 15-minute pickup expiry, including the migration that changes the pickup functions. These pages only display the result. The read-time rule for "Not started" (Q11) needs plumbing's agreement. | plumbing |
| The extension: injecting into /run/ and /review/ pages (today it injects only into https /approve/<token>), a page mark saying it is there, the desktop answer (part 6), and the new result lines in its POST_LINE allow-list (part 4.4), including `cancelled: <reason>` on a run line (today only sql lines carry a reason), and storing and matching those lines by the link id rather than the action id (today postlineStep requires the line to contain the action id). | plumbing (switchboard repo) |
| The helper action carrying the link id (payload.link_id) and reporting its result line under it, including for a resent run. | plumbing and data runs |
| The data runs themselves, the helper, terminal windows, the typed count, the backup and results files, sending the sample record to Alfred. | data runs thread (switchboard repo) |
| The cold review checklist line "every Claude's note matches the change it sits on". | skills (not this thread) |
| An Alfred code review for Alfred's own code. | not planned |

## 3. The agreed design

### 3.1 Every page, parts in this order

1. **SIMULATION strip** (purple, top) on any page built on sample data.
2. **Red "APPROVAL REQUIRED" bar**, only while the page offers an Approve button. New pages drop the small "Approve"
   heading under "Alfred" (today's pages keep it until the switch-over).
3. **Banners**, today's size. Orange-400 "PRODUCTION, LIVE CLIENT DATA" with a smaller second line inside: "Read only,
   nothing changes." or "This changes N live records.". Sky-700 "SANDBOX, TEST RECORDS ONLY" with its second line. A page
   that touches both shows both. No red "production full data" banner: orange is a warning, red only a problem.
4. **The tool's headline** in bold, then "Project" and the project code, keeping the data-switchboard-project and
   data-switchboard-kind marks the extension reads.
5. **Phase header** (for example "Pre-check and rehearsal prior to data operation"), then client and org.
6. **Large count sentence** ("This changes 45 live records of Gift in example-prod.") on pages that write (data
   operation, undo) only.
7. **Problem box**: the problem label (P1, P1a) and the problem in diagnosis's words; What changes (tool-built from the
   request, never typed); Selected by; Org; Count; Side effects, in diagnosis's words (required: a request without it is
   refused before any link, and the refusal says to add it; the tool writes no "can't be undone" text of its own);
   Diagnosis allows (when it allows anything).
8. **Status line**: each phase with passed, waiting or not started, its time, and "valid until" (24 hours from the oldest
   evidence still in use); the request version and when it was corrected; kept sandbox test data and temporary code in
   production, when any.
9. **"Changed since you last approved"**: only after a correction; old and new side by side, with the reason in
   diagnosis's words.
10. **Sample record**: one record, now and after (not on the pre-check page, which reads it).
11. **Undo line**: the undo level, its mechanics and deadline only (for example "Undo: standard. Deletes them again.").
12. **"This run will:"** grouped under headers, each step a statement (no questions), each with a Production pill
    (today's orange-100 mono pill) or a Sandbox pill (sky-100). Groups: pre-check page "Production pre-check" and
    "Sandbox rehearsal"; data operation and undo pages "Before the write", "Write", "After the write". Then "The run
    stops at the first step that fails."
13. **Desktop line** (part 6). Runs are approved from the desktop browser only.
14. **"After you approve"**: the 15-minute pickup (plumbing's; else "Not started. Nothing ran." with Try again), what the
    terminal does (including the typed count), what comes back to Alfred.
15. **Details block**, closed by default: run tag, run folder, hashes, every query in full, any added Ids.
16. **"Reason for not running (optional)"**, then the Approve button and "Don't run". Approve labels: "Approve this run
    on PRODUCTION", "Approve this run on SANDBOX", "Approve this run on PRODUCTION and SANDBOX", "Approve this UNDO on
    PRODUCTION".

### 3.2 Screen by screen

**a. Pre-check and rehearsal page** (one approval: production reads plus a sandbox rehearsal).
- Production pre-check: count how many of the listed records still exist (or what the filter matches now, against
  diagnosis's expected count); check the login doing the update may change the field; list the triggers and flows that
  fire on save; save the records' current values to the PC as the backup and send one sample record to Alfred.
- Sandbox rehearsal: create 3 TEST records like the sample (for a filter: 3 that match and 1 that doesn't); run the same
  operation and confirm each changed (and the 1 didn't); run the standard undo and confirm each is back; delete the TEST
  records.
- When the sandbox filter must differ, the Problem box shows both and a "Not rehearsed:" line, and this one approval
  accepts it.

**b. Production data operation page**: update, insert, upsert (by external Id), delete (to the recycle bin), undelete,
and a run across several objects.
- Before the write: the records still match the backup, the login can still write, the triggers and flows are unchanged.
- Write: Alex confirms the count in the terminal (anything else stops with nothing changed); the records are written.
- After the write: read each record back and confirm the goal and that nothing else changed; save the run's results to
  the PC and Alfred.
- Insert names its file of rows on the PC; the sample is one row to be created.
- Upsert shows the update and create split, one sample of each; the typed count is the total.
- Delete shows children deleted with the parent, links blanked and links blocking as knock-on counts, a sample with its
  child count, and the undo deadline (undelete within 15 days, the real date read by the pre-check).
- Undelete shows days remaining and a sample with who deleted it and when.
- A run across several objects lists each step with its count (a step can be marked "Pause before this"); the typed
  count is the total; any failed row stops before the next step; its undo in this version is backup only.

**c. Undo page**: "Approve this UNDO on PRODUCTION"; "up to N" records, because records edited since the run are
skipped and listed with who changed them and when, found at run time; the terminal asks for the exact count after skips.
After a stopped run it covers only what that run changed. After the undo deadline: no undo offered, the page says why,
no buttons. **An undo has no undo**: the page's undo line says "Undo: none. An undo has no undo." and **a further change
is a new request through diagnosis**, which the page says in the same place.

**d. Correction page**: the request's version goes up by one; the "Changed since you last approved" block; "This run
will:" lists only the checks the edit touches; then a "Still valid, not run again" list with each check's time.
Which edit reruns what (EDIT_RERUNS in runContract.js):

| Edit | Runs again |
|---|---|
| wording only, or what diagnosis allows | nothing: no page of its own; the next page carries the block |
| the value or the file | rehearsal |
| which field | rehearsal and the login check |
| which records | count, backup and sample; plus the rehearsal for a filter |
| the sandbox filter | rehearsal |
| the code | rehearsal and code review |
| the object or the operation | refused: a new request |

**e. States**, each read when the page opens or when Alex clicks "Check again", never on a timer:
- Desktop not running, or no extension: no Approve button, the reason, "Check again".
- Approved but not picked up: "Not started. Nothing ran." plus "Try again: resend this run", which resends the same
  unchanged run, with no new link from the chat. (Labelled apart from the extension's own post "Try again".)
- Checks expired: no Approve button; "Run the pre-check and rehearsal again", which is itself the approval, with its
  steps listed in full; once it has passed, the same page offers the data operation.
- "Check what happened" after an interrupted run, read only: Salesforce's job state, each record against the backup and
  the goal, any temporary code left in production; back to Alfred: the job state and three counts.

**f. Code review page** (Salesforce code only).
- One scroll. Cold review findings at the top: "Fixed by the CLI" and "For you"; each "for you" finding has an
  Acknowledge tick and an optional note.
- Inline diffs, not side by side. New files shown whole. Changed files with a few lines of context and a "Show the whole
  file" link. Each file header lists the problem labels that touch it.
- "Claude's note" boxes (pale orange, page only, never written into the code) above each change, supplied by the CLI
  with file, line range, problem label and text: one line for a new file, a real explanation for an edit to existing code.
- The status line names the commit and when it passed the rehearsal. A later commit voids the rehearsal and the review,
  the data operation link is refused, and the old page says "The code has changed since this review. A new review comes
  after the next rehearsal." with no buttons.
- One text box, "Your question or the change needed (sent to the thread)", required for either of two buttons: "Ask a
  question" (posts to the thread; the review stays open on the same commit; ticks kept) and "Not approved. Changes
  required.". Plus "I reviewed this code", greyed until every "for you" finding is acknowledged; it stays available after
  a question.

## 4. The contract (PROPOSAL)

For the design thread to reconcile with the data runs thread. The rules live in src/switchboard/runs/runContract.js
(pages and simulation) and, at B3, in the queue tool.

### 4.1 A run request (queue_switchboard_run_request)

| Field | What |
|---|---|
| id, version, corrected_at | set by the database |
| page | precheck, dataop, undo, correction, check |
| project_code, run_tag, client, headline | as today's links |
| orgs | [{alias, org_type production or sandbox, role target or rehearsal}] |
| problem | {label "P1a", sentence in diagnosis's words}, required |
| side_effects | diagnosis's words, required |
| diagnosis_allows | [sentences], or absent |
| operation | {kind update, insert, upsert, delete, undelete or multi, object, field?, value?, file?, external_id?, steps?[{object, kind, count, pause_before}]}; "What changes" is built from it (whatChanges) |
| selected_by | {kind ids or filter, text, sandbox_text?, not_rehearsed?} |
| counts | {expected, total, update?, create?, children?, links_blanked?, links_blocking?, undo_up_to?, skipped?} |
| sample | {records: one record, or for an upsert two (one to update, one to create), each {role update, create or record, fields [{name, now, after}], child_count?, deleted_by?, deleted_at?, days_left?}} on dataop and undo only; held in Alfred (part 7), never in the request the chat sees |
| undo | {level standard, backup_only or none, mechanics, deadline?} |
| evidence | [{check, org, passed_at, voided?}]; valid_until is computed from it (validUntil), never sent |
| phases | [{name, state passed, waiting or not_started, at}] |
| kept | {sandbox_test_data?, temp_code_in_production?} |
| changed | {edit_kind (EDIT_RERUNS), from_version, reason, items [{what, old, new}]}; still_valid [{check, passed_at}] |
| steps | [{code, count?, pause_before?, object?, kind?}]; each code maps to one fixed statement, group and org (STEPS); an org sent that differs is refused; a multi-object run's write_step entries must match operation.steps in order; a correction's steps must be within what its edit reruns (rerunSteps, CHECK_STEPS: evidence uses the same check names) |
| details | {run_folder, hashes [{name, sha256}], queries [{label, soql}], added_ids?} |
| code | {commit, rehearsed_at} when the run carries code |

Refused before any link (requestProblems), each refusal saying what to add: a missing problem label or sentence, missing
side_effects, unknown step codes or steps from another page, a sample on a pre-check, a correction of the object or
operation ("needs a new request through diagnosis"), a correction page for a wording or allowance edit (it has no
page), and a simulation mark from the real source.

### 4.2 Step codes and their statements

Production pre-check: count_listed, count_filter, login_can_change, list_automation, save_backup. Sandbox rehearsal:
create_test, rehearse_operation, rehearse_undo, delete_test. Before the write: still_match_backup, login_can_write,
automation_unchanged, skip_edited (undo). Write: type_count, write, write_step (one per object, with "Pause before this").
After the write: read_back, save_results. What happened (check page): job_state, compare_records, find_temp_code. The
statements are in STEPS; "The run stops at the first step that fails." follows the list.

### 4.3 A code review (queue_switchboard_code_review)

{request_id, repo, commit, base_commit, rehearsed_at, files [{path, status new, modified or deleted, old_text?,
new_text?, problem_labels[]}], findings {fixed_by_cli [{id, text, file?, lines?}], for_you [{id, text, file?, lines?}]},
notes [{file, start_line, end_line, problem_label, text}]}. The whole old and new text of each file arrives, so new
files show whole and "Show the whole file" needs nothing more. Refused (codeReviewProblems): a bad commit, a file
without its text, duplicate finding ids, a note outside its file. At A6 a note must also sit on changed lines.

### 4.4 Result lines (today's shape: word, id, outcome, text capped at 200 characters)

| Event | Line |
|---|---|
| Approve | `run <link id>`; the helper later posts `run <link id> done: PASS`, `done: FAIL` or `failed` (data runs and plumbing). Every line uses the link id, also for a resent run, so the chat follows one id per page; the helper action carries it as payload.link_id (part 2) |
| Don't run | `run <link id> cancelled[: <reason>]` |
| Try again: resend this run | `run <link id> resent` |
| Check what happened | `check <link id> done: job <state>; <a> at goal, <b> at backup, <c> neither` |
| I reviewed this code | `review <link id> reviewed` |
| Ask a question | `review <link id> question: <text>` (first 200 characters; the full text, up to 1000, is kept on the review) |
| Not approved. Changes required. | `review <link id> changes required: <text>` (as above) |
| Simulation | `SIMULATION run sim-...`; shown to copy, never with a run-id mark, never posted |

Until the extension's POST_LINE learns these (plumbing), the page shows the line to copy, as ResultLine does today.

## 5. Link rules

Their own table and functions; today's link machinery is untouched. Every check is made against now() at the moment
of a page open or a click; nothing runs on a clock.

- **Table** switchboard_run_links: token hash, request_id, request_version, page, fingerprint, used_at, rerun_at,
  voided_at, void_reason. Validity is read live from the request's evidence that hasn't been voided, never copied onto the link.
- **No 30-minute clock.** A link not yet approved has no clock of its own. A pre-check link, with no evidence yet, has
  no expiry: it dies only on use or correction (Q2).
- **Corrected.** switchboard_correct_run_request raises the version, voids the evidence the edit kind reruns
  (EDIT_RERUNS) and voids the request's live links, in one transaction. It refuses an object or operation edit. A
  wording or allowance edit voids nothing and gets no page; the next page carries the block. Consume also requires
  link.request_version = request.version.
- **Expired** (valid_until <= now()): preview still opens and shows no Approve, only "Run the pre-check and rehearsal
  again". That click is its own approval, through switchboard_consume_run_link in rerun mode: allowed only while the
  checks are expired, the link unused and the version unchanged, it sets rerun_at (not used_at) and hands the pre-check
  to the helper. Once the pre-check passes, the evidence is new and valid, so the same link, still unused, offers the
  data operation, whose consume sets used_at as usual. A second rerun is refused while one is waiting or running.
- **Used.** Consume is one atomic update where used_at and voided_at are null, the version matches, the checks are
  valid and the fingerprint matches, as switchboard_consume_link does today.
- **Code changed.** A newer commit is a correction of kind code: it voids the links and marks the review superseded.
  The data operation consume also requires the request's commit to equal the reviewed and the rehearsed commit.
- **One path per project (Q10).** Consume refuses, by a read only, while one of today's links or a run is live for the
  same project code. Today's issue_link is not changed and doesn't see these links.
- **Restart.** switchboard_retry_run, with Alex's JWT, resends the same run (same payload and fingerprint) only when the
  last approval was not started, the version is unchanged and the checks are valid, and under the same one-path rule
  (Q10) as consume. "Not started" is read at page open
  or Check again: consumed, never picked up, approved over 15 minutes ago (Q11, pending plumbing).
- **Hand-off.** Consume creates the helper action of plumbing's new kind (part 2).
- **Where.** A new Edge Function, switchboard-run-pages, so today's runner is never redeployed for this.

## 6. The desktop check

- At page open, on every "Check again", and once more at the Approve click before consuming (Q9): the page posts one
  window message {type: "switchboard-desktop-check", id} and waits once, 2 seconds, for one reply
  {type: "switchboard-desktop-state", id, extension_version, panel, helper} (Q6). Never repeated by itself.
- **Running**: "Desktop ready: Switchboard panel and helper running (checked when this page opened)"; after a Check
  again the bracket reads "(checked just now)". Approve shown.
- **The check at the Approve click fails**: nothing is consumed and nothing runs; Approve and the red bar go, and the
  page shows that answer's state below with "Check again".
- **Not running**: no Approve and no red bar; "Start Switchboard on your desktop", naming the panel, the helper or both;
  "Check again".
- **No extension** (no reply and no extension mark on the page; a phone, another browser): no Approve and no red bar;
  "Approve from Chrome on your desktop"; "Check again".
- **No answer** (mark present, no reply): no Approve and no red bar; "The Alfred extension didn't answer. Reload it,
  then Check again."; "Check again".
- **Made-up answers** until plumbing ships: a simulation scenario's `desktop=` list (for example
  `desktop=no_extension,running`) gives the answers in order, one per ask. Locally the extension doesn't inject at all
  (http, and /run-sim/ isn't /approve/), so the check is simulation only.

## 7. The sample record

- **Stored** in switchboard_run_samples: one row per request, one record (two for an upsert: one to update, one to
  create), expires_at = the checks' valid_until, with a
  check that expires_at <= created_at + 24 hours. Written only by the pre-check run's result, through
  switchboard_store_run_sample (data runs and plumbing call it).
- **Deleted** when the run finishes (switchboard_drop_run_sample); when something reads it after expires_at (the
  preview deletes it and shows none); and as a backstop by one added delete in switchboard_prune_sf_results, the
  existing every-minute cron job that already deletes expired Salesforce read rows. Lazy deletion alone would leave
  client data in Alfred if nobody read again; that job is where client rows are already guaranteed to go, and it adds
  no timer. It is a shared function: the change is one statement, claimed at B1.
- **Read** only by the page, with Alex's JWT. No MCP tool reads it (Q4).

## 8. The simulation

- Every page reads through a source: the real one (switchboard-run-pages) or the simulated one (simulation.js), which
  has no Supabase client and makes no network call.
- RunShell draws the SIMULATION strip from the source's kind, not from the data, so a sample can't drop it. It fails
  closed: the strip shows unless the source's kind is exactly 'real'. The red bar follows RunShell's approvable prop;
  from A2, RunPage sets it from the same value that draws the Approve button. The real
  source and the database both refuse anything marked simulation.
- Scenarios cover every page and state: pre-check (ids, filter, a different sandbox filter); data operation update,
  insert, upsert, delete, undelete and multi-object; undo (normal, after a stopped run, past the deadline); correction
  (each edit kind); not started; checks expired; check what happened; code review (open, superseded); and the desktop
  answers.
- The route /run-sim/:scenario is mounted only when NODE_ENV !== 'production' (as /approve-fixture is), so a build has
  none (Q7). Phase A mounts no live route; /run/:token and /review/:token arrive at B4. Simulated pages carry
  data-switchboard-kind="simulation" and never a run-id mark.

## 9. The code review, recorded

- The diff: the `diff` package (jsdiff) at an exact version (Q3), rendered inline by our own code: hunks with 3 lines of
  context, and the same call with full context for "Show the whole file".
- switchboard_code_reviews: request_id, commit, payload, status (open, question, changes_required, reviewed,
  superseded), decision_text, decided_at, acks {finding_id: {acked_at, note}}.
- Ticks and notes are saved when Alex ticks or leaves a note (his action, not a timer). "I reviewed this code" is refused
  in the database unless every for_you id is acknowledged and the commit is the request's current one. A newer commit
  sets superseded.
- The review is a link page like the others (page code_review); "Ask a question" doesn't use the link up.

## 10. Database items, each with its step

All at Phase B; Phase A has none. Each is claimed at its step after gitsync and the drift check, never before.

| Item | Step |
|---|---|
| db:table:switchboard_run_requests, switchboard_run_links, switchboard_run_samples, switchboard_code_reviews | B1 |
| db:fn:switchboard_queue_run_request, switchboard_correct_run_request, switchboard_issue_run_link, switchboard_run_preview, switchboard_consume_run_link, switchboard_cancel_run_link, switchboard_retry_run, switchboard_record_code_review, switchboard_store_run_sample, switchboard_drop_run_sample | B1 |
| db:fn:switchboard_prune_sf_results (one added delete) | B1 |
| db:table:switchboard_actions (insert through plumbing's kind) | B1 |
| db:deploy | B2 and B3 |

## 11. Build order (CLI steps)

| Step | What | Est. |
|---|---|---|
| A1 | spec, progress, look.js, runContract.js and its test | 1 |
| A2 | RunPage parts 1-16; pre-check page and data operation update; simulation.js; /run-sim route | 2 |
| A3 | desktopCheck and its states | 1 |
| A4 | data operation insert, upsert, delete, undelete, multi-object; undo page | 2 |
| A5 | correction page; not started and Try again; checks expired; check what happened | 2 |
| A6 | code review page; `diff`; acks, notes, superseded | 2 |
| A7 | Alex tests in desktop Chrome; fixes | 1 |
| **Phase A** | | **11** |
| B1 | migration: tables, functions, grants, register_table; tests in supabase/tests/sb3_pages-h6v; queue; conformance; Checkpoint | 2 |
| B2 | switchboard-run-pages function, tests, config.toml; deploy | 2 |
| B3 | MCP tools switchboard-runs.ts and mcp/index.ts; deploy | 2 |
| B4 | real source; live routes /run/ and /review/; end to end on a sandbox with the data runs thread | 1 |
| **Phase B** | waits on plumbing's helper kind and the data runs thread | **7** |
| **Total** | | **18** |
| C | switch-over, later, approved separately: today's page drops "Approve" and imports look.js; new runs stop using sf_datawrite links. look.js imports localTime and shortHash from ApprovePage today, so C first moves those two into a small shared module both import, to avoid a circular import | 2 |

## 12. Decisions (Alex, 2026-11-23)

Q1 copy the look into look.js; Q2 a pre-check link has no expiry; Q3 jsdiff at an exact version, our own rendering;
Q4 Claude can't read the sample; Q5 plumbing owns the new helper kind, and Phase B waits on it; Q6 one 2-second wait for
the extension's one reply; Q7 the simulation is dev-server only; Q8 review text in the chat line capped at 200
characters, the full text kept on the review; Q9 the page asks the desktop again at the Approve click; Q10 consume
refuses while one of today's links, or a run, is live for the same project (by a read only); Q11 "Not started" is
consumed, never picked up, approved over 15 minutes ago, pending plumbing's agreement; Q12 one click, buttons disabled
while busy.

## 13. Files

- src/switchboard/runs/: look.js, runContract.js, RunPage.jsx, desktopCheck.js, CodeReviewPage.jsx, codeDiff.js,
  simulation.js, RunSimulation.jsx, each with its test.
- src/App.js; package.json and package-lock.json (`diff`, A6).
- Phase B: supabase/functions/switchboard-run-pages/; supabase/config.toml;
  supabase/functions/_shared/tools/switchboard-runs.ts and its test; supabase/functions/mcp/index.ts and its test;
  supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql; supabase/tests/sb3_pages-h6v/.
- Not touched: ApprovePage.jsx, ApproveFixture.jsx, switchboard-runner.
