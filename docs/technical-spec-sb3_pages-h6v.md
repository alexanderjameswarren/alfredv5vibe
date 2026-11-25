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
| The 15-minute pickup expiry, including the migration that changes the pickup functions. These pages only display the result. "Not started" is agreed: part 4.5. | plumbing |
| The extension: injecting into /run/ and /review/ pages (today it injects only into https /approve/<token>), a page mark saying it is there, the desktop answer (part 6), and the new result lines in its POST_LINE allow-list (part 4.4), including `cancelled: <reason>` on a run line (today only sql lines carry a reason), and storing and matching those lines by the link id rather than the action id (today postlineStep requires the line to contain the action id). | plumbing (switchboard repo) |
| **Proposal for plumbing, the desktop check (A3, src/switchboard/runs/desktopCheck.js).** (1) Page mark: on injecting into a /run/ or /review/ page, the extension sets `data-switchboard-extension="<extension version>"` on `<html>`. (2) The page sends `window.postMessage({type: "switchboard-desktop-check", id}, location.origin)`, `id` a fresh UUID per ask. (3) The extension answers once, within 2 seconds, with `window.postMessage({type: "switchboard-desktop-state", id, extension_version, panel, helper}, location.origin)`: the same `id`; `panel` true only if the Switchboard side panel is open and connected; `helper` true only if the desktop helper is running; both booleans. (4) The page takes the first reply from its own window and origin with its id, and ignores anything later: both true → running; one false → that one isn't running; both false → neither; no reply with the mark → no answer; no reply and no mark → no extension. (5) Asked only at page open, on "Check again" and at the Approve click; the extension never sends a state unasked. | plumbing (switchboard repo) |
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
| which field | rehearsal, the login check, the backup (Alex, s7) and the sample record (Alex, s8b) |
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
| Approve on a correction page (its reruns, s12b) | `run <link id> reruns` |
| Don't run | `run <link id> cancelled[: <reason>]` |
| Try again: resend this run | `run <link id> resent` |
| Check what happened | `check <link id> done: job <state>; <a> at goal, <b> at backup, <c> neither` |
| I reviewed this code | `review <link id> reviewed` |
| Ask a question | `review <link id> question: <text>` (first 200 characters; the full text, up to 1000, is kept on the review) |
| Not approved. Changes required. | `review <link id> changes required: <text>` (as above) |
| Simulation | `SIMULATION run sim-...`; shown to copy, never with a run-id mark, never posted |

Until the extension's POST_LINE learns these (plumbing), the page shows the line to copy, as ResultLine does today.

### 4.3a The code review page as built (A6, s7)

- **jsdiff** (`diff`) pinned at exactly 5.2.0. codeDiff.js turns its diffLines output into numbered rows (added,
  removed, unchanged) and hunks with 3 lines of context; CodeReviewPage.jsx draws them itself, inline, never side by
  side. A missing final newline never shows the last line as changed.
- **Review fields added to 4.3:** project_code, headline, simulation (sample data only), superseded_by (the newer
  commit; the page shows "The code has changed since this review. A new review comes after the next rehearsal." and
  no buttons), acknowledged {finding id: {note}} (ticks and notes kept across visits and questions).
- **Refused** (codeReviewProblems), added at A6: a note whose lines aren't changed lines (an added line, or the new line
  a removal sits before); a note on a new file that isn't one line; a note whose problem label isn't one of its file's
  labels; a superseded_by that isn't a commit hash. A refused review shows "This review can't be shown" and no
  buttons.
- **Notes** sit directly above the change they explain, in both views: above its removed lines when a line was replaced
  or deleted (noteAnchor), never between the removed and the added lines. A removal at the very end of a file counts
  on the file's last line.
- **A refused review** shows only its headline and why: no findings, no code, no buttons, no red bar.
- **Ticks and notes** go with every answer (question, changes, reviewed), so the real source keeps them on the review;
  they are locked while a click waits on the desktop. After "I reviewed" or "Changes required" the outcome panel takes
  focus and is announced.
- **Desktop:** "I reviewed this code" and the red bar come from one value and need the desktop ready, asked at page
  open, on Check again and again at the click; otherwise the "Desktop not ready" section stands in. "Ask a question"
  and "Not approved. Changes required." don't need it: their line is shown to copy until POST_LINE learns it.
- **Result lines** as 4.4: the line carries the first 200 characters (lineText), the source receives the full text (up
  to 1000).
- Scenarios: review-logic-rerun (two new files), review-code-fix (one class, two places, P1a and P3),
  review-superseded, review-all-acknowledged, on the same /run-sim/:scenario route.

### 4.3b Fixes from Alex's testing (A7, s8)

- **Closed undo:** "Undo: not offered, the deadline has passed." replaces the waiting "Undo" phase in the status line
  (s8b), and "This run will:" and the "Undo: none…" line are left out, so the page has one "Undo:" line.
- **New file notes** (s8b): always at the very top of the file, above line 1, whatever line range they name; the
  label keeps the range ("line 2").
- **An undo's login check** names what the undo does: a delete's undo "Confirm the login can still restore Gift
  records."; an insert's (or undelete's) undo deletes; an upsert's "delete and update"; an update's undo updates the
  same field.
- **A used link:** the phase that was waiting reads "running, picked up <time>", "finished, <time>" or, with a
  failure_reason, "stopped, <time>", from the stored run. The phase keeps its state (data-live carries the word).
- **Check what happened** shows no "Checks valid until" or "nothing expires" line.
- **Corrections:** one scenario per edit kind (field, value, records by Id list and by filter, sandbox filter, code),
  each built from EDIT_RERUNS: its steps are rerunSteps(kind) with the count step that fits the selection, its
  rerun checks' evidence voided, "Still valid" the rest. A correction's banners and Approve label name only the orgs
  its steps run on (a value, sandbox filter or code edit: "Approve this run on SANDBOX").
- **Code review page:** the full window width with today's side margins (run pages keep max-w-3xl). Code never
  wraps; a long line scrolls only its own file's code box (a size container), and notes inside it stay in view at
  the left, never wider than the box. Line numbers and "N unchanged lines" use the readable muted text colour. A new
  file's notes sit at the top, above line 1. A note reads "line 2" or "lines 9-11". On a superseded review only, the
  ticks and notes are visibly locked (greyed, dashed, not-allowed, "locked: this review is superseded"); an open
  review's disabled note boxes just dim. A refused review is drawn at the run pages' width.
- **Result lines:** text cut to 200 characters ends with "…", within the 200.

### 4.5 Agreed with plumbing (s5, 2026-11-23)

1. **Not started.** "Not started. Nothing ran." shows when switchboard_runs.failure_reason is 'expired_not_picked_up'
   (column name to be confirmed by plumbing). Until plumbing marks it, the page also works it out at page load from the
   stored times (consumed, never picked up, approved over 15 minutes ago). "Try again: resend this run" works in both
   states.
2. **Resend.** switchboard_retry_run fails the stale action in the same database step that creates the resend (a B1
   item). Plumbing's pickup keeps refusing anything older than 15 minutes, as the backstop.
3. **One id.** A resend keeps the same link id (payload.link_id); every result line for that run uses the link id.
4. **Several lines per id.** One link id can post several result lines (failed, resent, done); a lookup by link id
   takes the newest action.
5. **Cancel note.** `run <id> cancelled: <reason>` carries the cancel note, capped at 200 characters.
6. **Lost reply.** A pickup retried after a lost reply returns the same action (plumbing's side).

### 4.6 Fields added at A4

- operation.days_left (undelete): days before Salesforce empties the recycle bin, read by the pre-check; the Problem box
  shows it as "Recycle bin".
- operation.object_label (A2, single-object runs): the object as people say it ("Gift"), used by the login step and the
  count sentence; the API name when absent.
- operation.steps[].label_plural (multi-object runs): each object in the plural ("Accounts"), used by the login step,
  the write steps, the Count and the count sentence; the API name when absent.
- Refused before any link, added at A4: an undo page without undo_of's run_tag, a readable deadline and
  deadline_reason (and a page with no readable deadline shows as closed); an upsert whose update and create don't add
  up to the total typed; a multi-object run whose step counts don't add up to it; a delete without undo.deadline; an
  undelete without operation.days_left; skip_edited anywhere but the undo page.
- The undo page's "What changes" describes the undo ("Puts back up to N records of X from the backup of run …"). Once
  closed, its production banner reads "Nothing changes: no undo is offered.", and the count sentence, "After you
  approve", the desktop line and "Undo possible until" are not shown.
- undo_of (undo page, required): {run_tag, stopped?, changed?, deadline?, deadline_reason?}; deadline and its reason
  only for a delete's undo (part 4.7 supersedes the rest of this entry). After a stopped run the page
  says the undo covers only the `changed` records; after `deadline` (checked at page open and at the click) the page
  says "No undo is offered: <deadline_reason>. A further change is a new request through diagnosis." and shows no
  buttons, no red bar and no desktop section.
- sample.records[].role labels an upsert's two samples "To update" and "To create" (and an insert's row "To create").
- Focus: when the "Desktop not ready" section appears after a click, focus moves to "Check again"; when a check
  succeeds, to the Approve button. Not at page open, so the page opens at its top.

### 4.7 Decided and added at s6 (A5)

- **An undo has no 24-hour expiry** (Alex): only its own undo deadline. The undo page shows no "Checks valid until"
  and is never "checks expired" (pageExpired).
- **Only a delete's undo has a deadline** (the 15-day recycle bin): undo_of.deadline and deadline_reason are required
  for it and refused for any other undo. An update's undo restores from the backup on the PC and never closes, so it
  shows no "Undo possible until". A delete's undo writes "Restore up to N records from the recycle bin."
- **A stopped run's undo** is selected as "The N records the stopped run changed."
- **The first "Before the write" step** (still_match_backup) depends on the operation, with the request's counts:
  update and delete "Confirm the records still match the backup."; insert and multi-object "Confirm none of the rows
  already exists."; upsert "Confirm the N records to update still match the backup, and the M to create still don't
  exist."; undelete "Confirm the N records are still in the recycle bin."
- **A multi-object run's undo line** is always "Undo: backup only. The Ids of everything created are saved on your PC.
  Undoing across several objects isn't in this version."
- **One action per page.** A page offers at most one action, and the red bar goes with it (one value): Approve; once
  the checks have expired, "Run the pre-check and rehearsal again" (its own approval, with its eight steps listed in
  full beneath it); after a run that was not started, "Try again: resend this run" (result line `run <link id>
  resent`). Each asks the desktop at the click, and the "Desktop not ready" section stands in for any of them.
- **The stored run** comes with the page (B2): {consumed_at, picked_up_at, finished_at, failure_reason}. Not started
  (part 4.5, notStarted): failure_reason 'expired_not_picked_up', or consumed, never picked up, over 15 minutes ago.
  Approved under 15 minutes ago and not picked up: "Waiting for the desktop helper", no buttons.
- **Correction page:** changed.still_valid [{check, passed_at}] lists "Still valid, not run again" after "This run
  will:". A wording or allowance edit carries changed on the next page, which shows only the block.
- **Check what happened:** interrupted {run_tag, at, where} is required and shown as "Interrupted" in the Problem box;
  "What changes" reads "Nothing: this page only reads."; no sample, no undo line; the button reads "Check what
  happened on PRODUCTION". A phase can be "interrupted".
- **After the rerun passed** the phase reads "passed (run again)" (phases[].rerun) and the page offers the data
  operation as usual.
- **A rerun already asked for** (rerun_at set, evidence still expired): "Pre-check and rehearsal asked for again", no
  button, no expired note; a second rerun isn't offered (part 5). The rerun's result line is plain `run <link id>`.
- **In rerun mode** the banners and "After you approve" describe the pre-check and rehearsal, not the write. A
  dataop request whose checks may expire carries its rehearsal org, so the rerun can rehearse (B3 to enforce).
- **A used link** (picked up or finished): a panel "Picked up …, running", "Finished …" or, with a failure_reason,
  "Stopped …", and no buttons; the status line as in 4.3b.
- **Not started with the checks expired** (decided by Alex, s6b): a link whose run failed as 'expired_not_picked_up'
  counts as unused for the rerun ("Run the pre-check and rehearsal again"), so it is no dead end. The page keeps the
  not-started panel, says it can't be resent and that the link counts as unused, and offers the rerun; once the
  rerun passes, the page offers the data operation (scenario not-started-expired). The stored run that comes with
  the page is still the old one: a rerun_at later than its consumed_at supersedes it, so the page shows the
  rerun-waiting state while the evidence is still expired, and the data operation once it passes (never Try again). switchboard_consume_run_link's
  rerun mode (part 5) accepts such a link at B1.
- **Correction scenarios** (decided by Alex, s6b): only the field edit exists now; value, records, sandbox filter and
  code are added in A7.
- **The undo page's triggers-and-flows step** (agreed with the hub, s6b): "Confirm the triggers and flows are the same
  as when the run was recorded. If they differ, the undo stops with nothing changed."
- **Render test** (s6b): simulation.test.js renders every scenario through /run-sim/:scenario, with the desktop ready
  and not ready, and fails on any render error or logged error.
- **Correction**: "After you approve" names only what its steps do; when version and changed.from_version are both
  sent, the version must be one up. "Selected by" for a stopped run's undo is built ("The N records the stopped run
  changed."), never typed.
- 4.1 additions: phases[].state also interrupted, phases[].rerun, rerun_at, undo_of, interrupted, and the stored run
  {consumed_at, picked_up_at, finished_at, failure_reason} that comes with the page, not in the request.

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
  checks are expired, the link unused (a link whose run failed as 'expired_not_picked_up' counts as unused: part 4.7)
  and the version unchanged, it sets rerun_at (not used_at) and hands the pre-check
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
  or Check again: failure_reason 'expired_not_picked_up', or consumed, never picked up, approved over 15 minutes ago
  (agreed with plumbing: part 4.5). The retry fails the stale action in the same step that creates the resend.
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
- **The "Desktop not ready" section** (s4b). When the desktop isn't ready for any reason (both down, panel only,
  helper only, no extension, no answer, or the check failing at the Approve click), one section stands in place of the
  Approve button, above "Don't run" and its reason box: a pale red background with a red outline (red means a problem;
  orange stays the production warning); a bold heading "Desktop not ready"; the reason sentence with its fix and its
  "(checked …)" ending, for example "The Switchboard panel and the helper aren't running. Start Switchboard on your
  desktop. (checked when this page opened)"; then "Check again", aligned left, in the primary BUTTON style. While a
  Check again is in flight the section stays, reading "Checking the desktop…" with the button disabled. When the
  desktop is ready, the plain "Desktop ready…" line stays in its place after "This run will:", and Approve is shown.
  Once the run is sent or not run, or the page offers no action (a closed undo, a used link, a rerun already asked
  for), there is no section; the plain line shows the answer without its fix sentence. With the checks expired the
  section stands in for the rerun (part 4.7). The reason line is a status region, so a screen
  reader announces each new answer.
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
  source refuses anything marked simulation. The database (B1, Q7, part 10a) accepts a request marked simulation and
  spends its link, but never makes a helper action, a run or a sample for it.
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

### 10a. B1 as drafted (s10, 2026-11-23)

**Progress (s10b):** the draft is supabase/migrations/250_run_pages.sql (the _pending_ file with its header renumbered,
nothing else changed; the _pending_ file is deleted), queued as action 9f97e4f0-7206-4b38-8155-2bd5a48d2af3.
**250 is live (s10c):** applied by run 7b3d9c6f-cd30-4f9b-b8f8-1d5228aa31bb at 14:49 on 2026-11-23; its last statement
returned CONFORMANT, 123 tables. The tests are queued with --test: 1_verify.sql as action
ba3158d1-a9f6-492d-9f70-2f4c9089be05 and 2_failure_test.sql as action 5570a7b6-7fd1-4dab-ad8e-2b8275a1adec; both must
say all_passed (1_verify conformant). A fix now is a new follow-up migration, never an edit of 250.
**Results (s10d):** 1_verify passed 69 of 69, CONFORMANT (run 10e1cc34-87e8-44d8-9056-40dcd3db952b). 2_failure_test
passed 61 of 62 (run e0ed0259-4bb3-44a7-adfc-5842946be2db); read_deleted_the_sample failed through a test bug, not the
migration: its NOT EXISTS ran in the same statement as the switchboard_run_preview call that deleted the sample, on
that statement's earlier snapshot. The preview now runs in its own statement; nothing else in the test changed.
Requeued as action a1b57bfc-6aa1-46f8-9b05-a03e033faae1.

**Drift check** (main through f0cd169: 247_pickup_expiry.sql, 248_sf_run.sql, switchboard-runner): matches plumbing's
summary. sf_run is inserted by a security definer function or the service role; the guard stores it consumed with
link_hash, link_expires_at and link_used_at null and created_at capped at now() (approval time = created_at).
switchboard_actions_sf_run_payload needs a JSON object with link_id a lower-case uuid; switchboard_actions_sf_run_click
and switchboard_needs_click keep needs_click true. switchboard_queue_helper refuses sf_run, and authenticated has no
insert on switchboard_actions. switchboard_pickup_helper(p_user, p_kinds default null, p_pickup_id default null) hands
it out only when sf_run is named, within 15 minutes of created_at; past that either pickup fails it (consumed to
failed) with switchboard_runs.failure_reason 'expired_not_picked_up' (the column name is confirmed).
switchboard_pickup_git(p_user, p_pickup_id default null). Nothing else on main touches this step's tables or functions.

**Decisions in the draft** (supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql):
- No B1 function calls a pickup function; consume and retry insert the sf_run directly, and the guard does the rest.
  switchboard_actions is not altered (no index, no check), so db:table:switchboard_actions is not claimed.
- **Payload is {link_id} only.** The link records which action is the approval (action_id) and which the rerun
  (rerun_action_id), so the helper (data runs) reads what to run from the link id.
- **The link rules are database checks** in switchboard_consume_run_link: caller's link, not voided, unused
  (approve), request at the link's version, fingerprint = switchboard_fingerprint(request + version) as the page showed,
  checks within 24 hours of the oldest evidence not voided (never for an undo), a data operation has evidence, a
  delete's undo before its deadline, p_count = the request's total_count (dataop, undo), code rehearsed and reviewed at
  its commit, p_desktop {answer: running, panel: true, helper: true} (stored on the link), and Q10 by a read.
- **"The typed count"** at approval is p_count, the count the page showed and Alex approved; it must equal the
  request's count. The count Alex types in the terminal is checked by the data runs thread.
- **Simulation (Q7):** queued with simulation true, its link is spent by consume, but no sf_run action or run is ever
  made, so switchboard_actions and switchboard_runs never see it; it can't hold a sample.
- **Rerun:** only on expired checks; refused while a rerun waits (no check has passed since rerun_at). On a link
  whose approval never started (s6b) the rerun fails that stale action and makes the link unused again, so the same
  link approves the data operation once the rerun passes.
- **Retry** fails a still-consumed stale action (consumed to failed, with its failed run) and inserts the same payload
  again in one statement block; the link's action_id (or rerun_action_id) moves to the new action.
- **Corrections:** a wording or allowance edit keeps the version (live links stay live; the page reloads as the
  fingerprint changed); every other edit raises the version, makes the page a correction, voids its rerun evidence and
  the live links, and a code edit supersedes older reviews, in one transaction.
- **One live link per request**, version and review: issue refuses another until it is used or cancelled.
- **Not in B1, for B2:** the evidence (the pre-check's passed checks) and Alex's code review answers (reviewed,
  question, changes required, acks) are written by switchboard-run-pages with the service role; no function for them.
- Samples are registered not audited (no audit copy outlives the 24 hours) and hidden from MCP reads (Q4).

**After the cold review (s10):**
- **Evidence never comes from the chat:** queue and correct refuse an evidence key; only the service role (B2) writes
  it. A data operation's approval needs every pre-check check (count, login, automation, backup, rehearsal) passed and
  not voided, and refuses any check dated in the future. Code: the rehearsal evidence must carry the commit, and a
  review at that commit must say reviewed (code.rehearsed_at from the chat proves nothing).
- **A request version is approved once:** issue refuses a new run link, and consume a second link, once a run link of
  that version was used (s6b's freed link excepted).
- **Q10 under a lock:** consume and retry take the same advisory lock as switchboard_issue_link (227) before the read,
  and count a today's-kind action live from coalesce(link_used_at, created_at), as the pickup does. Only this link's own
  stuck action is left out.
- **Locks in one order:** consume and retry lock the request, then the link, as correct does, so they never deadlock.
- **A stale action fails once:** only while still consumed and unpicked, and its failed run is written only then.
- **Rerun waiting** means the last rerun's action is approved and unfinished (picked up, or within its 15 minutes); a
  rerun that finished, passed or failed, leaves the way open.
- **Corrections** never change operation.kind or operation.object, whatever kind is named; a wording or allowance
  edit may change only the headline, side effects, problem wording and what diagnosis allows. A correction keeps
  base_page (the page it was queued as); B2 sets page back to it once the reruns pass, and the write's checks apply
  only on a dataop or undo page.
- **Q4 held in the database:** a restrictive policy closes switchboard_run_samples to direct reads by any signed-in
  session; only switchboard_run_preview (security definer) returns a sample. Links are not audited, so no token hash
  reaches the audit log.
- **Code review answers:** switchboard_code_reviews.answers keeps each answer's full text (up to 1000 characters) with
  its kind (reviewed, question, changes_required); a question keeps the status open (B2 writes them).

### 10b. B2 as built (s11, 2026-11-24): switchboard-run-pages

- **Deployed** (project zuqjyfqnvhddnchhpbcz) with verify_jwt = false in config.toml: the helper's /evidence and /sample
  carry x-switchboard-pickup-key and no JWT; every page route checks Alex's JWT itself (auth.getUser, and the user must
  be CLIPBOARD_USER_ID). Smoke test after the deploy: POST /preview with no JWT and with a made-up JWT, and /evidence with
  no key, each 401 {"ok":false,"error":"unauthorized"}; an unknown route 404.
- **Alex's routes** (POST, CORS): /preview {token}, /approve {token, fingerprint, desktop, count}, /rerun {token,
  fingerprint, desktop}, /resend {token, fingerprint, desktop}, /cancel {token, reason?}, /review {token, answer:
  reviewed|question|changes_required, text?, acks, desktop?}. Each calls the 250 function with a client built from his
  JWT; the database's refusal text comes back unchanged (status from its code: 28000 401, P0002 404, 23514/22023 400,
  else 409). Each reply carries "line", the result line of 4.4; a simulation's is "SIMULATION "-prefixed and carries
  the link's uuid (the "sim-" ids are the page simulation's only). The cancel note is one line, cut to 200 with "…".
- **The service role**, only for what 250 reserves for it, each read narrowed to CLIPBOARD_USER_ID:
  - /evidence {link_id} records the passed checks of the link's finished pre-check run (the approval on a pre-check or
    correction page, else the rerun) from that run's own switchboard_runs row: result {ok: true, pass: true, checks:
    [{check, org, commit?}]} with passed_at = finished_at and run_id (proposal for the data runs thread: the helper's
    /result for an sf_run carries checks). Nothing but link_id is read from the body. Refused for a simulation, a voided
    link, a link for an older version, and a run finished before the last correction; recorded once per run; older
    entries for the same checks stay, voided. A correction returns to base_page once every check it voided is in use
    again (and, for a data operation, every write check); the request's page key follows, so its fingerprint changes
    and an open page previews again. The write happens only if the request is unchanged since read (updated_at).
  - /sample {link_id, sample} calls switchboard_store_run_sample for the link's request.
  - /review writes the answer (found first through switchboard_run_preview with his JWT): refused when superseded,
    answered, or through a voided or no-longer-current link; "reviewed" needs every For-you finding acknowledged and the
    desktop ready; the full text (up to 1000) is appended to answers, acks merged; a question keeps it open; written
    only if the review is unchanged since read.
- **Superseded by 10c (s12, s12b):** /evidence and /sample and the pickup-key handling are removed; the evidence write
  is the database function switchboard_record_run_evidence, called by the runner. The gap below is closed by migration
  251, and a pre-check's checks reach its data operation through pre_check_request_id (10c). The redeploy without the
  helper routes was done at s12e. /approve's line for a correction's Approve (as_rerun) is `run <id> reruns`;
  /rerun and a write keep `run <id>`.
- **Live (s12e, 2026-11-24):** 251 applied (action b32ebcc8-313e-418a-b85b-d88780f69dc2, run
  80ed01f1-6c26-454d-8d7d-d376d4e0b42d, 21 statements, CONFORMANT, 123 tables); the first queue of it (170f9522) never
  ran. switchboard-run-pages redeployed without the helper routes; smoke test: /preview with no JWT 401
  {"ok":false,"error":"unauthorized"}, /evidence and /sample 404. 3_followup_test.sql queued with --test (action
  566672f2-7d2d-4ecc-99c5-0b8b9319b502); its result is still to read.
- **Was open, for a follow-up migration (found by B2's cold review, s11):** a correction page's Approve sets the link's
  used_at, so once /evidence returns the request to its base page that link is "already used", and
  switchboard_issue_run_link refuses a new run link for the same version: the corrected data operation can't be
  approved. Proposed fix: a correction page's approval records like a rerun (rerun_at, rerun_action_id, the s6b
  pattern) so the link stays unused, and /evidence reads rerun_action_id for a correction. Also to confirm: how a
  pre-check request's passed checks reach its data operation request (today they land on the pre-check request).

### 10c. The follow-up (s12): the correction gap closed, and the evidence in the database

- **Alex's option A (s12):** the desktop helper talks only to switchboard-runner, never to switchboard-run-pages. The
  runner takes the check results and the sample from the helper's result and writes them by calling database
  functions with the service role. switchboard-run-pages loses /evidence, /sample and its pickup-key handling; its six
  page routes are unchanged, and its service role now only writes the code review answers.
- **The gap (10b) closed:** switchboard_consume_run_link is replaced so a correction page's Approve is recorded like a
  rerun (rerun_at, rerun_action_id; reply as_rerun: true). The link stays unused; a second correction Approve is refused
  while the first is approved and unfinished (picked up, or within its 15 minutes), and allowed again after it
  finished. Once the reruns' evidence is in and the request is back on its base page, the same link approves the write
  under every 250 rule (fresh checks, count, desktop, Q10, a reloaded fingerprint). Every other 250 rule is unchanged.
- **For plumbing (the runner):** `switchboard_record_run_evidence(p_run_id uuid) returns jsonb`, service role only
  (revoked from public, anon and authenticated). Call it after storing a run page pre-check's result on its
  switchboard_runs row (finished_at set), with that run's id. It reads only that row: result `{ok: true, pass: true,
  checks: [{check, org, commit?}]}` (check one of count, login, automation, backup, sample, rehearsal; org production
  or sandbox; commit a hex hash, rehearsal only in practice), passed_at = finished_at. It refuses a run that hasn't
  finished or didn't pass, a malformed check, a simulation, a voided link or one for an older version, a run that
  finished before the last correction, and any run that isn't the link's pre-check (its approval on a pre-check page,
  or its rerun, which a correction page's Approve now is); a data operation's own run is never evidence. It records a
  run once (a repeat returns already: true), keeps older entries for the same checks voided, and returns a correction
  to its base page once every voided check is in use again (and every write check, for a data operation). Returns
  `{recorded, already, request_id, page}`.
- **The sample:** `switchboard_store_run_sample(p_request_id uuid, p_sample jsonb)` (250) needs no change for the runner:
  it is service role only, and the runner finds p_request_id from the action's payload.link_id
  (switchboard_run_links.request_id). The sample is `{records: [one record, or two for an upsert]}`, stored only against
  valid evidence, so the runner records the evidence first.
- **After the cold review (s12):** only a write's correction (base page dataop or undo) is recorded like a rerun; a
  pre-check's correction Approve spends the link as in 250, and its run (action_id) is accepted as evidence. A
  simulation's Approve always spends its link. switchboard_cancel_run_link is replaced: Don't run is refused while the
  link's rerun (a write's correction or a "Run the pre-check and rehearsal again") is approved and unfinished. The
  evidence function refuses a result naming a check twice, and a run older than the evidence already in use for one of
  its checks (an older run never replaces newer evidence).
- **Notes for plumbing:** record the evidence (switchboard_record_run_evidence) before, or in the same transaction as,
  moving the rerun action out of consumed: a second correction Approve can only come once it has left consumed, and it
  moves rerun_action_id, after which the first run is no longer this link's rerun. A pre-check's result must name every
  check the correction reran (a records edit reruns count, backup and sample), or the request stays a correction.
- **Decided (Alex, s12b): the pre-check's checks reach the data operation (option A).** The chat queues a production
  data operation with **`pre_check_request_id`**: the id of the Pre-check and Rehearsal request whose checks passed.
  switchboard_queue_run_request (replaced in 251) copies that request's checks in use onto the new request, server-side;
  the chat still never supplies evidence (an `evidence` key is refused, with or without the id). Its reply adds
  `copied_checks`. The rules:
  - Copied checks keep the time they first passed (and their org, run_id, commit), plus `copied_from`: nothing resets,
    and the 24 hours count from the oldest in use. A copy over 24 hours old is accepted but can't be approved; its page
    offers the rerun.
  - Copied only when the data operation matches what the pre-check checked, by the correction table (3.2 d): the
    object, the operation kind, the records or filter (selected_by without sandbox_text and not_rehearsed), the count
    (the write's count is the pre-check's counts.total, else its expected, which it must have; expected and the other
    counts equal), the field, the value, the file, the operation's other details
    (external id, steps), the sandbox filter, the code commit and the target org. Wording, side effects and what
    diagnosis allows may differ. Otherwise refused, naming every mismatch ("differs from what its pre-check checked: the
    field, the value").
  - Same user (another user's request is "no such pre-check request") and same project; a simulation and a real
    request never share checks; the named request must be a pre-check on its pre-check page (not mid-correction) with
    passed checks; only a data operation may name one.
  - Added (s12b): one pre-check backs one approved write. The queue refuses a pre-check whose copied checks already
    backed an approved data operation, and switchboard_consume_run_link checks it again at the click, under the
    project's advisory lock, so two requests copied from one pre-check can't both write, nor one request twice (a used
    link of an earlier version of the same request counts). Keys set to null count as left out.
  - Closed (Alex, s12c, in 251): switchboard_correct_run_request is replaced so each edit kind changes only its own
    row of the correction table, besides the wording keys and, for a kind that reruns a check, the run's own steps,
    phases, details, kept, run_tag and still_valid: value operation.value; file operation.file; field operation.field
    and undo; records selected_by (not its kind or sandbox filter), counts, operation.steps and undo; records_filter
    all of selected_by (its sandbox filter too), counts, operation.steps and undo; sandbox_filter selected_by.sandbox_text
    and not_rehearsed; code the code. Ids to a filter is a records_filter correction. Any other change is refused, naming the field (orgs, selected_by.text,
    counts.total). 250's supersede of older reviews on a code correction is kept exactly.
  - Closed (Alex, s12c): no correction changes or drops pre_check_request_id; refused, naming it.
  - **Where the sample lives at the write (s12c):** when the queue copies a pre-check's checks it moves the pre-check's
    switchboard_run_samples row to the new data operation request, expires_at unchanged (reply `moved_sample`). The
    production approve page's preview shows it; the pre-check's page no longer does. The runner drops it from the
    write's own request (switchboard_drop_run_sample with the data operation's request id) at the write's final
    status. No sample on the pre-check: nothing moves. Open (for Alex): two data operations queued from one pre-check
    before either is approved; the sample goes to the first, so if the second is approved its page shows none.
- **Result line (Alex, s12b):** a correction's Approve (as_rerun) posts `run <link id> reruns`; a write approval stays
  `run <link id>`. Plumbing adds "reruns" to the extension's POST_LINE. The page builds it (runRerunsLine) from the
  approve reply's as_rerun; switchboard-run-pages' /approve follows at s12c.
- **For B3 (the queue tool):** the code review of a data operation that carries code is recorded on the data
  operation's own request (consume checks switchboard_code_reviews by request_id), not on the pre-check's.

### 10d. B3 as built (s13b, 2026-11-24): the MCP tools

- **One copy of the rules.** supabase/functions/_shared/tools/switchboard-runs.ts imports
  src/switchboard/runs/runContract.js itself (requestProblems, codeReviewProblems, EDIT_RERUNS), as samScores.ts and
  notify-dispatch already import from src/. For that, runContract.js imports `./codeDiff.js` (with the extension, which
  Deno and node need and CRA accepts), and supabase/functions/mcp/deno.json maps `diff` to `npm:diff@5.2.0` (the
  version package.json pins). codeDiff.js needed no change: its only import is `diff`. Neither file imports anything
  else, and both are on main.
- **The tools**, each running the page's rules first (a refusal lists every problem, and nothing reaches the
  database), then its 250/251 function, whose refusal comes back word for word as "refused: <message>" (codes 28000,
  P0002, 55000, 23514, 22023, 22P02; anything else is an operational error, without refusal wording):
  - queue_switchboard_run_request, **tier 2**: it adds a request row, which nothing acts on until Alex approves its
    page, but with pre_check_request_id it also updates an existing row (the pre-check's sample moves onto the new
    request), and an update of an existing row is tier 2 (cold review, s13b). It takes {request}; refuses evidence, a sample and a correction before anything; pre_check_request_id only on a data
    operation, a uuid (lower-cased). Returns {request_id, version, copied_checks, moved_sample}.
  - correct_switchboard_run_request, **tier 2**: it updates an existing request, raising its version and voiding its
    checks and live links (audited, reversible by a new correction or request). Takes {request_id, edit_kind,
    request, changed}; it reads the request's base page, then runContract checks the corrected request on its base
    page (counts, undo, deadlines) and, for a kind that reruns a check, its steps as a correction page's (only what
    the edit reruns). pre_check_request_id is lower-cased, as the queue stores it.
  - issue_switchboard_run_link, **tier 2**, as issue_switchboard_link: it inserts the link row a page opens with. Takes
    {request_id, review_id?}; returns {link_id, url, headline, version} whole.
  - record_switchboard_code_review, **tier 2**: it adds a review and marks older reviews of the request superseded (an
    update). Takes {request_id, review}; codeReviewProblems first; refuses status, acknowledged, acks, answers and
    superseded_by (Alex's side, on the page).
  None is tier 3: approval is never in the chat, it is Alex's click on the page.
- **queue_switchboard_git:** gitnewtree's client, lane (Fast track, Main, Side road, Country road) and main (true only)
  are in its schema, from plumbing's GIT_KEYS on main. The schema is `z.object({...}).strict()`: an unknown key is
  refused by the SDK's parse (MCP error -32602, "Unrecognized key"), before the handler and so before any link, and
  the advertised JSON schema has additionalProperties: false. Every key it took before is kept. Before this,
  client, lane and main were stripped by the schema and never reached gitnewtree.
- **Deployed (s13c, 2026-11-24):** mcp deployed to zuqjyfqnvhddnchhpbcz after the gitsync (action
  f3a62469-e19a-4eee-b3ed-4e5f8d0d806e; it brought nothing under mcp/ or _shared/tools/). Smoke test, read-only: a live
  queue_switchboard_git call with an unknown key and a bad project code was refused by the server's parse, "MCP error
  -32602: Input validation error: ... Unrecognized key", before the handler and so before any link. The four new
  tools show only once the claude.ai connector reconnects (the session's tool list is cached at its start); the
  listing check is that reconnect.
- **From B3's cold review:**
  1. Closed by 252 (s14, drafted): a correction that reruns a check keeps the request's own steps and phases in
     request.base_steps and base_phases, taken from the row and never from the chat (a correction drops a chat-sent
     base_steps; a second correction keeps the first one's), while the correction page shows only its rerun steps.
     Closed (Alex, s14b, in 252): switchboard_queue_run_request refuses base_steps and base_phases from the chat,
     naming the key ("leave base_steps out: only a correction keeps the request's own steps and phases"), as it refuses
     evidence; everything else in it is 251's, unchanged. 252 is numbered 252_correction_steps.sql.
     switchboard_record_run_evidence restores them when the request returns to its base page, and a multi-object run's
     write_step entries take their object, kind and count from operation.steps, so a records correction's counts carry
     through. A request with no phases of its own gets none back. A request corrected before 252 has no base_steps
     and keeps its steps on return.
  2. Closed by 252: a correction whose kind reruns the rehearsal (value, file, field, records_filter, sandbox_filter,
     code) may add exactly one {alias, org_type sandbox, role rehearsal} org to a request that has none. Any other
     orgs change, a second sandbox, a non-sandbox rehearsal org, swapping an existing sandbox, or adding one on a kind
     that doesn't rerun the rehearsal is refused ("it also changed orgs"), as is a sandbox under an alias the request
     already uses (the target's, say).
  2a. Also in 252 (cold review): a records or records_filter correction may change a multi-object run's step counts,
     never its steps' objects, kinds or number (251 left operation.steps out of the comparison whole). The kept base
     steps keep any null fields inside them.
  3. Closed by B4 (s15b): changed.still_valid and phases[].state "passed" came from the chat; consume reads only the
     evidence column, so approval was safe, but the page could show passes that don't exist. The real source builds
     both from the evidence (10e).
- **Also in 252:** a wording or allowance edit keeps the row's page key. 251 stored the chat's page, so a wording edit on a
  correction page set request.page to the base page while the row stayed a correction. On a correction page it also
  keeps the correction's changed block (the page shows what it reruns) and adds the wording edit as changed.wording.
- **252 live (s14c, 2026-11-24):** applied (action af4a4305-53dd-4d48-b23c-e0733ea127cc, run
  8917e8e6-02ee-4108-a358-aaf41bdb79c7, 13 statements, CONFORMANT, 123 tables). 4_correction_steps_test.sql queued with
  --test (action 9283ede0-b2a8-4e95-bc02-db205f724c5c).

### 10e. B4 as built (s15, s15b, 2026-11-24): the live pages

- **Routes** (src/App.js, beside /approve/, which is unchanged): /run/:token and /review/:token, both lazy-loaded
  (src/switchboard/runs/LiveRunRoute.jsx). A signed-out visitor gets "Sign in with Google", which returns to the same
  address. The preview is read once at open. An unknown token shows the function's (the database's) own words; a
  voided link "This link was voided (<reason>). Nothing was approved."; an outdated one "The request was corrected since
  this link was issued. Nothing was approved." (the wording of switchboard_consume_run_link's refusals). A review link
  on /run/, or a run link on /review/, says which address to open. /run-sim/ stays dev-only.
- **Data layer** (liveSource.js): callRunPages POSTs switchboard-run-pages/<route> with the session's JWT and the anon
  key; a refusal throws a RunPagesError carrying the function's error text word for word, and the pages show it with
  nothing added (refusalNote, look.js). liveRunSource and liveReviewSource are the real sources. Their kind is fixed from
  the database's request.simulation: 'real' only when it is false, so the SIMULATION strip shows otherwise. Approve,
  rerun and resend send the token, the preview's fingerprint and the newest desktop answer (asked at open, on Check
  again and at the click, Q9); Approve also sends the count: the preview's total_count, exactly (s16). The review
  answers send token, answer, text, acks and the desktop.
- **Status from the evidence** (runContract statusFromEvidence): on a pre-check, data operation or correction page the
  phases are rebuilt: "Pre-check and rehearsal" passed when every write check (count, login, automation, backup,
  rehearsal) is in use, at the newest, "(run again)" when that came after rerun_at; "Data operation" waiting once it
  has, else not started. A correction's "Still valid" is every check in use with its own time. The expiry was already
  validUntil(evidence). An undo or check page keeps the chat's phases: they report the earlier run, which has no
  evidence here (for Alex: the runner could record that run's outcome for them later).
- **Result lines:** the pages show the function's own reply line: `run <id>`, `run <id> reruns`, `run <id> resent`,
  `run <id> cancelled[: <note>]`, `review <id> ...`, each "SIMULATION "-prefixed for a simulation. A simulation's
  ResultLine has no data-switchboard-status block, so the extension never posts it (plumbing L3). The
  data-switchboard-project and data-switchboard-kind marks are unchanged.
- **After the cold review (s15b):** the preview's run is the link's newest sf_run, which may be a rerun (a correction's
  Approve or the expired-checks rerun). The real source never treats a rerun as the write: while it is approved and not
  finished the request carries rerun_pending and the page waits with no Approve; once it finishes, the same link offers
  what comes next (Approve after a pass, the rerun again after a failure). "Still valid" lists only checks that passed
  before the correction. A correction's Approve says "Once they pass, this same page offers the data operation." A
  review already answered shows its answer with nothing to click. A simulation's ended link keeps the strip.
- **Closed in s16 (both s15b open items):**
  1. **The count.** The page worked the count out from the request's counts, which a correction could leave apart
     from total_count. Now migration 253 (numbered at s16; written and queued at s16b) has switchboard_run_preview
     return the row's total_count at the top level, every other behaviour of 250's preview unchanged. The page sends
     exactly that with Approve (approveCount(preview)), never a number of its own; with none it sends null, which a
     write refuses. On a write page (data operation, undo) the count shown (shownTotal: total or expected;
     undo_up_to or expected on an undo) must equal total_count; when they differ (a correction can part them) the
     page offers no Approve and says why, so Alex never approves a number he wasn't shown. The page needs 253 applied
     before it ships; until then a write's Approve is refused on the count,
     and nothing runs. Test: supabase/tests/sb3_pages-h6v/5_preview_count_test.sql.
  2. **The error boundary.** RunErrorBoundary (look.js) wraps each live route, keyed by token: a render failure, or a
     failed load of RunPage or CodeReviewPage (now lazy-loaded inside it), shows "This page couldn't load. Nothing has
     run." with a Reload button in the run page's look, with no strip and no Approve. A failed getSession now ends in
     the message too, rather than staying on Loading. s16b: App.js imports RunErrorBoundary from look.js and wraps
     the two lazy routes (/run/, /review/) outside their Suspense, so a failed load of LiveRunRoute's own chunk shows
     the message too. /approve/ and every other route are unchanged.
  3. **s16b:** 253_preview_count.sql written (the s16 _pending_ file, header renumbered, body unchanged), the
     _pending_ file deleted, 253 queued. 5_preview_count_test.sql follows once 253 is applied (s16c).
  4. **s16c:** 253 is live (action 6b041669-0b30-4a6a-9eef-069205953db1, run b11a37fb-4495-4e4d-8dfa-c0f63888d9a6,
     CONFORMANT, 123 tables). 5_preview_count_test.sql queued with --test (action
     756bd1ca-160b-465c-8fd0-123fc42a9536); its result must say all_passed, 19 of 19. B4 and 253 are committed on
     this branch (bfb2e49) and merge with 254's Checkpoint.

### 10f. The write's outcome (s17, 2026-11-25; migration 254, agreed with plumbing and the hub)

Plumbing's runner keeps only {ok, exit_code, pass, checks} on a run row, and switchboard_prune_runs clears a run's
result after 30 days, so a data operation's or undo's outcome is kept on its request.
- **Columns** on switchboard_run_requests: outcome (jsonb: a JSON object of at most 64 KB, stored as given), outcome_run_id
  (uuid), outcome_recorded_at (timestamptz). All null until recorded, and all three set together (a check constraint).
- **switchboard_record_run_outcome(p_run_id, p_outcome)** returns {recorded, already, request_id}, for the service role
  only (the runner, after a write's result). It is accepted only for a run that exists, is mode real and has finished
  (succeeded or failed), whose action is an sf_run that its link approved (link.action_id = the run's action_id), on a
  request whose base page is dataop or undo, not a simulation. Refused:
  - a pre-check's run (base page precheck);
  - a rerun (a correction's Approve or the expired-checks rerun set rerun_action_id, never action_id);
  - a run a resend superseded;
  - an unfinished run, a dry run, or a run that never started (expired_not_picked_up);
  - a non-object or an outcome over 64 KB.
  Once per run: the same run again returns already true and changes nothing. A later run of the same link (a resend)
  replaces it, since only the link's current action is accepted. A run approved through another link never replaces
  it: a request corrected after its write can be written again through a new link, and the first write's outcome
  stays as the record of a real change (the second write's outcome is then refused, for Alex below). It locks the
  request, then the link, as consume does, and checks the link's action again under the lock. It never touches
  evidence, the 24-hour clock, the page, the version or the count, so nothing about what can be approved changes.
- **switchboard_run_preview**: 253's, plus outcome, outcome_run_id and outcome_recorded_at at the top level, only on the
  link whose approved run recorded the outcome (null on any other link of the request). The page also shows it only
  once its link is used.
- **Alex's choice (s17b, option A): once a write has run, the request can't be corrected.** A further change is a new
  request through diagnosis, with its own pre-check. 254 also replaces switchboard_correct_run_request whole: 252's,
  plus one refusal first, before anything changes. On a data operation or undo request, every correction kind,
  wording included, is refused while an approved write on it has started or may still start: a link's approved action
  (link.action_id) that was picked up, has a run (other than one marked expired_not_picked_up), or is still consumed
  and within its 15 minutes. The refusal says "switchboard_correct_run_request: a production write already ran on this
  request (action <id>); queue a new request through diagnosis. No link was issued." Only a write that never started
  (failed as expired_not_picked_up, or consumed, unpicked and past 15 minutes) leaves the request correctable.
  Pre-check requests are unaffected. Consume locks the request first, so an Approve can't cross a correction; a
  pickup locks only its action, so the correction locks every approved action of the request before it reads them.
  Test: 6_run_outcome_test.sql (36 checks). **s17c:** 254 is live (action 274a4371-64e1-46b8-b085-87c674e219d3, run
  fb4a48a5-051e-412a-acd4-b5b5ca632651, 17 statements, CONFORMANT, 123 tables); the test is queued with --test
  (action d9f8a2cc-1258-409c-9030-8555fc451d0c) and must say all_passed, 36 of 36. A request is then written once, so one outcome slot is enough; "the first
  write's outcome is kept, another link's is refused" stays as a backstop.
- **The display** (RunPage's Outcome, below the status line, on data operation and undo pages only). The shape belongs to
  the data runs thread, so the page reads only the parts this design names (runContract outcomeView), and a missing or
  malformed part is simply not shown:
  - `changed`, a count: "Changed: N records";
  - `rows`, [{label, before, goal, after, knock_on}]: a Check / Before / Goal / After table, knock-on rows last and
    labelled "Knock-on:";
  - `stopped`, {already_changed, saved_on_pc (text or a list)}: "Stopped. Already changed: N records" and "Saved on
    the PC:" with each path.
  Nothing else in the outcome is shown. Simulations: run-finished-outcome and run-stopped-outcome.
- **For the data runs thread to confirm:** the key names above (changed, rows with before/goal/after/knock_on, as
  sb/lib/prodrun.mjs displayCopies plus after, and stopped.already_changed and stopped.saved_on_pc). The database
  doesn't depend on them; only the page does.
- Test: supabase/tests/sb3_pages-h6v/6_run_outcome_test.sql.

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
consumed, never picked up, approved over 15 minutes ago, pending plumbing's agreement (since agreed: part 4.5
supersedes this); Q12 one click, buttons disabled
while busy.

## 13. Files

- src/switchboard/runs/: look.js, runContract.js, RunPage.jsx, desktopCheck.js, CodeReviewPage.jsx, codeDiff.js,
  simulation.js, RunSimulation.jsx, each with its test.
- src/App.js; package.json and package-lock.json (`diff`, A6).
- Phase B: supabase/functions/switchboard-run-pages/; supabase/config.toml;
  supabase/functions/_shared/tools/switchboard-runs.ts and its test; supabase/functions/mcp/index.ts and its test;
  supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql; supabase/tests/sb3_pages-h6v/.
- Not touched: ApprovePage.jsx, ApproveFixture.jsx, switchboard-runner.

## 14. Phase C: switch-over plan (s18, 2026-11-25; a plan only, for Alex to approve)

Main at 9b2b29b holds 250-254, switchboard-run-pages, the four run-page MCP tools, and the live /run/ and /review/
pages beside today's /approve/ pages (unchanged). The end-to-end test waits for plumbing's extension reinstall (L3).

### 14.1 Inventory: today's /approve/ page kinds

ApprovePage.jsx renders every kind from the runner's preview. The url's `?kind=` is display only (sql, git or deploy;
anything else shows as sql). Each kind keeps its `data-switchboard-*` marks and its result line word.

| Kind (line word) | Queued by | What it shows today | C changes it? | Why |
|---|---|---|---|---|
| sql (`sql <run id>`): dry run, then Approve | scripts/sql-queue.mjs, issue_switchboard_link | SQL, the dry run's counts, "Approve and run for real" | look and heading | No new page replaces it; the heading goes ("Approval required" is enough) |
| sql test (`sql <run id>`): runs on open | sql-queue.mjs --test | the test result; no red bar, no heading already (s90d) | look only | It already has no heading, and runsByItself keeps it without the bar |
| git (`git <action id>`), with gitpush Finish's no_prod_deploy line and then.send chain | queue_switchboard_git | the command lines, Approve and run | look and heading | Unchanged behaviour; it is not a run page |
| sb_setup (`sb`) | queue_switchboard_sb_setup | sb lines, the files it writes | look and heading | as git |
| sf_check (`sf`) | queue_switchboard_sf_check | the check lines | look and heading | as git |
| sf_read (`sf`), with the red PRODUCTION FULL DATA banner | queue_switchboard_sf_read | the read's lines | look and heading | as git |
| sf_dataquery (`dataquery`), orange production or sky-blue sandbox read banner | queue_switchboard_sf_dataquery | the queries, their hashes, the mode | look and heading | Read only, diagnosis's counts and exports. Not a write, so the run pages don't replace it |
| sf_dataop (`dataop`): Data run v1, production write | queue_switchboard_sf_dataop (from `sb prod dataop-link`) | the stamped plan's rows, the write | heading now; **retired** later (gated) | "The old data run link is retired": the run pages replace it. Common Defense ran on it |
| sf_datawrite (`datawrite`): Data run v2, bulk, batch or undo | queue_switchboard_sf_datawrite (from `sb prod datawrite-link`) | the gate, write, check and upload steps | heading now; **retired** later (gated, see Q1) | the run pages replace it too. Clients may have runs mid-flight on it |
| sign-in, loading, ended link | (every kind) | plain text | look and heading | no marks |
| /approve-fixture/:kind (dev server only) | ApproveFixture.jsx | ApprovePage on fake data | follows ApprovePage | its tests follow |

Untouched by C: the runner (switchboard-runner), the link builder (migrations 189-227: `/approve/<token>?kind=..`,
and the `stakes=change` that claude-watch.js matches in the chat), the /run/ and /review/ pages, and every database
function.

### 14.2 The steps, in order

**Safe now (no behaviour change):**

**C1. Today's pages take the look from look.js, and the heading goes.** One CLI step.
- Files:
  - new src/switchboard/format.js holding localTime, shortHash and shortStamp;
  - ApprovePage.jsx re-exports them, so its callers and tests are unchanged;
  - look.js imports them from format.js instead of from ApprovePage, which breaks the circular import before
    ApprovePage imports look.js;
  - ApprovePage.jsx uses look.js's BUTTON, SECOND_BUTTON, RED_BAR, the banner classes and RunShell (with
    `approvable` = needsApprovalHeader, and `source={kind: 'real'}`);
  - ApprovePage.test.jsx and ApproveFixture.test.jsx update.
- Changes: the frame and the "Approve" heading (gone on every kind; inbox note ac562aef). Kept: Shell's red bar only
  while the page waits for a click (runsByItself), every word, every button, every `data-switchboard-*` mark, and
  ApprovePage's own ResultLine with its status block. look.js's ResultLine is not used here: with `sim` it drops the
  status block.
- Before it: nothing gates it. Don't deploy it while a client fix has an /approve/ link open (a reload mid-approval
  would show the new look). Alex names any that are open.
- Check:
  - a new test renders every kind (fixtures for sql, sql test, git, sb, sf_check, sf_read, dataquery both org types,
    dataop, datawrite bulk, batch and undo, cancelled and sent) and asserts the same `data-switchboard-*`
    attributes and values, and the same result line text, as before C1;
  - no SIMULATION strip on any kind;
  - the red bar exactly where it was;
  - no "Approve" heading;
  - the runs folder, the app suite and build;
  - Alex looks at /approve-fixture/<kind> in desktop Chrome.
- Roll back: revert the commit; there is no data or function change.

**Gated on client work:**

**C2. The old data run links are retired, and new data runs use the run pages.** One CLI step.
- Before it (all three, each named in the prompt):
  1. Alex says Common Defense Fix D and iwh_ab_codefix-p8v are finished. A read shows no sf_dataop or sf_datawrite
     action in switchboard_actions that is queued, linked, consumed or picked up and unfinished.
  2. The data runs runner is live: B4's end-to-end test on a sandbox passed (an sf_run picked up, run, its evidence
     and outcome recorded).
  3. Plumbing's extension is reinstalled with L3: it injects into /run/ and /review/ and posts the run and review
     lines.
- Files:
  - supabase/functions/_shared/tools/switchboard.ts: queue_switchboard_sf_dataop and queue_switchboard_sf_datawrite
    refuse, with one line naming queue_switchboard_run_request and issue_switchboard_run_link. Their argument checks
    stay for one release.
  - mcp/index.ts: their descriptions say "retired".
  - mcp/index.test.mjs and the tools' tests.
  - Deploy mcp (db:deploy, main's commits present).
- Kept: ApprovePage's DataopRun and DatawriteRun renderers and the runner's kinds, so an action already queued still
  shows, approves or cancels; get_switchboard_run and get_switchboard_sf_result for history.
- Check:
  - each retired tool refuses with its pointer;
  - an old action's /approve/ page still renders (a fixture test);
  - a simulated run request goes queue → link → page → `SIMULATION run <id>`.
- Roll back: revert and redeploy mcp. Nothing in the database changed.

**C3 (later, optional; not in the 2): remove what C2 kept.** It comes after C2 has held with no old data run action
open:
- the two renderers from ApprovePage;
- the tools' code;
- the runner's kinds (switchboard-runner, this repo);
- the guard refusing new sf_dataop and sf_datawrite rows (plumbing's actions guard);
- `sb prod dataop-link` and `datawrite-link` (the data runs thread, switchboard repo).

About 1 step here, plus the other threads' own.

**Skills (wrap-up slice, not this thread).** At C2, salesforce-workflow and cli-workflow will need to point at:
- the production write flow: queue_switchboard_run_request, then issue_switchboard_run_link, then the /run/ page
  (pre-check and rehearsal, then the data operation on the same request), in place of `sb prod dataop-link` with
  sf_dataop and `sb prod datawrite-link` with sf_datawrite;
- the result lines: `run <link id>`, `run <id> reruns`, `run <id> resent`, `run <id> cancelled: <note>`, and the
  `review <id> ...` lines, in place of `dataop` and `datawrite`. A `SIMULATION ` line is never posted;
- corrections: correct_switchboard_run_request before a write runs. After that it is a new request through diagnosis
  (254);
- code review: record_switchboard_code_review, then the /review/ link;
- the outcome: the page's "What the run did", from switchboard_run_requests.outcome.

### 14.3 Risks, and how each step avoids them

- **The extension's marks (bridge-core.js 697-741):** it reads data-switchboard-running, -run-id, -project, -kind,
  -cancelled and -reason, and the status block (data-switchboard-status, -status-text, -retry). A renamed attribute
  or a moved status block silently stops posting. C1 keeps ApprovePage's markup for all of them, and its new test pins
  the full set per kind.
- **The route:** the extension's content script matches only `/approve/*` (bridge-core.js 222), and claude-watch.js
  matches `/approve/` links with `stakes=change` in the chat. C1 and C2 change neither the route nor the link.
- **A false SIMULATION strip:** RunShell shows the strip unless the source's kind is exactly 'real'. C1 passes
  `{kind: 'real'}`, and its test asserts no strip on every kind.
- **The circular import** (look.js imports localTime and shortHash from ApprovePage): C1 moves them to format.js first.
- **The red bar's meaning (s86ag):** the bar means "waits for your click". C1 drives RunShell's `approvable` from
  needsApprovalHeader, unchanged, so a sql test still has none.
- **Client runs mid-flight:** C1 changes no behaviour. C2 keeps the renderers and the runner's kinds, and is gated on
  Alex naming both client runs finished and a read showing no open old data run action.
- **Skills that still say sf_dataop or sf_datawrite:** C2's refusal is one line naming the new tools, so a Claude
  following an old skill is turned round, never stuck. The skills are rewritten in the wrap-up slice.
- **Run lines not posted:** without L3 a run page's line isn't posted, only copied. C2 waits for the reinstall.

### 14.4 Estimate

C1: 1 step. C2: 1 step. **Total 2, as planned.** C3 is optional cleanup after C2 has held, about 1 more here, and it
isn't counted. The DB guard and the helper's link commands belong to plumbing and the data runs thread.

### 14.5 Questions for Alex

1. Does "the old data run link" mean sf_dataop only, or sf_datawrite too? **Recommend both:** the run pages replace
   both writes. sf_dataquery stays, since diagnosis's read-only counts and exports aren't writes.
2. Should C2 retire the tools by refusing with a pointer, or remove them? **Recommend refusing** for one release,
   then removing them in C3.
3. Should ApprovePage keep the dataop and datawrite renderers after C2? **Recommend yes**, until no such action is
   open (C3).
4. When should C1 run? **Recommend now:** no behaviour changes. Say which /approve/ links are open, if any, and C1
   waits for them.
5. Should plumbing add a guard refusing new sf_dataop and sf_datawrite rows after C2? **Recommend yes, in C3,** as
   the database's backstop to the tools' refusal.

**Alex's answers (s19, 2026-11-25): all five recommendations.**
- Q1: retire both sf_dataop and sf_datawrite, and keep sf_dataquery.
- Q2: the old tools refuse with a pointer for one release.
- Q3: keep the old renderers until no old action is open.
- Q4: run C1 now, and ship it only when no /approve/ link is open.
- Q5: a database guard from plumbing, in C3.

### 14.6 C1 as built (s19)

- **format.js** (new) holds localTime, shortHash and shortStamp. ApprovePage.jsx re-exports them, and look.js imports
  them from format.js, so look.js no longer imports ApprovePage. ApprovePage imports look.js without a cycle.
- **ApprovePage.jsx:**
  - Shell is RunShell with `source={kind: 'real'}` (so never the SIMULATION strip) and `approvable` =
    needsApprovalHeader (the bar's rule unchanged). There is no "Approve" heading on any page.
  - BUTTON, SECOND_BUTTON, REASON_INPUT, BANNER_LINE and the banners come from look.js: PRODUCTION_BANNER,
    SANDBOX_BANNER, and the new RED_BANNER for PRODUCTION FULL DATA. The classes are the same, only their order
    changed. The result box keeps its own class string, since look.js's PANEL adds text-dark.
  - RunShell's frame adds the card's `run-card` testid and the mb-6 spacer where the heading was; nothing else differs.
  - Every word, every `data-switchboard-*` mark and ApprovePage's own ResultLine with its status block are unchanged.
- **The bar's testid** is RunShell's `run-approval-required` (it was `approve-stakes-change`). Nothing outside the
  tests read it; the extension matches links by `stakes=change` in the url, not the page.
- **Pinned** (ApprovePage.test.jsx, "C1: every kind keeps its marks"): written and run against the code before C1,
  then kept unchanged. For each of 11 previews (sql, git, sb_setup, sf_check, sf_read, sf_dataquery production and
  sandbox, sf_dataop, sf_datawrite batch, bulk and undo) it checks:
  - the running mark while Approve is in flight;
  - the full ordered list of `data-switchboard-*` attributes and values once approved and once not run;
  - the result line;
  - the hidden status block;
  - no SIMULATION strip.
  The sql test, a `?kind=deploy` link, sign-in and an ended link are pinned the same way, as is the status block's
  text and Try again sitting inside it.
- **s19b finding (Alex's screen test 2), a bug from before C1, not caused by it.**
  - What happens: on today's /approve/ page the red "APPROVAL REQUIRED" bar stays after Approve and after Don't run.
  - Why: the bar follows the preview, not the state. Before C1, ApprovePage's Shell drew it whenever
    `needsApprovalHeader(preview)` was true (HEAD at 9b2b29b, ApprovePage.jsx:522-530). Every page past loading passes
    `preview`, and nothing clears it after `setReal` or `setCancelled` (lines 688 and 702). C1 kept that rule exactly
    (`approvable={needsApprovalHeader(preview)}`).
  - Where: the live page as well as the fixture, every kind.
  - The run pages differ: their bar goes once nothing can be approved.
  - Pinned: the marks tests now assert the bar is still there after Approve and after Don't run, for every kind. A
    fix flips those asserts.
  - **Proposed fix, a separate step:** pass `approvable` only while an Approve is still on offer:
    `needsApprovalHeader(preview) && !real && !cancelled`. On sql, also not while the dry run is running, and not when
    its counts differ (Approve is disabled then). Flip the pinned asserts and add the sql cases. The extension doesn't
    read the bar, so its marks are untouched. About 10 minutes, page code and its test only.
- **s19c, the bar fixed (Alex chose to ship it with C1).** Shell takes `offered`, and the bar shows only when
  `offered && needsApprovalHeader(preview)`.
  - Git-shaped kinds: `!real && !cancelled`.
  - sql: `dry?.ok && !mismatch && !real && !cancelled`. So there is no bar while the dry run runs, when its counts
    differ (Approve is disabled then), when it failed (Approve isn't offered), or after Approve or Don't run.
  - Loading, sign-in and ended pages have none, as before.
  - Every word, mark, result line and status block is unchanged.
  - The pinned tests now assert the bar before acting and none after Approve and after Don't run, for every kind,
    plus the sql cases.

### 14.7 The page side of the extension contract: marks on /run/ and /review/ (s20)

For plumbing's L3 extension, which reads the live pages. Real pages only: a simulation page (the SIMULATION strip,
the /run-sim/ scenarios) carries none of these, and keeps `data-switchboard-kind="simulation"`.

- **Every result line** (ResultLine, look.js), on the run and the review page: its container carries
  `data-switchboard-line` (the line exactly as shown in the copy block) and `data-switchboard-link-id` (the page's
  link id).
- **The run page's project element** (the one with `data-switchboard-project` and `data-switchboard-kind="run"`):
  - `data-switchboard-running`, present only while the Approve or resend request is out. It goes when the request
    returns, fails or throws. A desktop that isn't ready at the click sends nothing, so it never appears then.
  - `data-switchboard-action-id`, set from the `action_id` that Approve (switchboard_consume_run_link) or resend
    returns, never before. The expired-checks rerun sets neither mark: it is the pre-check, not the run. A
    correction page's Approve (its reruns, reply `as_rerun`) shows running while out but sets no action id, for the
    same reason. A reply with no action id sets none.
- **The review page** has the line marks only: a review has no action, so no action id and no running mark.
- Today's /approve/ pages keep their own marks unchanged.
- Tests: src/switchboard/runs/pageMarks.test.jsx.

### 14.8 How a run ended, on the run page (s21, s21b)

- **The bug (s21, the live end-to-end test).** The helper refused a real pre-check before anything ran: action status
  failed, run result {ok:false}, the reason in summary, no failure_reason (only the 15-minute expiry writes that,
  247). The page chose stopped or finished on failure_reason alone, so it said "finished". PASS and FAIL both end
  succeeded, so the page couldn't tell them apart either.
- **The preview (migration 255_preview_run_end.sql)** adds three fields to `run`:
  - `ok`: result.ok;
  - `pass`: result.pass;
  - `summary`: the first 500 characters.

  ok and pass are read only when they are JSON booleans, otherwise null. switchboard_prune_runs clears result after
  30 days and keeps summary, so a pruned run has ok and pass null and its summary still there. Test 7 covers each end.

  **Applied (s21e):** run 87e7b3ee-fd3c-4ff7-b73e-ca45da449b78. All five statements ran, and conformance came back
  "CONFORMANT — all 123 non-exempt public tables satisfy platform contract v1, and anon reaches nothing undecided."
  Test 7 is queued as action fee25e15-0b17-4f84-aedd-661c9f09edec.
- **The page (runEnd in runContract.js)**, for a finished run that started:
  - **Failed:** status failed, ok false, or a failure_reason. It reads "failed" in the status line and "Failed <time>"
    in the used box, with "Reason: <summary>". Without a summary, the reason falls back to the failure_reason in
    words ('stopped' reads "The run stopped partway."; any other is shown as it is), then "No reason was recorded.".
    It never says "finished".
  - **Not ended yet:** a finished run row whose action isn't yet succeeded (the runner is still recording its
    evidence) reads running, never PASS. A sample run with no status counts as succeeded.
  - **PASS:** succeeded with pass true reads "finished: PASS".
  - **FAIL:** succeeded with pass false reads "finished: FAIL".
  - **Pruned:** pass null reads plain "finished".
  - **Never picked up:** a run the expiry closed shows only "Not started. Nothing ran." It used to show the used box
    as well, because the expiry sets finished_at. A run that finished before its pickup was recorded shows only the
    used box, no longer the waiting box as well.
  - **Not covered, a gap for later:** the live source hides a rerun's run (the expired-checks rerun, or a correction's
    Approve). A refused rerun therefore shows no reason: once it finishes, the page offers the rerun again.
  - **Cancelled:** a reopened cancelled link shows linkEndedReason, as before.
- **No end state draws a result line or carries `data-switchboard-line`:** the helper posts the done and failed lines.
  Don't run's own cancelled line, posted by the page, keeps its s20 marks.
- **Tests:** src/switchboard/runs/runEnd.test.jsx. The A7 test that pinned "stopped" now pins "failed".
