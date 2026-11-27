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
| allows | s28 (O2): {mode frozen or moving, kinds [{kind, limit (whole, 0 or more), reason}], integrations {allowed (boolean), reason}, failure_tolerance {rows (whole, 0 or more), reason}}, every key and nothing else, or absent (the data runs thread's module then applies the design's default); drawn under "Allowed"; a correction treats it as wording (256 c_words) |
| pretend | s28: {scenario: a name of 1 to 40 a-z, 0-9, hyphen, underscore}, only with simulation true; a pretend run (spec 15.2) |
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
| details | {run_folder, hashes [{name, sha256}], queries [{label, soql}], added_ids?}; s28 (O17): an Id list (selected_by.kind ids) carries exactly one query labelled `records`, the query that lists the Ids |
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
| Simulation | `SIMULATION run …`: shown to copy; a plain simulation's is never marked or posted. A pretend run's (s28) lines are marked and post at the click (Approve, reruns, resent, cancelled), and its later lines post on a tile tap, each starting SIMULATION |

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
- undo_of (undo page, required): {run_tag, stopped?, changed?, deadline?, deadline_reason?, request_id? (s27, s28: the
  data operation's request id, a lower-case uuid; the queue checks it is the caller's own, 256)}; deadline and its reason
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
  spends its link, but never makes a helper action, a run or a sample for it. s28: a pretend request (simulation and
  request.pretend, 256) is the one exception: consume makes its sf_run, and its made-up evidence, sample and outcome
  are kept on it; its page is marked as a real one is (14.7).
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

**C2. The old data run links are retired, and new data runs use the run pages.** One CLI step, now s24 (s20 to s23b
went to the extension's marks, the run's end, the sql bar and the run pages' wording).
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
  `review <id> ...` lines, in place of `dataop` and `datawrite`. A plain simulation's `SIMULATION ` line is never
  posted; a pretend run's is (s28), and its PASS is made up;
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
- **s22, sql: the bar first (Alex, "Bar first: yes").**
  - The problem: since s19c the SQL showed a few seconds before the bar, so the page looked read-only, as if it would
    close by itself.
  - Now the bar shows as soon as the page has the action, while the dry run is pending (`checking`: no dry run
    result, no Approve or Don't run yet, and no note, not even an empty one). "Run the dry run again" is pending too,
    so the checking bar comes back while it runs.
    - It reads "APPROVAL REQUIRED — checking the SQL first…". The note (RunShell's `approvalNote`) keeps its own
      case, so "SQL" stays upper case, and it takes the bar's size and spacing.
    - Approve is shown, disabled.
  - A clean dry run gives the plain bar and an enabled Approve, as before.
  - When the dry run fails, its counts differ, or the runner refuses it or can't be reached (a note), there is no bar
    and Approve stays off.
  - After Approve or Don't run the bar goes, as in s19c.
  - A sql test (it runs by itself) and every other kind keep s19c's rule.
  - Every mark, result line and status block is unchanged.
  - The tests now wait for an enabled Approve (approveOn) rather than any Approve button.

### 14.7 The page side of the extension contract: marks on /run/ and /review/ (s20)

For plumbing's L3 extension, which reads the live pages. Real pages only: a simulation page (the SIMULATION strip,
the /run-sim/ scenarios) carries none of these, and keeps `data-switchboard-kind="simulation"`.

**s28: a pretend run page is the one exception.** Its source's kind is `pretend` (liveSource kindOf: simulation true
and request.pretend present). It keeps the SIMULATION strip and `data-switchboard-simulation` on the root, and carries
every run page mark below as a real page does, with `data-switchboard-kind="run"` and a new
`data-switchboard-pretend` (empty) on the same project element. Its lines start SIMULATION (`SIMULATION run <link
id>`, `… reruns`, `… resent`, `… cancelled[: <note>]`), and ResultLine says so. Posting them is the data runs
thread's extension change. A pretend code review page stays unmarked, as a simulation. The /run-sim/pretend-precheck
scenario shows the marks on the dev server.

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
  Test 7 (action fee25e15-0b17-4f84-aedd-661c9f09edec) ran as run 95b046e9-ae50-423c-b5bb-25c3212c2044:
  all_passed true, 49 of 49.
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

### 14.9 After the click on /run/ and /review/: the wording here, the tab close in the extension (s23, s23b)

- **Wording (s23b).** On a real run or review page, ResultLine said "Paste this into the Claude chat, then close this
  tab." The extension posts the line, so it now says "This line goes to the Claude chat by itself; you can close this
  tab." (look.js REAL_LINE_NOTE).
  - It shows whenever the tab is still open, for example before plumbing's close lands.
  - Without the extension (missing, or not allowed on the host) nothing posts the line, though the sentence says it
    goes by itself. Alex's words, kept; flagged for him in s23b.
  - The simulation's sentence (SIM_LINE_NOTE) and every mark from s20 are unchanged.
  - Today's /approve/ page has its own ResultLine and keeps its words.
  - Tests: src/switchboard/runs/pageMarks.test.jsx.
- **Closing the tab is plumbing's, after hand-over (s23).**
  - The page never closes itself: ApprovePage has no `window.close`. The extension closes an /approve/ tab:
    - for a posted line, once the chat confirms it (`did === "sent"`), with closesApproveTab (switchboard
      extension/bridge.js:759, lib/bridge-core.js:350);
    - for a git-shaped kind, once the host has it, with closesGitApproveTab (bridge.js:450, bridge-core.js:353).
  - Both test the tab with isApprovePage → approveTokenOf (bridge-core.js:189-200), which matches only
    `/approve/<token>`, so a /run/ or /review/ tab is never closed.
  - Plumbing will close a watched /run/ or /review/ page on `did === "sent"`.
- **The wake on a /run/ click is plumbing's too.** The click's wake of the helper probably doesn't reach it from a
  /run/ page, for the same reason (approveTokenOf matches only /approve/).

## 15. Five items for the data runs thread (s25, 2026-11-25; a plan only)

sb3_dataruns-t8m asked for these, Alex agreed them, and the hub recorded them. Item a comes first: it blocks slice 1's
walk. Every migration below is unnumbered until its numbering step. Estimates come from the timing log:
- a page step with tests and a cold review: 7 to 11 minutes (s20, s21b, s22);
- a migration with its test: about 11 minutes (s21b);
- numbering, queueing and a test's queueing: about 1 minute each (s21c to s21e).

### 15.1 Where things stand today

- **A simulated request has no action.** consume spends the link and makes no action and no run (251:608, live as
  9629 in the snapshot).
- **Every write refuses a simulation:**
  - switchboard_record_run_evidence: "a simulation records no evidence", and `mode <> 'real'` is refused;
  - switchboard_store_run_sample: "a simulation holds no client data";
  - switchboard_record_run_outcome: refused for a simulation and for `mode <> 'real'`.
- **switchboard_runs.mode** allows only dry_run and real (189:155).
- **Both pickups** (switchboard_pickup_helper and switchboard_pickup_git, owned by the runner thread) open their runs
  as `real` (snapshot 10732, 10846).
- **Five inserts write an unpicked sf_run's expired run as `real`:**
  - consume (9649);
  - retry_run (11541);
  - pickup_helper's 10- and 15-minute expiries (10783, 10798);
  - pickup_git (10689), which expires sf_run too.
- **Other `mode = 'real'` filters:**
  - pickup_helper's replay (10809);
  - the runner's pendingActions and stalePicks (switchboard-runner/index.ts:173, 200);
  - _shared/tools/switchboard.ts:1368, which is sf_read only and harmless.
- **The runner** refuses an sf_run whose run isn't `real` at core.ts:869, the only sf_run mode check. (1046 is the
  non-sf_run /result path, and 1264 is sf_read's /sf-result.) sfRunLine (core.ts:747) builds only `run <id> …` lines.
  It keeps `{ok, exit_code, pass, checks}` on the run row (963-967).
- **The helper** (switchboard repo, helper/lib/core.mjs:541) refuses any simulation request today.
- **The extension** (bridge-core.js:387-392) drops a page line unless its kind is `run` and its first word is run,
  check or review. bridge-core.js:422 says "Never a SIMULATION line".
- **The pages:**
  - liveSource and LiveRunRoute (line 43) make any `simulation: true` request a `sim` source. That source gets the
    SIMULATION strip, no marks, no status block and "A simulation posts nothing" (s20, s23b). RunPage gates running and
    action-id on `!sim`.
  - switchboard-run-pages prefixes "SIMULATION " to a simulation's line (resultLine), except resend, which hard-codes
    `simulated: false` (core.ts:139).

### 15.2 Item a: pretend mode (blocks slice 1)

**Settled (recommendations, for Alex and the hub):**
1. **Pretend implies simulation.**
   - A request with `pretend: true` must have `simulation: true`. The queue refuses pretend without simulation.
   - So every simulation behaviour stays (strip, SIMULATION-prefixed lines, the real logs and real orgs untouched),
     and pretend adds only: consume makes the action and the run, and the run's made-up data is recorded.
   - A plain simulation, with no action, stays as it is for the design pages, /run-sim/ and the fixtures.
   - A pre-check and its data operation must agree on pretend, as they already must on simulation.
   - It also fails safe: a helper that hasn't learnt pretend refuses it as a simulation (core.mjs:541) and touches no
     org.
   - Pretend makes a live action, so Q10 ("one running per project", consume, retry and both pickups) applies to it.
     A pretend walk blocks its project's git and real runs while it runs, or for up to 15 to 30 minutes if never
     picked up. **Walk on a project code of its own.**
2. **The queue tool and runContract.**
   - requestProblems (runContract.js) refuses a non-boolean pretend, and pretend without simulation.
   - queue_switchboard_run_request passes `pretend` through to switchboard_queue_run_request, which stores it in a
     new column, switchboard_run_requests.pretend (boolean, not null, default false, with a check that pretend implies
     simulation).
   - The queue strips `pretend` from the stored request jsonb, as it strips `simulation` (11167). That way it lives
     only in the column and stays out of the fingerprint.
   - switchboard_correct_run_request lists `pretend` with `simulation` in c_set and c_words (9700, 9705), so a
     correction can never change it.
   - The mcp function imports runContract.js (_shared/tools/switchboard-runs.ts:19), so **mcp needs a redeploy**.
     switchboard-run-pages needs one too: its resend line must take `simulated` from the preview, not hard-code false.
3. **How the runner tells a pretend run apart, and keeps it off every org:**
   - consume puts `pretend: true` in the sf_run payload (`{link_id, pretend}`), so the helper knows before it reads the
     request.
   - Both pickups open the run as `mode 'pretend'`. So do all five expiry inserts (15.1) for a pretend action.
   - Every sf_run `mode = 'real'` filter becomes `in ('real', 'pretend')`, so a lost pickup reply's replay and the
     runner's stalePicks still find and close a pretend run:
     - pickup_helper's replay;
     - the runner's index.ts:173 and 200;
     - core.ts:869.
   - The runner accepts `pretend` only when the request is pretend. It refuses a real run on a pretend request, and the
     reverse.
   - get_switchboard_run returns a pretend run with its `mode`, so a reader must check it: a pretend PASS is made up.
   - Its lines start "SIMULATION " for a pretend run (`SIMULATION run <link id> done: PASS`).
   - Keeping off the orgs is the helper's and module's job (data runs thread, switchboard repo): on a pretend payload
     they make the data up and open no org connection.
     - The helper drops its simulation refusal for pretend only.
     - The made-up request may still name a real target alias. **Ask the data runs thread for a test that a pretend
       plan opens no sf connection, whatever org it names.**
     - The database side guarantees only that made-up data lands in `pretend` rows on a pretend request, never in a
       real one.
   - The evidence and outcome functions accept a `pretend` run on a pretend request (the data is made up), and keep
     refusing a plain simulation.
   - store_run_sample takes a request, not a run, so it accepts a pretend request.
   - **Order:** until s29 lands (s28 before s26's renumbering), the runner refuses a pretend result (core.ts:869).
     So s26 to s29 ship before any pretend walk.
4. **The page's Approve line on a pretend page: marked, with a SIMULATION prefix.**
   - The page is still a simulation: the strip shows, `data-switchboard-simulation` stays on the root, and the copy
     sentence says a pretend run reaches no org.
   - It also carries the s20 marks:
     - `data-switchboard-line="SIMULATION run <link id>"`, the function's reply line;
     - the link id, the action id and running;
     - ResultLine's hidden status block with Try again.
   - `data-switchboard-kind` stays `run`, and a new `data-switchboard-pretend` mark is added. The extension already
     drops a line whose kind isn't its route (bridge-core.js:387-392), so this is the smaller change.
   - **The tap rule:** every line the page makes at a click posts at the click, as on a real page. That covers
     Approve, Don't run's cancelled line, resent and reruns. The runner's later done and failed lines wait on the tile
     for Alex's tap, each starting SIMULATION.
   - liveSource and LiveRunRoute give the source `kind: 'pretend'`, and isSimulation stays true for it.
     - RunPage's `!sim` gates for the marks and the status block become "not a plain simulation".
     - The sent text "Nothing was sent… no org was touched" (RunPage.jsx:546) gets a pretend wording: "Sent to the
       desktop helper as a pretend run: its data is made up and no org is touched."
   - **Contract change for the hub and the data runs thread:** today the extension never posts a SIMULATION line
     (bridge-core.js:422). It must post a SIMULATION-prefixed run line from a page marked `data-switchboard-pretend`.
     s26: that is the data runs thread's, not plumbing's (Alex told them). The /run/ wake and tab close stay
     plumbing's (14.9).

**Conflicts with what's live:**
- **s20** said a simulation page carries no marks. Pretend is the one exception, by its kind; a plain simulation
  stays unmarked.
- **Spec 4.4** says a simulation line is "never posted". That changes with item c's spec update.
- **s21's end states** (runEnd) work as they are: a pretend run has the same status, ok, pass and summary.
- **s23b's sentence** must not say "goes to the Claude chat" without saying it is a simulation, so pretend gets its
  own sentence.
- **C1, s19c and s22** concern /approve/ only: untouched.
- **The tap rule** holds: only the Approve line posts at the click, and later lines wait for a tap.

**Files and items:**
- **Migration:** `supabase/migrations/256_pretend.sql` (the pending file, numbered at s27b, written and queued at s27c).
  - Tables: switchboard_run_requests (adds pretend) and switchboard_runs (its mode check adds pretend).
  - Functions:
    - switchboard_queue_run_request and switchboard_correct_run_request;
    - switchboard_consume_run_link and switchboard_retry_run;
    - switchboard_pickup_helper and switchboard_pickup_git;
    - switchboard_record_run_evidence, switchboard_store_run_sample and switchboard_record_run_outcome;
    - switchboard_run_preview, which returns request.pretend.

    The comments on the simulation column and on consume ("creates nothing else") change too.
  - Read: switchboard_actions, switchboard_run_links, switchboard_run_samples and switchboard_code_reviews.
  - **Ownership, settled at s26:** this thread changes switchboard_pickup_helper, switchboard_pickup_git and
    supabase/functions/switchboard-runner/ (once the runner thread's, sb3_runner-r4q, now finished).
- **Test:** `supabase/tests/sb3_pages-h6v/8_pretend_test.sql` (drafted at s27). It covers:
  - the schema: the column, its two checks, the run mode, the grants;
  - the shape: `{scenario}` accepted (40 characters too), 14 refused forms, and pretend without simulation;
  - the column check, both ways, and pretend without simulation in the columns;
  - a pre-check and data operation that disagree on pretend, both ways; differing scenario names accepted;
  - consume making an sf_run with exactly `{link_id, pretend: true}`, and the preview returning request.pretend;
  - pickup_helper opening it as pretend, and replaying it on a repeated pickup id;
  - evidence, sample and outcome accepted pretend on pretend, refused across real and pretend, both ways, and
    refused for a plain simulation;
  - a plain simulation still making no action;
  - the correction keeping the stored object (wording and a rerun kind), and dropping a real request's pretend;
  - the 15-minute expiry: retry's and pickup_git's expired run is pretend, and the resend keeps pretend;
  - O5's undo_of.request_id (below);
  - conformance.
- **Pages:** runContract.js, liveSource.js, LiveRunRoute.jsx, look.js, RunPage.jsx, CodeReviewPage.jsx, a new
  pretend.test.jsx, and switchboard-run-pages/core.ts with its test.
- **Tool:** _shared/tools/switchboard-runs.ts and its test.
- **Runner:** switchboard-runner/core.ts and index.ts with their tests (named for this thread at s26).
- **Deploys:** mcp, switchboard-run-pages and switchboard-runner, each holding db:deploy.
- **Other threads, needed before slice 1's walk:** the helper's pretend path (data runs thread) and the extension's
  pretend line (also the data runs thread's, since s26).

**Ownership (settled at s26, 2026-11-26):** Alex and the hub confirmed that this thread changes
switchboard_pickup_helper, switchboard_pickup_git and, in s29, supabase/functions/switchboard-runner/. The runner
worktree (sb3_runner-r4q) is finished. The extension's pretend line belongs to the data runs thread, not plumbing.
The data runs thread confirmed that the page's own Approve line starts with SIMULATION too ("SIMULATION run <link
id>"), as the runner's later lines do, which wait for Alex's tap.

**What the s26 draft settled** (now `supabase/migrations/256_pretend.sql`, queued at s27c):
- **Sources.** Each function is its live definition (md5 of the live body equal to the source's, checked
  2026-11-26), changed only for pretend:
  - switchboard_queue_run_request and switchboard_record_run_evidence from 252;
  - switchboard_correct_run_request and switchboard_record_run_outcome from 254;
  - switchboard_consume_run_link from 251;
  - switchboard_retry_run and switchboard_store_run_sample from 250;
  - switchboard_pickup_helper and switchboard_pickup_git from 248.
  - switchboard_run_preview (255) is no longer replaced (s26b): it returns the stored request, so request.pretend
    comes back as stored.
- **The shape (s26b, from the data runs thread):** `request.pretend = {scenario: "<name>"}`. The name is 1 to 40
  characters of a-z, 0-9, hyphen and underscore: a name only, never a path. It stays in the stored request, and so
  in the fingerprint. The s26 draft had a boolean stripped into the column; that is replaced.
- **Tables.** switchboard_run_requests.pretend (boolean, not null, default false) with two checks:
  - `switchboard_run_requests_pretend_simulation`: not pretend or simulation;
  - `switchboard_run_requests_pretend_request` (s26b): pretend = (request ? 'pretend'). So the column is true
    exactly when request.pretend is present.

  switchboard_runs_mode_valid takes pretend. New comments on the simulation, pretend and mode columns, and on
  switchboard_actions.payload (sf_run's `pretend` key).
- **The queue** refuses any other pretend: a boolean, null, a missing or bad scenario, or other keys. A `case`
  guards the key removal, which fails on a scalar, so a bad shape gets the refusal, not an SQL error. It
  refuses pretend without simulation, and a pre-check and a data operation unless both have pretend or neither does.
  The scenario names may differ.
- **The correction** lists pretend in c_words (never compared) and c_set (the chat's is dropped). Then it adds the
  stored `request.pretend` back (`v_keep`), in both of its updates. So a correction never changes the object or the
  column, and the second check holds.
- **Consume** goes on for `simulation and pretend`, as for a real request. The payload is
  `{link_id, pretend: true}`; a real request's payload is unchanged, `{link_id}` with no pretend key. It returns
  `simulated: true, pretend: true`, so run-pages builds the `SIMULATION run <link id>` line from `simulated`, as it
  does today. A real request returns `pretend: false`. A plain simulation's return is unchanged and has no pretend key.
- **Mode.** The run's mode is read from the action's payload (`payload.pretend = true` on an sf_run), never from the
  request. Consume is the only writer of that key, and the guard (248) never lets a payload change.
- **Four expiry inserts change, not five.** consume, retry_run, and the 15-minute expiry in both pickups. The
  10-minute expiry in pickup_helper fails only queued no-click actions, and an sf_run always needs a click
  (switchboard_actions_sf_run_click), so it never reaches one. It stays `real`.
- **pickup_git** hands out git only. Its replay and its own pickup stay `real`; only its expiry changes. 15.1 had the
  two pickups' snapshot lines the wrong way round: pickup_git is 10689 to 10732, pickup_helper 10783 to 10846.
- **pickup_helper** opens a pretend sf_run's run as `pretend`, and its replay finds `real` or `pretend`.
- **Evidence and outcome** take `mode in ('real', 'pretend')`. They refuse a plain simulation, as today. They also
  refuse `(run is pretend) <> (request is pretend)`, in both directions. store_run_sample refuses only a plain
  simulation.
- **The preview** is unchanged and returns `request.pretend` as stored (s26b). The page tests whether it is present.
- **record_run_evidence** rewrites the request only from the stored row (`v_req := v_row.request`), so it keeps
  pretend.
- **O5, added at s27 (the data runs thread confirmed 15.6a's proposal).** In the queue, an `undo_of.request_id` must
  be a lower-case uuid naming the caller's own request whose base page is dataop, in the same project, agreeing on
  simulation and on pretend. Only an undo may carry it. Each refusal is one sentence naming what is wrong: not an
  undo, not a uuid, not found (another user's reads as not found), not a data operation, another project, a
  simulation mismatch, a pretend mismatch. undo_of without request_id queues as before. A correction can't add or
  change it: undo_of is no kind's field, so the diff refuses it. Re-diffed against live 252: the queue differs only
  by pretend and this block.
- **s27 cold review** (one round): no drift, no SQL errors, no hole; every test 8 check passes when right and fails
  when broken. Added at its suggestion: the other direction of both undo mismatches. Noted, not changed: a
  correction may add `undo_of.request_id: null` (jsonb_strip_nulls reads null as absent), stored as given; s28's
  runContract check treats null as absent. The pickups in test 8, like tests 1 to 7, would take a real ready sf_run
  of Alex's if one existed at the run (rolled back; the check would fail and say so).
- **s27b (Alex, for O2):** the correction lists `allows` in c_words beside `diagnosis_allows`, so any correction may
  change it, as it may diagnosis_allows. Re-diffed against live 254 (md5 unchanged): the correction differs only by
  pretend (c_words, c_set, v_keep) and `allows` in c_words.
- **Number:** 256, from claims.cmd number-migration (s27b), claimed as db:migration:256. The file is
  `supabase/migrations/256_pretend.sql`, written at s27c from the pending file (identical but for its two header
  lines), after a drift check: all nine live bodies equal their sources' (md5, 2026-11-26).
- **Applied (s27d):** 256 ran as run b3f3799f-bc5c-4378-b8ec-a5fce699c45d, all 44 statements, with conformance
  "CONFORMANT — all 123 non-exempt public tables satisfy platform contract v1, and anon reaches nothing undecided."
  Checked live at s27d: all nine bodies' md5 equal 256's, the pretend column is boolean not null default false, and
  the two request checks and the three-mode run check are as written. Test 8 queued with --test (action
  f16ddab2-7097-4726-94fa-91a362ee1b48); its result is recorded when it has run.
- **The break (s27e, 2026-11-26).** Test 8's run 734bef6c-e8b2-4f76-a540-6a30bb7b518e passed its six schema checks,
  then failed at its first queue call: "operator is not unique: unknown - unknown" (42725). A plain simulated
  pre-check through the MCP tool failed the same way, so **every queue call failed** from 256 on.
  - **Cause:** 256 line 148, `(p_request->'pretend' - 'scenario')`. In PostgreSQL `-` binds tighter than `->`, so it
    parsed as `p_request -> ('pretend' - 'scenario')`, unknown minus unknown. PL/pgSQL plans an IF's whole condition
    the first time it reaches it, so the error came whether or not the request had pretend. Reproduced read-only:
    `select '{...}'::jsonb->'pretend' - 'scenario'` gives the same error.
  - **Why it was missed:** the md5 checks compare text, not behaviour; both cold reviews read the guard's logic and
    not its parse; and the migration's dry run on the approve page only creates the functions, never calls them.
  - **The other eight functions:** no other `->` lookup followed by `-`, `+`, `*` or `/`.
  - **Fix:** `supabase/migrations/257_fix_queue.sql` (numbered at s27e; written at s27f from the pending file,
    identical but for its two header lines, after a drift check: the live queue body's md5 equal to 256's): only
    switchboard_queue_run_request, with `((p_request->'pretend') - 'scenario'::text)`; comment and grants as 256. It
    ends with a smoke check that calls the function twice as a made-up user, each refused on purpose after the
    pretend check (and the undo_of check), and stops the migration on any other error. So its own dry run proves
    the fix before Approve.
  - **Lesson:** run a migration's test in a dry run before applying it, and give a migration that replaces a
    function a smoke call, so the approve page's dry run plans it.
  - **Applied (s27g):** 257 ran as run d50075fa-7153-46f7-b15f-3f8a5c2f966b (17:58:04Z to 17:58:05Z): all six
    statements ran (create function, comment, revoke, grant, the smoke check's DO block, the conformance select). The
    smoke check passed, and conformance was "CONFORMANT — all 123 non-exempt public tables satisfy platform contract
    v1, and anon reaches nothing undecided." The live queue body's md5 equals 257's. A plain simulated pre-check
    then queued through the MCP tool (request b9e6807e-993d-455c-b8a4-7336f774cb58, project h6v-sim-c).
  - **Outage:** the queue was down from 256's apply (17:45Z) to 257's (about 17:58Z), about 13 minutes.
  - Test 8 queued again with --test as action 2e163d8b-273e-428e-9a2b-9d412fda4dd9 (the first run, 734bef6c, stopped
    at the break). **It passed 59 of 59** (run d5320d47-75c9-430b-bbef-c00a3066b357). 256 and 257 are on main, and
    the db: claims were released by the Checkpoint.
- **No other function changes.** switchboard_issue_link, switchboard_cancel_run_link and the rest need nothing for
  pretend. The cold review's list of other places that read `mode` is under "s26 cold review" below.

**Steps** (revised at s26: test 8 moves to s27, so the pages step is s28 and the runner step s29):

| Step | What | Estimate |
|---|---|---|
| s26 | Draft the pretend migration, with a cold review | 30m |
| s27 | Draft test 8, and O5 in the queue, with a cold review (done) | 20m |
| s27b, s27c, s27d | gitsync if behind, number it, write and queue it, then queue test 8 | 1m + 2m + 1m |
| s28 | Pages, runContract (with O17, O2 and O5), the tool, run-pages core (and item c); tests; cold review | 40m |
| s28b | Deploy mcp and switchboard-run-pages | 5m |
| s29 | The runner's pretend handling (core.ts, index.ts), tests, deploy | 20m |

**s28 in detail** (planned at s27; the data runs thread confirmed O1, O17, O2, O5 and failed_check):
- **runContract.js** (requestProblems), with runContract.test.js:
  - pretend: absent, or exactly `{scenario}` with the queue's name rule, and only with simulation true;
  - O17: an `ids` request (selected_by.kind `ids`) must carry exactly one `details.queries` entry labelled `records`;
  - O2: a top-level `allows`, when present, is `{mode: 'frozen' | 'moving', kinds: [{kind, limit, reason}],
    integrations: {allowed, reason}, failure_tolerance: {rows, reason}}`; anything else is refused, naming the key.
    Absent stays allowed (their module applies the design's default). `diagnosis_allows` stays the sentences;
  - O5: `undo_of.request_id`, when present, is a lower-case uuid, on an undo only (the queue checks the rest).
  - Spec 4.1 and 4.6 get the three fields; EDIT_RERUNS keeps `allows` with no reruns.
- **The page drawing allows** (RunPage.jsx, under "Diagnosis allows"): the mode, one row per kind (kind, limit,
  reason), integrations allowed or not with the reason, and the failure tolerance in rows with the reason. Counts and
  short text only; a malformed `allows` draws nothing (runContract refuses it at queue time anyway).
- **The pretend page** (liveSource.js, LiveRunRoute.jsx, look.js, RunPage.jsx, CodeReviewPage.jsx for the shared
  gates): the source `kind: 'pretend'` when request.pretend is present; isSimulation stays true, so the strip and
  `data-switchboard-simulation` stay; RunPage's `!sim` gates become "not a plain simulation"; the sent sentence
  "Sent to the desktop helper as a pretend run: its data is made up and no org is touched."; and look.js's line note
  gets a pretend sentence that names a simulation (s23b's must not be used alone).
- **The marks:** a pretend page carries the s20 marks with `data-switchboard-line="SIMULATION run <link id>"`, the link
  id, the action id and running, ResultLine's hidden status block with Try again, `data-switchboard-kind="run"`, and a
  new `data-switchboard-pretend` mark. A plain simulation stays unmarked. Tests in a new pretend.test.jsx.
- **switchboard-run-pages core.ts** (and core.test.mjs): the resend line takes `simulated` from the preview, not a
  hard-coded false (core.ts:140), so a pretend resend's line starts SIMULATION.
- **The tool** (_shared/tools/switchboard-runs.ts, switchboard-runs.test.mjs): passes `pretend` and `allows` through;
  it imports runContract.js, so the new checks apply at queue time.
- **Item c:** the undo page's "No sample record here" line, and spec 4.4, section 8, 14.2 and 14.7 updated (15.4).
- **One database change O2 needs** (not in s28's files): switchboard_correct_run_request must list `allows` with
  `diagnosis_allows` in c_words, or a correction can't change it (today any change to an unknown top-level key is
  refused as a diff). Added at s27b, in 256 (Alex agreed).
- **Redeploys (s28b):** mcp (the tool and runContract) and switchboard-run-pages, each holding db:deploy. The pages
  ship with the app build.
- **Estimate:** 40m: the s25 plan's 25m, plus O17 about 3m, O2 about 10m (contract, page, tests) and O5 about 2m.

**s28 as built** (nothing deployed; s28b deploys):
- **runContract.js:**
  - requestProblems refuses a pretend that isn't exactly `{scenario}` (the queue's name rule, PRETEND_SCENARIO) and
    a pretend without simulation true.
  - O17: an Id list without exactly one `details.queries` entry labelled `records` is refused (RECORDS_QUERY).
  - O2: `allows` is checked by allowsProblems, each refusal naming its key; allowsView gives the page whole or null.
  - O5: `undo_of.request_id` must be a lower-case uuid, on an undo only.
  - The line builders (runLine, runCancelledLine, runResentLine, runRerunsLine) take a `simulated` flag that prefixes
    SIMULATION on a real link id. Called without it, every real line is as before.
- **look.js:** isPretend; the strip's second line for a pretend source ("A pretend run: the desktop helper makes the
  data up. Nothing here reaches any org."); ResultLine's `pretend` marks the line and keeps the status block, with
  PRETEND_LINE_NOTE.
- **RunPage.jsx:**
  - `marked = !sim || pretend` gates the s20 marks, so a real page's marks are unchanged.
  - `data-switchboard-pretend` sits on the project element.
  - The fallback lines carry SIMULATION on a pretend page.
  - The sent heading reads "Pretend: …", and its text "Sent as a pretend run: its data is made up and no org is
    touched. It must pick the run up within 15 minutes."
  - "Allowed" is drawn under "Diagnosis allows" (AllowsRows).
  - Item c: an open undo page with no sample says UNDO_NO_SAMPLE (runContract.js); a closed one says nothing.
- **liveSource.js:** `kindOf` (exported, and used by LiveRunRoute's ended page too) gives `pretend` for a
  simulation carrying request.pretend. A pretend request's code review source is `sim`, so CodeReviewPage is
  untouched: unmarked, with the plain strip.
- **Differences from "s28 in detail":**
  - The sent wording is a "Pretend: " heading plus "Sent as a pretend run: …", not "Sent to the desktop helper as a
    pretend run: …".
  - CodeReviewPage.jsx needed no change.
- **O17 and older requests:** an Id-list request queued before s28 without a `records` query can't be corrected
  through the tool (it runs requestProblems too) until its correction adds one. Checked at s28: all 5 live Id-list
  requests lack one (3 of them simulations), so a correction of any of them must add the `records` query.
- **simulation.js:**
  - The Id-list queries are labelled `records`.
  - Two scenarios are new: `pretend-precheck` (its source's kind `pretend`) and `dataop-allows`.
- **switchboard-run-pages core.ts:** resend reads the preview first, so its `simulated` and line follow the request
  (it was hard-coded false). Resend and cancel also return `pretend`. Approve already passed consume's `pretend` on.
- **The tool:** the schema was already a passthrough, so pretend and allows reach the database as sent; the queue
  tool lower-cases `undo_of.request_id`, as it does pre_check_request_id. mcp's queue description names the
  `records` query, allows, pretend and undo_of.request_id.
- **Tests:**
  - New: pretend.test.jsx and allows.test.jsx.
  - Added to: runContract.test.js (pretend, O17, O2, O5, the SIMULATION flag), core.test.mjs (resend, cancel and
    Approve for pretend and plain), switchboard-runs.test.mjs and mcp/index.test.mjs.

**s28b deployed** both functions on 2026-11-26, from the worktree at main's dfd260b, holding db:deploy:
- mcp at 20:42:35 local time (04:42:35Z on 11-27);
- switchboard-run-pages at 20:42:45 local time (04:42:45Z).

Live check, read only:
- The deployed mcp index.ts, downloaded to the scratchpad, is byte-identical to the worktree's. Its
  queue_switchboard_run_request description names pretend and allows. The claude.ai connector's tool list was fixed
  at session start, so the tool list was read from the deployed source.
- A POST to switchboard-run-pages /preview with no JWT and no token answers 401 `{"ok":false,"error":"unauthorized"}`,
  the function's own body, as before (no 500). The token check comes after the JWT check, so a missing token can't
  be reached without signing in; core.test.mjs covers its 400.

**s29 as built** (the runner, switchboard-runner):
- **core.ts:**
  - SF_RUN_MODES = ['real', 'pretend']. sfRunResult takes a run of either mode; it is reached only for kind sf_run.
    Every other helper kind's /result and /sf-result still require `mode = 'real'`, as before.
  - A pretend result goes through the same steps as a real one: the run row, 251's evidence, 250's sample, 254's
    outcome, the drop and the status. The runner doesn't compare the run with its request: 251 and 254 refuse a
    mismatch (55000). Evidence refused fails the run (422, retry false, the fix named); outcome refused is noted on
    the run and the reply (`outcome_refused`), as any 254 refusal is.
  - `sfRunLine(linkId, ok, pass, simulated)`: a pretend run's lines start "SIMULATION " (done: PASS, done: FAIL,
    failed, a refused report, a repeat's already). The flag comes from the run's mode; on a pickup refusal, from the
    payload's `pretend` (consume's). Called without it, every real line is byte-identical to before.
- **index.ts:** pendingActions and stalePicks take `.in("mode", SF_RUN_MODES)`, so a pretend sf_run's open run is
  owed and a timed-out one is finished. Only an sf_run ever has a pretend run, so other kinds are unaffected.
- **No org:** the runner imports only the Supabase client and postgres, and has no fetch, no Salesforce code and no
  subprocess. A pretend result's path calls only Supabase-backed deps. Keeping the helper off the orgs on a pretend
  payload is the data runs thread's (above).
- **Tests** (core.test.mjs, 7 new, 173 in all): a pretend pre-check recorded; every pretend line prefixed; real lines
  unchanged (a real run on a pretend request included); a mismatch refused by 251 (both directions) and by 254, each
  reported, not thrown; pretend taken for sf_run only; index.ts's two filters.
- **Cold review** (one round): no must-fix, and no real-run path changed. Fixed: an evidence refusal carrying 256's
  pretend-mismatch wording ("a pretend run" or "a pretend request") now names its real fix (queue the request
  again), not "reload the run page". A comment now says that pickup_helper opens the pretend run.
- **Open, for Alex:** the runner doesn't compare the run's mode with request.pretend itself; the database does.
  15.2 point 3 said the runner refuses a mismatch. So a write whose outcome 254 refuses for a mismatch is
  noted (`outcome_refused`) and still marked succeeded, as any 254 refusal is. A failed pre-check calls no checking
  function at all. The risk is low: the mode comes only from consume's payload `pretend`, set from the request, and
  248's guard never lets a payload change. A runner check would be one line in sfRunRecord, after the request read,
  ending through `final`.
- **Deployed** 2026-11-26 at 20:51:21 local time (04:51:21Z on 11-27), from the worktree at main's bdfaafe, holding
  db:deploy. The after-deploy check: unauthenticated POSTs to /queue and /result answer 401
  `{"ok":false,"error":"unauthorized"}`, the runner's own body.

The Checkpoints follow s27d, s28b and s29. Until s29 lands the runner refuses a pretend result (core.ts:869), so no
pretend walk starts before then.

**s26 cold review** (one round, against the live bodies). Its verdict on the file:
- No drift: every function matches its source except the pretend change, with the same signatures, defaults and
  grants.
- No SQL errors, and every comment matches its code.
- The table changes hold on the existing rows.
- The payload comment equals 248's text plus the pretend clause.
- The file stays inside the declared scope.

Two notes, kept as they are:
- A correction that sends `pretend` is now dropped, where before it was refused as a changed field. No live request
  has a `pretend` key in its jsonb (0 of 4, checked 2026-11-26), so nothing is lost. Since s26b the stored one is
  then put back, so the object never changes.
- A plain simulation's consume reply has no `pretend` key; the other replies have one. Readers take a missing key
  as false.

Other places that must learn pretend, all already planned:
- s29: the runner's core.ts:869 refuses a non-real run; index.ts:200 (stalePicks) and 173 (pendingActions) filter
  `mode = 'real'`. Without them a pretend run's result is refused, and a timed-out pick is never finished.
- s28: switchboard-run-pages core.ts:140 hard-codes `simulated: false` on resend. RunPage.jsx:543-546 says "Nothing
  was sent". liveSource.js has no pretend kind.

No other live SQL function reads switchboard_runs.mode.

**s26b cold review** (the revised draft, one round): no drift, no SQL errors. It confirmed:
- every shape the queue must refuse is refused;
- `pretend = (request ? 'pretend')` holds for every function that writes the request;
- keeping pretend in the request breaks nothing: the fingerprint, the pre-check comparison, the correction diff,
  requestProblems and the tool's passthrough schema;
- the live 255 preview returns it as stored.

Two comment wordings were fixed: "fails on a scalar", and "set by consume, copied by a resend". Its other findings
are the runner's core.ts:869 and index.ts:173, already in s29.

### 15.3 Item b: a pre-check that fails at the sandbox rehearsal keeps the checks that passed

- **Today:** the runner records evidence only when `ok && pass === true` (core.ts:983), and
  switchboard_record_run_evidence refuses a run that didn't pass. So a rehearsal failure records nothing, and a
  correction to the value (EDIT_RERUNS: rehearsal only) can't reuse the production reads.
- **Change:**
  - record_run_evidence accepts a finished run with `ok true, pass false` when its result says it stopped at the
    rehearsal (`failed_check: 'rehearsal'`, named by the helper). It records only the checks listed as passed, and
    never `rehearsal`.
  - The runner calls it in that case too.
  - Kept checks keep their own `passed_at`, so they still expire 24 hours after they first passed (valid until =
    oldest + 24 hours, unchanged).
  - The sample is still stored only on a full pass.
  - **The runner stores `failed_check` on the run row** next to `{ok, exit_code, pass, checks}`. It validates it in
    sfRunReportProblem (core.ts:963-967), since the evidence function reads only that row.
  - **A rehearsal failure's record also voids any rehearsal entry still in use.** Otherwise a correction that keeps
    an earlier rehearsal (`records`: count, backup, sample), followed by a rerun whose rehearsal fails, would leave
    the old rehearsal valid. The data operation would then be approvable just after a rehearsal failed.
  - The queue refuses a data operation whose pre-check has no rehearsal in use. Today it refuses only one with no
    passed checks at all (11155).
  - A refusal of this kept-checks record is noted on the run, never `final()` (core.ts:988-989). So a FAIL stays
    "finished: FAIL" (s21), not "failed".
- **Contract change for the hub and the data runs thread:** on a rehearsal failure the helper reports
  `{ok: true, pass: false, failed_check: 'rehearsal', checks: [the production checks that passed]}`.
- **Conflicts:**
  - 251's copied_from rule (a pre-check's checks back one data operation) is unchanged.
  - s21's page shows the run as "finished: FAIL", and the correction page's "Still valid" lists the kept checks.
- **Files:**
  - a migration, `_pending_sb3_pages-h6v_kept_checks.sql` (switchboard_record_run_evidence; reads
    switchboard_runs, switchboard_actions, switchboard_run_links and switchboard_run_requests);
  - test 9, `9_kept_checks_test.sql`;
  - runner core.ts:983 and its test, with Alex's naming as in a.
- **Deploy:** switchboard-runner.
- **Steps:**

| Step | What | Estimate |
|---|---|---|
| s30 | Draft the migration (evidence and queue) and test 9, the runner change, cold review | 25m |
| s30b to s30d | Number, queue, test | 4m |
| s30e | Deploy the runner | 3m |

(Renumbered at s26 from s29: item a's runner step took s29.)

### 15.4 Item c: the undo page's sample, and spec 4.4

- **Undo:** an undo has no pre-check, so store_run_sample (250:951, which needs valid evidence) can never give it a
  sample. The terminal shows a fresh sample before the count.
  - The undo page then shows a line where the sample would be: "No sample record here: an undo has no pre-check. The
    terminal shows a fresh sample before it counts."
  - Today the section is simply missing. Page only (RunPage.jsx SampleRecord, its test).
- **Spec 4.4's Simulation row** becomes: "`SIMULATION run …`: shown to copy; a pretend run's Approve line is marked
  and posted, and its later lines post on a tile tap, each starting SIMULATION". The line above it is updated to match.
  So are the other places that say a simulation never posts or never runs:
  - section 8 (line 441: "never makes a helper action, a run or a sample");
  - 14.2's skills note (around line 982);
  - 14.7 (around line 1098).
- **Conflicts:** none. Folded into s28 (the pages step, s27 before s26's renumbering), at no extra cost: about 3
  minutes.

### 15.5 Item d: more of the outcome on the page

- **record_run_outcome is shape-free** (254: any JSON object up to 64 KB, never read inside). It needs no change and
  no migration.
- **outcomeView** (runContract.js) learns three keys, and drops anything malformed, never guessing:
  - `stopped.next`: one sentence, text of at most 200 characters, shown as "Next: …";
  - `stopped.by_step`: `{step, object}`, both short text, shown as "Stopped at <step> on <object>";
  - `skipped`: `[{kind, count}]`, with kind short text and count an integer of 0 or more, shown as one row each.
  - Counts and names only: any other key, or any value inside these keys that isn't these types, is left out.
  - `stopped` is kept when any of its four keys is valid. Today it needs already_changed or saved_on_pc
    (runContract.js:704), so a `stopped` with only `next` would show nothing.
- The Outcome component in RunPage.jsx draws them. Tests go in runContract.test.js and runEnd.test.jsx.
- **Contract change:** these three keys join the outcome shape the data runs thread owns.
- **Steps:**

| Step | What | Estimate |
|---|---|---|
| s31 | Page and contract, tests, cold review | 10m |

### 15.6 Item e (slice 2, not urgent): the "Check what happened" page's line and result

- **The line:** the runner builds `check <link id> done: job <state>; <a> at goal, <b> at backup, <c> neither`
  (spec 4.4) from the helper's `{job, at_goal, at_backup, neither}` for a check page's sf_run. checkLine in
  runContract.js has the shape. Runner core.ts sfRunLine and its test, with Alex's naming as in a.
- **The result:** switchboard_record_run_outcome accepts a check page's run (today only dataop and undo), storing
  `{job, at_goal, at_backup, neither}`. The page then shows it.
  - The runner must call it: sfRunKind returns "other" for a check page (core.ts:815-821), and recordOutcome runs
    only for "write".
  - RunPage's Outcome renders only for dataop and undo (RunPage.jsx:153), so it learns check pages too.
  - Files: a migration `_pending_sb3_pages-h6v_check_result.sql` (switchboard_record_run_outcome,
    switchboard_run_requests), test 10, and the page with its test.
- **Steps:** s32 drafts both (20m), then numbering, queueing, the test and a runner deploy (8m). Planned in detail
  when slice 2 starts.

### 15.6a The data runs thread's four questions (s26b, read only; all four proposals confirmed at s27)

At s27: O5 is in the pending migration (15.2); O17, O2 and O5's runContract check are s28's; failed_check is s30's,
with the data runs thread sending `{ok: true, pass: false, failed_check: 'rehearsal', checks}`.


- **O17, an Id list's Ids.** There is no field for the Ids themselves.
  - selected_by is `{kind ids or filter, text, sandbox_text?, not_rehearsed?}` (4.1, line 166): a sentence, not a
    list.
  - details is `{run_folder, hashes, queries [{label, soql}], added_ids?}` (4.1, line 175). added_ids are Ids added by
    a correction, shown as "Added Ids" (RunPage.jsx:286-287).
  - Nothing checks details or its labels: runContract.js requestProblems (508-579) and the queue function never read
    it. RunPage.jsx:280-285 draws each query as its label and its SOQL.
  - So reading `details.queries`' query labelled `records` works today, but only by convention.
  - **Smallest addition:** fix the label as `records` in 4.1, and have requestProblems check that an `ids` request
    has exactly one such query.
- **O2, what diagnosis allows.**
  - Stored as `diagnosis_allows`: a list of sentences, or absent (4.1, line 164).
  - requestProblems refuses anything else (runContract.js:535-536). The queue stores it as sent, and a correction
    treats it as wording (c_words).
  - The page draws it as "Diagnosis allows", one sentence per line (RunPage.jsx:77-81).
  - There is no structured field. Their `details.allows` would be stored, since nothing checks details, but never
    drawn.
  - **Smallest addition:** keep `diagnosis_allows` as the sentences the page shows, and add a structured
    `allows` beside it. requestProblems would check its shape (mode frozen or moving; kinds [{kind, limit, reason}];
    integrations {allowed, reason}; failure_tolerance {rows, reason}), and the correction would treat it as wording
    with diagnosis_allows. It must not go under details, which describes the run's folder and queries.
- **O5, undo_of.**
  - Today it is `{run_tag, stopped?, changed?, deadline?, deadline_reason?}` (4.6, line 295).
  - requestProblems checks only run_tag and the deadline rules (runContract.js:541-543, 549-550). The queue function
    never reads undo_of.
  - So `undo_of.request_id` can be sent today and would be stored. Nothing checks it, nothing draws it, and nothing
    ties it to a real request.
  - **Smallest addition:** requestProblems checks that it is a lower-case uuid. The queue checks it names the
    caller's own data operation request in the same project (base_page dataop, simulation and pretend matching), as
    it does for pre_check_request_id. A correction leaves it unchanged, as it does pre_check_request_id.
- **failed_check (item b, s30).** Their shape `{ok: false, pass: false, failed_check: 'rehearsal', checks}` doesn't
  fit as it stands, for two reasons:
  - **ok false reads as failed.** The runner sets the action failed when ok is false (core.ts:1014-1015). runEnd shows
    any `ok === false` as "failed" (runContract.js:400). 15.3 asks for `{ok: true, pass: false, failed_check,
    checks}`, so the run reads "finished: FAIL", as a pre-check that ran and found a problem should.
  - **The runner drops failed_check.** It accepts the report (sfRunReportProblem, core.ts:785-806, ignores unknown
    keys), but keeps only `{ok, exit_code, pass, checks}` on switchboard_runs.result (core.ts:970-974). It also
    records evidence only when `ok && pass === true` (core.ts:983).

  **What s30 must read:** switchboard_runs.result as the runner stores it. That is `ok` true, `pass` false,
  `failed_check` exactly 'rehearsal', and `checks` the production checks that passed, never rehearsal.
  record_run_evidence reads only that row (v_run.result). So s30's runner change must:
  - validate `failed_check`;
  - keep it in the stored result;
  - call record_run_evidence for that case.

  **Ask the data runs thread to send `ok: true`** for a rehearsal that ran and failed. `ok: false` stays for a run
  that broke.

### 15.7 Totals

- **a:** about 120m of this thread's work (s27 took O5; s28 took O17 and O2), plus the helper's pretend path and the extension's pretend line (both the
  data runs thread's, settled at s26).
- **b:** about 32m.
- **c:** 3m, inside a.
- **d:** 10m.
- **e:** about 30m, later.
- **Before slice 1's walk:** a only, about 120 minutes over s26 to s29 plus three Checkpoints, and the data runs
  thread's parts.
- **s29b:** section 16 replans b, d and e with O22, O23, items 2 to 4 and the runner's mode check (16.7).

## 16. What the data runs thread asked for after s29 (s29b, 2026-11-26; a plan only)

Read against the live definitions with get_sql_read on 2026-11-26. The md5 of each prosrc:
- switchboard_correct_run_request 44d03965 (254, with 256's pretend);
- switchboard_run_preview b34e0d6c;
- switchboard_queue_run_request 76893e08 (257);
- switchboard_record_run_evidence e9893467;
- switchboard_record_run_outcome 5a69fdbc;
- switchboard_consume_run_link cd9e7672.

Live data: 5 requests, all precheck with `selected_by.kind` ids. No evidence or `changed` is stored yet.

### 16.1 O22, the correction shape: what a corrected request carries today

- **page:** `'correction'`, in the column and in request.page.
- **base_page:** a column only (precheck, dataop, undo or check), never in the request jsonb. The preview adds it to
  `request`. The helper's pickup gets the request row whole (runner index.ts runRequest, `select *`), so it reads
  `base_page` from the row.
- **version:** the column, which a correction strips from the jsonb (c_set). The preview adds `request.version`,
  and the pickup row has the column.
  - **An edit that reruns checks** (value, file, field, records, records_filter, sandbox_filter, code) moves the
    request to page `correction`. It sets version = `changed.from_version` + 1 and corrected_at.
  - **A wording or allows edit** reruns nothing. The version, page and corrected_at stay, and
    `changed.from_version` equals version. So `changed` can be on a base page.
- **changed:** `request.changed` is exactly what the chat sent as p_changed, with two keys the database adds:
  `{reason, items: [...]} || {edit_kind, from_version}`. So edit_kind is `changed.edit_kind`. It is also the
  function's p_edit_kind argument, which the database copies in.
  - The database checks only that reason is non-blank and that items is a non-empty array.
  - runContract checks `changed.edit_kind`, `changed.reason` and `changed.items` (4.1: `[{what, old, new}]`).
  - On a correction page, a later wording edit nests under `changed.wording`.
- **still_valid:** the database never stores a checked one. On an edit that reruns checks, `still_valid` is a c_run
  key that the diff ignores, so whatever the chat sends is kept unchecked. On a wording or allows edit it is
  compared, so adding one is refused. No live request has one. The truth is `evidence`:
  - Each entry is `{check, org, passed_at, run_id, commit?, voided?}` (record_run_evidence).
  - A correction marks the checks it reruns `voided: true`.
  - A newer pass of the same check voids the older entry.
  - "Still valid, not run again" = the entries not voided whose passed_at is at or before `corrected_at` (a column;
    the preview also returns `request.corrected_at` and `request.evidence`).
    runContract's statusFromEvidence already builds `changed.still_valid` this way for a correction page, as
    `[{check, passed_at}]`. With no corrected_at it keeps every entry in use.
- **After the reruns pass,** record_run_evidence moves the page back to base_page and keeps `changed`.

**Proposal: no database change.**
- Read page, base_page and version (from the pickup row, or the preview's request), and changed.edit_kind,
  changed.reason and changed.items.
- Derive still_valid from evidence and corrected_at, by statusFromEvidence's rule.
- Their `changed.still_valid` is then a derived view, never a field anyone sends.
- If they would rather not derive it, the preview could return it, as one line in a function we replace anyway. Not
  planned unless they ask.

### 16.2 Items 2 to 4: filter fields, the filter rule, the simulation cutoff

- **Contract (4.1):**
  - `selected_by` is `{kind: "filter", text, sandbox_text?, not_rehearsed?}`, unchanged from today.
  - **details.queries:**
    - A filter request has exactly one query labelled `records`, the production filter, as O17 does for ids.
    - It has exactly one labelled `sandbox records` when selected_by.sandbox_text is present, and none otherwise.
    - An ids request with a `sandbox records` query is refused.
- **The filter rule:**
  - **What it checks:** requestProblems checks the WHERE clause of the `records` and `sandbox records` SOQL, not
    selected_by.text. text is the page's sentence (simulation.js: "created in the last 30 days, with no campaign").
  - **What it allows:** comparisons `<field> <op> <value>` joined by AND only.
    - op is one of = != < <= > >=.
    - value is a quoted string, a number, true, false, null, or an ISO date or datetime.
    - No OR, NOT, IN, LIKE, INCLUDES or EXCLUDES, no brackets, and no relative date literal (LAST_N_DAYS:30,
      TODAY), since a moving filter changes the count between the pre-check and the write.
  - **The parser:**
    - It reads the WHERE clause only, stopping at ORDER BY or LIMIT.
    - It skips quoted strings, so an AND inside quotes isn't a join.
    - It takes `<>` as `!=`, and field paths with dots (`Account.Name`).
    - It accepts an unquoted ISO date or datetime as a value, which Salesforce takes only against date fields; the
      run's own query checks the type.
  - **Refusals:** each one names its fix ("Fix details.queries "records": only comparisons joined by AND …").
  - **Where it runs:** runContract only, as O17. The queue function doesn't read details.
- **simulation.js:**
  - FILTER_SOQL's `CreatedDate = LAST_N_DAYS:30` becomes `CreatedDate < 2026-11-20T00:00:00Z`.
  - The filter queries are labelled `records` (and `sandbox records` where sandbox_text is), and the texts say
    "created before 20 November 2026".
  - The 45-day correction scenario becomes a moved cutoff, and not_rehearsed ("The 30-day limit on CreatedDate.")
    becomes "The CreatedDate cutoff.".
- **Files:**
  - runContract.js and runContract.test.js;
  - simulation.js and simulation.test.js;
  - mcp/index.ts and index.test.mjs (the description names the labels and the rule).
- **Deploy:** mcp, which imports runContract.js. No table or SQL.
- **The data runs thread's answers (s30):**
  - the rule checks the WHERE clause of the `records` and `sandbox records` SOQL, not selected_by.text. It refuses
    OR, IN, LIKE, brackets, NOT and relative dates (LAST_N_DAYS, TODAY, YESTERDAY, THIS_ and LAST_ literals and the
    like);
  - `sandbox records` is required whenever selected_by.sandbox_text is present, and refused when it isn't;
  - the five live ids requests are untouched (filter only).
  - They accepted the O22 answer (16.1) as written: no preview change.

### 16.3 Item e, the check line and the check result

- **The runner:**
  - sfRunKind gains `check`: the link's approval (link.action_id) on a request whose base_page is check. Consume sets
    action_id for a check page's Approve (it is not a rerun), so 254's link test already passes.
  - The body may carry `check: {job, at_goal, at_backup, neither}`, on a check run only; it is refused on any other
    kind.
    - `job` is Salesforce's job state: Queued, Preparing, Processing, Holding, InProgress, Completed, Failed or
      Aborted, or `none` for a small run with no job. Letters only (the data runs thread's answer, s30; built in
      s32, and the database's shape check in s31 takes the same list).
    - at_goal, at_backup and neither are whole numbers, 0 or more, at most MAX_QUERY_COUNT.
    - No other key.
  - On ok true, `check` is required. The runner stores `{check: {...}}` through switchboard_record_run_outcome,
    before the status, as a write's outcome is (refusals noted, a network error retried).
  - **Runner changes this needs:**
    - recordOutcome is gated on `kind === "write" && body.write`, and learns the check kind with `body.check`;
    - sfRunReportProblem checks `check`'s shape only once the kind is known (after the link and request read), so
      the check moves after the read;
    - FINAL_FIX and the notes name the check page.
  - The line comes from runContract's checkLine(linkId, check, simulated): "check <link id> done: job <job>; <a> at
    goal, <b> at backup, <c> neither", starting "SIMULATION " for a pretend run.
  - checkLine gains the `simulated` flag, as runLine did at s28.
  - The runner imports runContract.js as the mcp tool does (`../../../src/switchboard/runs/runContract.js`).
  - A failed check run keeps `run <link id> failed`.
- **The database:** record_run_outcome allows base_page check, beside dataop and undo.
  - On a check request, the outcome must be exactly `{check: {job, at_goal, at_backup, neither}}`, with job matching
    the runner's rule and three non-negative integers, else 22023.
    - The shape check runs once the request is read, before the `outcome_run_id = p_run_id` early return. So a bad
      outcome is refused even on a run that already has one.
  - The 55000 wording changes from "only a data operation or undo" to "… or a check".
  - dataop and undo are unchanged.
  - Every other rule stands: a finished real or pretend run, its link's approval, not expired, the pretend match, and
    one outcome per request.
- **The page:** RunPage's Outcome learns the check page (RunPage.jsx:153 draws only dataop and undo). It shows the
  job state and the three counts.
- **Files:**
  - runner core.ts and core.test.mjs;
  - runContract.js and its test (checkLine);
  - RunPage.jsx with a test;
  - the migration (16.7) and test 9 (16.7).
- **Tables:** switchboard_run_requests (outcome columns), read: switchboard_runs, switchboard_actions,
  switchboard_run_links.
- **Deploys:** switchboard-runner; mcp only if runContract's change lands in the same step.

### 16.4 O23, interrupted.request_id on a check page

- **Contract (4.6):** `interrupted.request_id` is optional on a check page: the data operation the interrupted run
  was.
- **runContract:**
  - a lower-case uuid;
  - refused on any page but check, as O5's undo_of.request_id is.
  - The tool lower-cases it, as it does undo_of.request_id.
- **The queue** (switchboard_queue_run_request), beside 257's undo_of block, and with the same error forms:
  - It must name the caller's own request (P0002 if none).
  - That request's base_page must be dataop.
  - It must be in the same project.
  - Simulation and pretend must match.
  - The check page's `operation.object` and `operation.kind` must equal the data operation's, and so must
    `operation.field` when the data operation has one: an insert, delete or undelete has none (23514, naming both
    sides). A check page with no operation is refused, naming what to add.
- **A correction** can't change it. interrupted is in neither c_words nor c_run, so any difference is refused by the
  diff.
- **Files:** runContract.js and its test; _shared/tools/switchboard-runs.ts and its test; mcp/index.ts and its test;
  the migration and test 9.
- **Tables:** switchboard_run_requests, read.
- **Deploy:** mcp.

### 16.5 The runner's own mode check (from s29)

- **The check:** sfRunRecord, right after the request is read: if `(r.mode === 'pretend') !== (request.pretend ===
  true)`, then a final refusal. The reply is 422 with retry false; the line is "run <link id> failed", with
  SIMULATION on a pretend run; the fix is PRETEND_MISMATCH_FIX.
  - `final()` today drops a write's sample and calls recordOutcome, so the mismatch takes its own path, or a flag
    on `final()`. That path finishes the run and fails the action, and calls neither.
- **What it covers:** every kind, a failed pre-check and a write included. The database's 55000 stays the backstop.
- **Tests:**
  - both directions refused before any evidence, sample or outcome call;
  - s29's mismatch tests move to the database backstop: the fakes' request agrees, and the evidence or outcome fake
    still throws 55000.
- **Files:** runner core.ts and core.test.mjs.
- **Deploy:** switchboard-runner. No table.

### 16.6 How each database change is proven before Alex approves it (the lesson of 256)

- **The test file first:** test 9 (`supabase/tests/sb3_pages-h6v/9_slice2_test.sql`, run with --test; it replaces
  15.3's `9_kept_checks_test.sql`) is drafted
  and cold-reviewed with the migration, before the migration is queued.
  - It covers item b's kept checks (15.3), O23's refusals and acceptance, item e's outcome on a check request, and
    the unchanged dataop and undo outcomes.
  - It is one self-undoing block that returns its checks as one row (CLAUDE.md).
- **The smoke check:** the migration ends with a DO block that calls each replaced function past its changed lines.
  So the approve page's dry run fails if any of them doesn't parse or run.
  - **switchboard_queue_run_request.** It sets the JWT claims as 257 does and keeps 257's two cases. It adds a check
    page with `interrupted.request_id` 'not-a-uuid', caught only as check_violation with O23's message. It also adds
    the queue part of item b (15.3).
  - **switchboard_record_run_evidence and switchboard_record_run_outcome.**
    - **Setup:** inside an inner begin … exception block, as Alex (as test 6 does), it queues a pretend check
      request, issues and consumes its link, and inserts a finished pretend run.
    - **Outcome:** it calls record_run_outcome with a bad `{check}` first, expecting 22023, then a valid one,
      expecting recorded true.
    - **Evidence:** a second setup gives a pre-check request with rehearsal evidence in use, a link, and a finished
      run with `failed_check: 'rehearsal'`. It calls record_run_evidence, which reaches the voiding lines. It also
      reaches the queue's "no rehearsal in use" refusal (15.3).
    - Only the queue, consume and the preview read auth.uid(); outcome and evidence use the run's user_id.
    - **Undo:** it ends by raising a sentinel, caught by name, so every row it made is undone even on the real run.
  - Then `select public.platform_check_conformance()`.
- **The dry run is the proof.** Alex approves only after the approve page's dry run is clean, which it can't be if a
  smoke call fails. After applying, test 9 runs with --test.

### 16.7 One migration, and the step breakdown from s30

Item b (15.3) already planned a migration replacing switchboard_record_run_evidence and the queue. O23 and item e
add the queue and switchboard_record_run_outcome. So there is **one migration**,
`supabase/migrations/258_slice2.sql` (drafted as `_pending_sb3_pages-h6v_slice2.sql`, numbered at s31b):
- it replaces switchboard_queue_run_request (b's part, O23), switchboard_record_run_evidence (b),
  switchboard_record_run_outcome (e) and, from s31b, switchboard_correct_run_request (16.9);
- grants as today, revoked from public and anon;
- the smoke check, then conformance.

Its db: items, claimed at the step that queues it:
- db:fn:switchboard_queue_run_request;
- db:fn:switchboard_record_run_evidence;
- db:fn:switchboard_record_run_outcome;
- db:table:switchboard_run_requests.

| Step | What | Estimate |
|---|---|---|
| s30 | No database. Runner mode check (16.5), filter fields, rule and cutoff (16.2), O23's runContract and tool part (16.4), checkLine's flag; tests; cold review; claim db:deploy, deploy mcp and the runner | 35m |
| s31 | Draft the one migration (b, O23, e) and test 9; cold review of both against the live bodies | 40m |
| s31b | gitsync if behind, drift check, claim the db: items, number it, write it, queue it | 4m |
| s31c | After Alex approves (on a clean dry run): queue test 9 with --test, check it | 3m |
| s32 | Runner: item b (15.3) and item e's check kind, body, outcome and line; RunPage's check outcome; item d (15.5); tests; cold review; claim db:deploy, deploy the runner | 35m |

That totals about 117 minutes, plus Checkpoints after s30, s31c and s32. s30 can ship before the migration:
- O23 in runContract alone refuses only malformed ids;
- the queue's check of the named request waits for s31.
Item e's runner side waits for s32, after the slice 2 migration accepts a check page.

**s29b cold review** (one round, against five of the six live bodies; its read budget ran out before evidence,
which s29b had read in full).
- **The one must-fix, fixed:** 16.1 said version is always one up from from_version. A wording or allows edit
  keeps it.
- **Should-fixes, all taken:**
  - still_valid is compared on a wording edit;
  - the outcome's shape check comes before its early return;
  - the runner's recordOutcome gate, the kind-aware shape check and the 55000 wording;
  - O23 compares field only when the data operation has one;
  - the mode check skips final()'s drop and outcome;
  - the evidence smoke test's own setup;
  - db:deploy in s30 and s32;
  - one name for test 9;
  - the filter parser's details and the not_rehearsed wording.
- **Confirmed:** consume sets action_id on a check page's Approve, and O23 matches 257's codes. interrupted can't be
  changed by a correction.

### 16.8 s30 as built (2026-11-27), deployed

- **16.5, the runner's mode check** (core.ts sfRunRecord):
  - right after the link and request are read, before the report's shape check, so before any evidence, sample,
    drop or outcome call: `(r.mode === 'pretend') !== (request.pretend === true)` fails the run.
  - The reply is 422, retry false, status failed, the line "run <link id> failed" (SIMULATION on a pretend run), and the
    error "refused by the runner: a pretend run on a real request — <PRETEND_MISMATCH_FIX>" (or the other way round).
  - `final(…, touch = false)` skips the drop, the outcome and the write reply. The run row gets `{exit_code?,
    refused: 'mode', ok: false}`; on a retry of a run already finished, only its summary changes.
  - s29's mismatch tests now test the database backstop: the fakes agree on mode, and 251's or 254's 55000 is still
    reported.
- **16.2, the filter** (runContract.js):
  - A filter needs exactly one `records` query, and one `sandbox records` exactly when sandbox_text is set (refused
    otherwise); an ids request with `sandbox records` is refused; a blank sandbox_text is refused.
  - `filterQueryProblem(label, soql)` checks each one's WHERE clause, to ORDER, LIMIT, GROUP, OFFSET, FOR or WITH. It
    refuses OR, NOT, IN, LIKE, INCLUDES and EXCLUDES and brackets, there or after the end keyword; WITH other than
    SECURITY_ENFORCED, USER_MODE or SYSTEM_MODE (WITH DATA CATEGORY); a relative date in a value's place only (so
    `Last_Name__c` is a field); and anything not `<field> <op> <value>`. Quoted strings are one token.
  - `SELECT Id FROM Gift__c WHERE CreatedDate < 2026-11-20T00:00:00Z AND Status__c = 'Open'` is accepted (tested).
  - simulation.js: FILTER_SOQL's cutoff is `CreatedDate < 2026-11-20T00:00:00Z`; the four filter scenarios carry
    `records` (and `sandbox records` with sandbox_text), the texts say "created before 20 November 2026", and the
    records_filter correction moves the cutoff to 22 November.
  - **Deferred to s32:** precheck-filter-differs keeps not_rehearsed "The 30-day limit on CreatedDate.", because
    RunPage.test.jsx:72 pins it and wasn't in s30's scope. correction-sandbox-filter has "The CreatedDate cutoff.".
- **16.4, O23's runContract part:** interrupted.request_id is a lower-case uuid on a check page only. The tool
  lower-cases it on the queue, and on a correction both undo_of.request_id and interrupted.request_id (so a capitalised
  echo isn't refused by the database's diff). The queue's check of the named request comes in s31.
- **checkLine(id, check, simulated = false):** SIMULATION on a pretend check run; a real line is unchanged.
- **mcp:** queue_switchboard_run_request's description names the filter labels, the AND rule and
  interrupted.request_id.
- **Cold review** (one round): no must-fix. Both should-fixes taken: the clause's tail is checked, and the mode
  check keeps a finished run's result. It confirmed no real run's line changed and the live ids requests are untouched.
- **Tests:** runner 175, _shared/tools 975, mcp index 56 and tables 1, switchboard folder 605, app 3892 (7 skipped),
  scripts 77; the build compiles.
- **Deployed** holding db:deploy, from e97de96 with main's commits present: mcp at 06:18:03 and switchboard-runner
  at 06:18:08. Without a token, mcp, /queue and /result answer 401.

### 16.9 s31 to s31d: the slice 2 migration (258) and test 9 (2026-11-27; 258 applied, test 9 queued)

Files: `supabase/migrations/258_slice2.sql` (the pending draft until s31c) and
`supabase/tests/sb3_pages-h6v/9_slice2_test.sql`.

- **Bases:** live md5s are unchanged since s29b. The bodies in 257 (queue) and 256 (evidence, outcome) hash to
  them, so each new body is that file's, changed only for these items. A diff of each body shows nothing else.
  interrupted is in neither c_words nor c_run of switchboard_correct_run_request, so its diff refuses any change to
  interrupted.request_id (test 9 proves it). s31b replaces that function too, for field and value (below).
- **Item b, evidence:**
  - `v_failed` = ok true, pass false and failed_check `"rehearsal"`, coalesced to false.
  - failed_check on any other result is 23514.
  - A failure skips the "did not pass" refusal; listing a rehearsal is 23514; empty checks are still 23514.
  - `v_void` (the run's checks, plus rehearsal on a failure) drives both the newer-evidence refusal and the voiding,
    so an older failure never voids a newer rehearsal.
  - The reply gains `rehearsal_failed`. The runner reads no field of evidence's reply and only passes it on, so the
    new key changes nothing.
- **Item b, queue:** after the copy, the data operation is refused when no rehearsal is in use among the copied
  checks (23514).
- **O23, queue:** after the undo_of block, with the same codes:
  - interrupted.request_id is refused off a check page, and when not a lower-case uuid;
  - P0002 when it isn't the caller's;
  - refused when its base_page isn't dataop, or the project, simulation or pretend differ;
  - refused with no operation;
  - then one 23514 names each of object, kind and field (field only when the data operation has one), both sides.
- **Item e, outcome:**
  - base_page check joins dataop and undo, with the new 55000 words.
  - On a check, the shape check comes right after that gate, before the simulation, pretend and once-per-run lines:
    exactly `{check: {job, at_goal, at_backup, neither}}`, job in the nine states, counts matching `^[0-9]{1,9}$`
    (22023). It sits inside a case on jsonb_typeof, so the key removal never meets a scalar.
- **Expressions checked before review:** the outcome shape, v_failed, v_void and the diff format were each run with
  get_sql_read on literals (15 outcomes and 8 results). All gave the intended answer.
- **Smoke check (section 5 since s31b)**, inside the migration:
  - 4a: 257's two cases, as a made-up user.
  - 4b: as Alex, on pretend requests in smoke-slice2 projects, made, linked and approved through the functions,
    with runs inserted by hand (no pickup). It ends with a sentinel that undoes everything.

| Call | Reaches |
|---|---|
| evidence, failed_check on a pass | v_failed, the failed_check refusal |
| evidence, rehearsal listed on a failure | the new pass test, the rehearsal refusal |
| evidence, the failure | v_void, the newer test on it, the voiding, the reply's rehearsal_failed |
| queue, data operation on that pre-check | the copy and the no-rehearsal refusal |
| outcome on the pre-check's run | the new base-page refusal and its words |
| queue, interrupted.request_id on a dataop | the off-check refusal |
| queue, 'not-a-uuid'; a random uuid; a pre-check's id | the uuid test; the lookup and P0002; the base_page refusal |
| queue, other project; real check; plain-simulation check | the project, simulation and pretend refusals |
| queue, no operation; another object, kind and field | the operation refusal; the three comparisons and the diff message |
| queue, the matching check | every condition in the block, to the insert |
| outcome, a bad job | the gate passing a check, the shape refusal |
| outcome, a good check; then a bad count on that run | the update; the shape refusal before the once-per-run return |
| correction (s31b), a field edit on the check page | the new base-page test and its refusal, its % argument |
| correction (s31b), a value edit on the check page | the same test and refusal, for the other kind |
| correction (s31b), a field edit on the data operation | the new test passing a non-check page, to the version raise |

- **Test 9:** one self-undoing block returning one row, in test 8's style. It covers:
  - item b's failure, each refused form, the newer rehearsal, the full pass, a records correction that stays a
    correction, and the queue refusing and accepting;
  - O23's acceptance (field skipped for a delete), interrupted without request_id, 19 refusals, and the correction
    refusing a change or removal;
  - item e's 19 refused shapes, each of the nine jobs, already, a bad shape after one is kept, the pretend and plain
    simulation rules, the pre-check refusal, and the dataop and undo outcomes unchanged;
  - 256 and 257's rules, the grants, the comments, and conformance.
- **Cold review** (one round, against the live bodies; md5s rechecked): no must-fix. It confirmed:
  - unchanged lines are byte-identical;
  - every new jsonb `-` or `?&` is guarded;
  - the smoke check executes every changed statement, catches only by SQLSTATE and words, and undoes everything;
  - no Q10 lock is hit;
  - each test 9 check passes against this draft.
  Taken:
  - the "already" reply carries `rehearsal_failed` too;
  - test 9's correction checks assert 23514 and the wording edit's words;
  - interrupted.request_id on an undo is refused;
  - 999999999 is accepted.
  Left: "(none)" on both sides when one has JSON null (cosmetic); no other-user or dataop-correction-rerun case.
- **Answered at s31b (Alex: yes):** a `field` correction on a check page passed switchboard_correct_run_request's
  diff, so a check could be corrected off the interrupted data operation's field. The migration now also replaces
  switchboard_correct_run_request (256's, live 44d03965). Right after the unknown-kind check, on base_page check, a
  field or value edit is refused with 23514: "a check page's operation must stay the interrupted data operation's,
  so a % edit is refused; queue a new check instead." Every other page's corrections are unchanged; a diff against
  256 shows only that block and the comment's new clause.
  - Smoke: three calls (the table above).
  - s31b cold review (one round, against live 44d03965): no must-fix. It confirmed the diff, the parse
    (`=` and `in` bind tighter than `and`; a null base_page is false; a null kind is refused earlier), and that each
    smoke call and test 9 check passes. Kept as is: the refusal comes before the request-shape checks, so a malformed
    field or value edit on a check gets this sentence first, still 23514. The tool passes the words through and
    matches on none.
  - Test 9: field and value refused on the check, the check unchanged; a wording edit on it still made; field and
    value edits on a pre-check still made; the comment and grants.
- **Number:** 258, from claims.cmd number-migration at s31b (claimed as db:migration:258). The file is
  `supabase/migrations/258_slice2.sql`, written at s31c from the pending one.
- **s31c:** the db: items were claimed (db:fn ×4, db:table:switchboard_run_requests; db:migration:258 from s31b). The
  drift check after the gitsync found no new migration, and all four live md5s still matched the bases (44d03965,
  76893e08, e9893467, 5a69fdbc). `258_slice2.sql` was written from the pending file; a diff shows only the
  header's first two lines changed. The pending file was deleted under its claim, and 258 was queued (action id in
  the s31c report).
- **Applied (s31d):** Alex approved 258 as run 04cb994c-b322-48de-9231-7c6ca496d162, ok: all 19 statements,
  including both smoke-check DO blocks (4a, 257's cases; 4b, the slice 2 calls, undone). Conformance: "CONFORMANT —
  all 123 non-exempt public tables satisfy platform contract v1, and anon reaches nothing undecided."
  - Live md5s after the run, each equal to its body in 258: queue 934acd07, evidence 5548ba77, outcome 3b5e3903,
    correction 47ae4fc0.
  - Test 9 queued with --test as action adf5d443-59ce-4c17-874e-3ddded6e0882 (one run, undone): run
    2eec7697-6214-4e16-9b07-44f123f84bb2 passed 47 of 47. The Checkpoint after it carried 258, test 9, the spec and
    the progress file into main and released the db: claims.

### 16.10 s32 as built (2026-11-27); the runner's deploy waits for its deno.json

- **Item b, runner (core.ts):**
  - sfRunReportProblem(body, kind) takes `failed_check: "rehearsal"` only on a pre-check, with ok true, pass false,
    non-empty checks, no rehearsal among them and no sample. Each other form is a 400 refusal naming the fix, before
    any evidence call.
  - The run row keeps failed_check, and switchboard_record_run_evidence is called for such a result.
  - The line is "run <link id> done: FAIL" (contract 4.4), with SIMULATION on a pretend run. ok false stays "run
    <link id> failed".
  - A refused kept-checks record is noted on the run ("kept checks refused (code): …"), never final(). A network
    error is retried (503). The sample is stored only on a full pass, as before.
- **Item e, runner:**
  - sfRunKind gains `check`: the link's action_id on base_page check.
  - A check run reports `check: {job, at_goal, at_backup, neither}` instead of pass. Its shape is runContract's
    checkResultProblem: the nine job states, counts 0 to 999,999,999, nothing else, as 258's outcome rule.
  - It is required when ok is true and refused otherwise. pass, checks, failed_check and sample are refused on a
    check (from the cold review), and check is refused on any other kind.
  - A wrong shape is refused before anything is stored: final() with touch false, so no outcome, evidence, sample or
    drop call; the run row gets `{exit_code?, ok: false}`.
  - A good check goes on the run row and, as `{check}`, through switchboard_record_run_outcome. 258's refusals are
    noted, as a write's are.
  - The line is checkLine's: "check <link id> done: job <job>; <a> at goal, <b> at backup, <c> neither" (counts
    with thousands separators), with SIMULATION for a pretend run. A repeat answers it from the run row. A failed
    check keeps "run <link id> failed".
  - The runner imports checkLine and checkResultProblem from src/switchboard/runs/runContract.js, as mcp's tools do.
- **Page (runContract.js, RunPage.jsx):**
  - checkOutcomeView draws only an exact `{check}`: "What the check found", the job ("no job (a small run)" for
    none) and the three counts.
  - outcomeView adds stopped.next (one line, at most 200 characters), stopped.by_step ({step, object}, each at most
    80) and skipped ([{kind, count}]). A stop with only next now shows. Counts and names only; anything malformed is
    left out.
  - Two simulation scenarios: run-stopped-detail and check-finished-outcome.
- **The deferred rewording:** precheck-filter-differs's not_rehearsed is "The CreatedDate cutoff.", and
  RunPage.test.jsx matches.
- **No real run's line changed.** A test pins the pre-check PASS, FAIL and failed lines, the write's, and the
  repeat's.
- **Tests:**
  - runner 184 of 184 (19 new or changed for s32);
  - switchboard folder 618, full app suite 3905 (7 skipped);
  - scripts 77; tools and mcp index 70;
  - the build compiles.
- **Cold review** (one round): one must-fix.
  - runContract.js imports codeDiff.js, which imports the bare package `diff`. switchboard-runner/deno.json maps
    nothing (mcp's maps `"diff": "npm:diff@5.2.0"`), so the runner would fail to load under Deno.
  - Node finds `diff` in node_modules, so the tests can't catch it.
  - The fix is that one line in switchboard-runner/deno.json. The claims guard refused the edit: the file wasn't in
    the plan, and it is unclaimed.
  - **So the runner is not deployed;** the live runner is still s30's.
  - Other confirmations: no real run's line changed; a wrong-shape check is refused before anything is stored; the
    rules agree with 258; retries behave.
  - Its should-fix (refusing pass, checks, failed_check and sample on a check) is taken.
- **For the helper:** a check page's run must now send check, not pass. Until the helper does, a check page's run
  fails with a 400 naming the fix.

**s32b (2026-11-27):**
- **deno.json:** switchboard-runner/deno.json now maps `"diff": "npm:diff@5.2.0"`, as mcp's does, claimed at s32b.
- **Deployed** holding db:deploy, with main's commits present: switchboard-runner at 07:53:01 (924 kB). An
  unauthenticated POST to /result answers 401 `{"ok":false,"error":"unauthorized"}`, the runner's own body, so it
  boots under Deno with the runContract import.
- **Run pages behave like git links** (Alex's decision, for the data runs thread's extension 1.2.45):
  - Nothing posts into the chat at Approve. The extension wakes the helper from the page's marks without posting
    and closes the tab; the only chat line is the result, from the tile.
  - ResultLine gains `wake`, set on the run page's Approve, rerun, reruns and resent lines. They carry new notes:
    - WAKE_LINE_NOTE: "Nothing goes to the Claude chat from here: the desktop helper has been told. The result line
      comes from the tile when the run ends, and this tab closes by itself."
    - PRETEND_WAKE_LINE_NOTE: the same, for a pretend run, with "Its SIMULATION result line…".
    - SIM_WAKE_LINE_NOTE, on a plain simulation (from the cold review): "A simulation sends nothing. On a real page
      nothing goes to the Claude chat from here either…".
  - Wake lines have no "Copy this line for the chat" button.
  - Unchanged: every mark (data-switchboard-line and -link-id; the page's -running, -action-id, -pretend, -project
    and -kind) and the hidden status block with its Try again. Cancel ("Don't run") keeps REAL, PRETEND and
    SIM_LINE_NOTE and its copy button.
  - The review and approve pages are unchanged: CodeReviewPage passes no `wake`, and ApprovePage has its own line.
- **Tests:**
  - pageMarks and pretend pin the new notes and the missing button, on Approve and on the reruns line;
  - a new test pins Cancel's note, button, line and status block;
  - two RunPage tests matched the old note's last word.
  - Results: runner 184, switchboard folder 619, full app suite 3906 (7 skipped); the build compiles.
- **Cold review** (one round): no must-fix. It confirmed that the marks, the status block, Cancel, and the review and
  approve pages are unchanged. Its should-fixes are taken: the plain simulation's note, and pinning the reruns
  line.

## 17. Slice 2's last two asks: O18 kept TEST records, O24 the delete page (s33, 2026-11-27; a plan only)

The data runs thread's slice 1 walk passed clean on our pages, wording and runner (switchboard 93baaa7, extension
1.2.45). This part plans its two remaining slice 2 asks against the live definitions read at s33.

| Function | live md5 (prosrc) | latest file |
|---|---|---|
| switchboard_queue_run_request | 934acd07 | 258 |
| switchboard_consume_run_link | cd9e7672 | 256 |
| switchboard_correct_run_request | 47ae4fc0 | 258 |
| switchboard_record_run_outcome | 3b5e3903 | 258 |
| switchboard_record_run_evidence | 5548ba77 | 258 |
| switchboard_run_preview | b34e0d6c | 255 |
| switchboard_retry_run | eeab7c9b | 256 |

Pages are listed in five places in the database: the two check constraints on switchboard_run_requests (page,
base_page), queue's page list and count rule, consume's count rule, outcome's base page list, and correction's
write gate. Retry and preview are page-neutral except "no expiry for an undo". The run pages edge function's routes
name no page, so they need no change.

### 17.1 O18, keeping TEST records

**The request.** `keep_test_records: true` may be sent on a pre-check page only (base page precheck). Only the
value true; false or absent means the rehearsal deletes them as today. Elsewhere it is refused (23514, queue; and
runContract's requestProblems). It needs a rehearsal org (role rehearsal, sandbox). A correction can't add, drop or
change it: correction already refuses any key outside its kind's table, so this needs only a test.

**The step.** With keep_test_records, the step list carries `keep_test` instead of `delete_test`. Its text (agreed
at s34): "Keep the TEST records in the sandbox for later." (`delete_test` is refused alongside keep_test_records, and
keep_test without it.) The rule is checked at queue and again by correction: steps are in correction's c_run, so a
rehearsal-rerunning correction could otherwise swap keep_test back to delete_test (cold review).

**The result.** A pre-check's result may carry `kept_test_records: {count, sandbox}`:
- count a whole number, 1 to 999,999,999; sandbox a string equal to the request's rehearsal org alias; nothing else;
- only on a pre-check run (kind pre-check) of a request with keep_test_records true; refused otherwise;
- allowed with ok true, pass true or false (a FAIL, failed_check rehearsal included; see question 1).

**The runner (core.ts).**
- sfRunReportProblem validates it (a 400 naming the fix, before anything is stored), given the request.
- The run row keeps it: result becomes `{ok, exit_code?, pass?, checks?, failed_check?, kept_test_records?}`.
- Then it calls a new service-role function, `switchboard_record_kept_test_records(p_run_id)`, which reads only the
  run row, as evidence does. A refusal is noted on the run ("kept TEST records refused (code): …"), never final();
  a network error is retried, and a missing function (not yet deployed) is noted, not retried, as
  OUTCOME_MISSING_CODES are.
- It is called **before** the evidence block, which can return early through final() or a 503 retry; a call after
  it would orphan the records (cold review).
- The line is unchanged.

**The database (new column, new function).**
- `switchboard_run_requests.kept_test_records jsonb` (null, or a list), with a column comment. Each entry is
  `{run_id, run_tag, count, sandbox, recorded_at, deleted_by}`, where run_tag is the request's run_tag when the run
  was recorded (a correction may change it), and deleted_by is the delete request's id once its write ran (17.2),
  or null.
- A list, not one object, because a correction that reruns the rehearsal keeps a second set from the same request.
  The delete page deletes every entry not yet deleted, and their counts sum to the count it expects (question 3).
- The function refuses a run that is:
  - not finished;
  - not the pre-check run (by 251's rule: the link's pre-check or its rerun);
  - on a request without keep_test_records true;
  - malformed;
  - for a sandbox that isn't the request's rehearsal org;
  - a plain simulation;
  - a pretend/real mismatch, as evidence refuses.
  One entry per run; a repeat returns already true. It does **not** copy evidence's refusals for a voided link, an
  older version or a run finished before the last correction: the records exist in the sandbox either way.
- The run row's result is pruned after 30 days, so the request column is the durable record.

**The page.**
- preview adds `request.kept_test_records` (from the column) and `run.kept_test_records` (from the run's result,
  when well formed).
- The status line on a pre-check page, after runEnd's word: "N TEST records kept in <sandbox>." Commas in N, one
  record singular. It is taken from the run, or from the request's entry for that run once the result is pruned.
- The pre-check page's "Sandbox rehearsal" banner says "TEST records are created and changed, and kept for later.
  Nothing else changes." when keep_test_records is true (s34).

**How a delete page finds it.**
- Claude reads the pre-check's run with get_switchboard_run (result.kept_test_records), or the request.
- It queues the delete request naming that pre-check (test_data_of.request_id) with counts.expected equal to the sum
  not yet deleted.
- The queue takes the count and the sandbox from the column, never from the chat's word for them; 17.2 lists the
  checks.

### 17.2 O24, the "Delete sandbox test data" page

**The request**, the data runs thread's stand-in:
- page and base_page `delete_test_data`;
- `test_data_of: {request_id, run_tag}`;
- `orgs: [{alias, org_type: sandbox, role: target}]`, exactly one;
- `operation: {kind: "delete", object, object_label}`;
- `counts.expected`;
- steps `find_kept_test`, `type_count`, `delete_kept_test`, `confirm_gone`, in that order;
- the usual headline, problem, side_effects and run_tag.

No selected_by: find_kept_test finds them by the run's marker (question 4).

**The page (runContract.js, RunPage.jsx, look.js, simulation.js).**
- PAGES gains delete_test_data, and GROUPS has `delete_test_data: ['Sandbox clean-up']`.
- Our wording for the four steps, all org sandbox:

  | Step | Text |
  |---|---|
  | find_kept_test | "Confirm <sandbox> is a sandbox, then find the TEST records the pre-check kept, by the Ids saved on your PC. Any already gone are counted and listed." |
  | type_count | "You type the number of TEST records the terminal finds; anything else stops with nothing deleted." (the delete page's own; dataop and undo keep theirs) |
  | delete_kept_test | "Delete those TEST records, and only those. A record that isn't a TEST record stops the run with nothing deleted." |
  | confirm_gone | "Confirm none of them is left." |

  (As built at s34, after the data runs thread's answers 4 and 5: the helper finds them by the Ids on the PC, and
  the typed count is the number found, so nothing on the page promises it equals the kept sum.)
- Banners: the sandbox banner only, "This deletes up to N TEST records. Nothing else changes."; the count sentence
  "This deletes up to N TEST records of <object label> in <sandbox>." There is no production banner, and the page
  refuses to draw if any org is not its one sandbox target.
- Approve label: "Delete the TEST records in SANDBOX".
- Undo line: "Undo: none. Deleted TEST records are not restored; the rehearsal made them."
- countSentence and the count box as an undo's are, from counts.expected. The page sends it with Approve.
- No 24-hour clock (it has no evidence of its own): the page never reads expired. pageExpired and preview's expired
  already give false when there is no evidence, so no change is needed there.
- The outcome is drawn by outcomeView, as a write's.
- Two simulation scenarios: delete-test-data, and delete-test-data-pretend.
- requestProblems for the page:
  - the four steps exactly;
  - one sandbox target org;
  - kind delete;
  - counts.expected a whole number of 1 or more;
  - test_data_of.request_id a lower-case uuid;
  - test_data_of.run_tag set;
  - no selected_by, undo_of, interrupted, pre_check_request_id or keep_test_records.

**The database (one migration).** Each place that lists pages:
- **Constraints:** page and base_page gain delete_test_data (drop and re-add both, in the same migration).
- **queue:**
  - The page list gains it, and the count rule (`v_page in ('dataop', 'undo')`) gains it, from counts.expected.
  - test_data_of is checked as undo_of.request_id is, and refused on any other page. The id must be a lower-case
    uuid naming the caller's own request (else P0002), and then each of these is a 23514 refusal naming what's wrong:
    - base page precheck;
    - same project;
    - simulation and pretend matching;
    - test_data_of.run_tag equal to that request's run_tag;
    - at least one kept entry not yet deleted (s34, answer 3: every kept set of the pre-check, whatever its run_tag);
    - counts.expected equal to the sum of those entries' counts, and no counts.total (queue's v_total reads total
      first);
    - every one of those entries' sandbox equal to the one org's alias;
    - that org's org_type sandbox and role target, and there is no other org.
  - It also refuses another delete_test_data request for the same pre-check that is approved and not finished.
- **consume:**
  - The count rule gains delete_test_data (p_count must equal total_count).
  - At Approve it checks again that the entries are still undeleted and that the sum still equals total_count. A
    rerun deletes them or keeps more, so a stale page is refused (55000, "the kept TEST records changed; queue a new
    delete page").
  - It re-checks that the one org is a sandbox.
  - It refuses when another delete request for the same pre-check has a used link whose run did not fail without
    starting, as 256 refuses a pre-check that already backed a write (cold review: the queue's check alone goes
    stale).
  - Rerun mode is already refused with no evidence; nothing to add.
- **retry:** replaced too. A resend re-checks the stale sum, the sandbox and the second-page rule, as consume does:
  after 15 minutes a stuck delete no longer counts as live, so the pre-check could be rerun in between.
- **outcome:**
  - The base page list gains delete_test_data, shape-free as a write's.
  - When a delete page's outcome is recorded from a run with result.ok true and pass true, it sets deleted_by on the
    pre-check's entries named in the delete request's `test_run_ids` (below), in the same transaction, after the
    delete request and its link, then the pre-check (no lock cycle).
- **correction:** every edit but wording and allows is refused on a delete_test_data page ("queue a new delete
  page"). After a write, those are refused too: the write gate's `base_page in ('dataop', 'undo')` gains
  delete_test_data.
- **preview:** `expired` stays false (no evidence); it adds the new column on a delete page. No other change.

**The runner.**
- sfRunKind maps base_page delete_test_data to `write`. Its result is a data operation's (`write`), so outcomeOf,
  recordOutcome and writeReply apply unchanged, and the line is sfRunLine's, as a write's.
- sfRunReportProblem refuses kept_test_records and failed_check on it, as on any write, and requires `write` when ok
  is true on a delete page: without it no outcome is recorded, so deleted_by would never be set (cold review).
- Nothing is recorded today, because sfRunKind calls it "other"; this fixes that.

**Production.** The guarantee is layered:
- the queue refuses any org that isn't the one sandbox target;
- consume re-checks it;
- the page draws no production banner and refuses to draw with a production org;
- the helper runs only against `orgs[0].alias`.

Every database layer checks org_type as the chat declared it (cold review, must-fix). So the helper must also
confirm the org really is a sandbox (Organization.IsSandbox) before find_kept_test, and stop with nothing changed
if not. That is a stated helper requirement (question 8). The runner never runs Salesforce, so it adds nothing
here.

**test_data_of: the right field?** Yes. It follows undo_of and interrupted (`<what it is>_of: {request_id,
run_tag}`), and the database checks it the same way. Two changes to the stand-in:
- the count and sandbox are never taken from it (they come from the column);
- the run ids it deletes are kept at queue time in a new column, `switchboard_run_requests.test_run_ids uuid[]`,
  not in the request JSON. In the JSON a wording correction would have to echo them, and the diff would refuse
  anything else (cold review). The outcome marks exactly those.

### 17.3 Contract changes (spec part 4)
- **4.1 request:**
  - keep_test_records (pre-check only);
  - page delete_test_data with test_data_of {request_id, run_tag};
  - step codes keep_test, find_kept_test, delete_kept_test and confirm_gone.
- **4.4 result:** kept_test_records {count, sandbox} on a pre-check; a delete page reports write, as a data operation
  does.
- **4.5 lines:** none new.
- **mcp:** the queue tool's description names keep_test_records and test_data_of. The tool (switchboard-runs.ts)
  lower-cases test_data_of.request_id, as lowerIds does for undo_of.

### 17.4 Files, database items, deploys, tests

| Step | Files | Database / deploy |
|---|---|---|
| s34 | runContract.js (PAGES, GROUPS, STEPS, countSentence, bannerLines, the count readers, requestProblems), RunPage.jsx (the "nothing expires" line, the outcome list, PHASE_HEADERS), liveSource.js (countMismatch), look.js, simulation.js and their tests (runContract, RunPage, simulation, liveSource, pageMarks, pretend) | none |
| s35 | `supabase/migrations/_pending_sb3_pages-h6v_slice2b.sql`, `supabase/tests/sb3_pages-h6v/10_slice2b_test.sql`, the spec | none (drafted, not queued) |
| s35b | the numbered migration (number-migration), the pending file deleted | db:table:switchboard_run_requests; db:fn: queue, consume, retry, correct, outcome, preview, record_kept_test_records; queued |
| s35c | test 10 queued with --test | md5 check of the replaced functions |
| s36 | switchboard-runner core.ts and core.test.mjs; _shared/tools/switchboard-runs.ts and its test; mcp/index.ts and index.test.mjs | db:deploy: switchboard-runner and mcp, after the migration is live |

**The migration**:
- the two columns (kept_test_records, test_run_ids) and their comments;
- both constraints (`switchboard_run_requests_page_check` and `_base_page_check`, names confirmed live);
- queue, consume, retry, correct, outcome and preview replaced;
- the new function, with `revoke all … from public, anon` and `grant execute … to service_role`.

Then a smoke DO block that calls every replaced function past each changed line and is undone with a sentinel
exception caught by name, as in 258. It covers:
- a keep_test_records request, accepted and refused;
- a kept record and a repeat;
- each test_data_of refusal;
- a delete page's consume with the right and the wrong count, and a stale sum;
- its outcome setting deleted_by;
- a correction refused;
- preview reading both new keys.

It ends with `select public.platform_check_conformance()`.

**Test 10** (`supabase/tests/sb3_pages-h6v/10_slice2b_test.sql`): every smoke case as a numbered check, plus:
- a real/pretend mismatch at each function;
- a second delete page refused while one is approved;
- the new function refused for authenticated;
- the constraints refusing an unknown page;
- 258's check page and test 9's interrupted rule still passing (one each, unchanged).

It returns a result row from a block that undoes itself, and is drafted and cold-reviewed with the migration at s35
before either is queued.

### 17.5 Step breakdown and estimates (from s34)

| Step | What | Estimate |
|---|---|---|
| s34 | Page and contract: keep_test_records, kept status line, the delete page, its simulations; tests | 35m |
| s35 | Draft the migration and test 10, with the smoke check; cold review | 45m |
| s35b | Claims, gitsync, drift check, number, write, delete pending, queue | 12m |
| s35c | md5s after the apply, queue test 10 | 8m |
| s36 | Runner (kept_test_records, delete kind), tool, mcp; deploy both; boot check | 35m |
| s36b | Checkpoint (Alex), then the data runs thread's slice 2 walk | Alex |

s34 can ship before the database. Until s35b is applied, a delete page can't be queued (the constraint refuses it),
so only simulations show it. Two cautions:
- mcp imports runContract.js, so any thread's mcp deploy after s34 ships its new request rules early. That is
  harmless: the database still refuses the page.
- Today's queue stores keep_test_records as sent, and today's runner drops kept_test_records. So the helper must
  not honour keep_test_records until s36 is deployed, or the records are kept with no record of them.

### 17.6 Questions for the data runs thread (answered at s34; answers and changes in 17.7)
1. **When kept_test_records comes:**
   - on pass and on a FAIL (failed_check rehearsal included)?
   - on ok false, when the run broke after creating them, and with what count?
2. **The step:** is it right that keep_test replaces delete_test in the step list, and is our wording right?
3. **Reruns:** a correction that reruns the rehearsal with keep_test_records makes a second set. Does
   find_kept_test find both by one run tag, and is the delete page's count their sum?
4. **The marker:** how are kept TEST records marked (the run tag in a field, the name)? Our find_kept_test text says
   "by its run tag".
5. **Partly deleted:** if find_kept_test finds fewer than expected (some deleted by hand), does the run stop with
   nothing changed, as type_count does? That is our plan. And does ok true mean all were deleted, so deleted_by is
   set on every entry?
6. **The result:** the delete page's result is `write` with the same keys as a data operation's. Is anything else
   needed (for example `{deleted}`)? Its line is a write's "run <link id> done: …".
7. **Which runs a page deletes:** the queue keeps the run ids itself (a column, not in the request), taking the
   undeleted entries with test_data_of.run_tag. Any objection? Could the helper delete by the record ids it kept on
   the PC, rather than by the marker alone?
8. **Production:** will the helper confirm Organization.IsSandbox before find_kept_test, and stop with nothing
   changed if it is false? Every database check reads org_type as the chat declared it.
9. **Timing:** please don't honour keep_test_records until s36 (runner and mcp) is deployed.

**Cold review (s33, one round):**
- Four must-fixes, all taken:
  - the IsSandbox requirement (question 8);
  - run_tag kept on each entry;
  - correction re-checking the keep_test step rule;
  - run ids in a column, not the request.
- Should-fixes taken:
  - the runner's call before the evidence block;
  - write required on a delete page, and deleted_by on pass true;
  - consume's and retry's second-page and stale-sum re-checks (db:fn:retry added);
  - the missed page lists in RunPage, liveSource and runContract;
  - counts.total refused;
  - the ordering cautions;
  - allows named in the correction rule.
- It confirmed:
  - the routes name no page;
  - with no evidence, nothing ever reads expired;
  - consume already refuses rerun mode;
  - the fingerprint is unaffected;
  - the lock order has no cycle;
  - the constraint names.

### 17.7 The data runs thread's answers (s34, 2026-11-27), and what they change

1. **When:** kept_test_records comes on a pass (the TEST records kept) and on done: FAIL at a rehearsal step when
   the request keeps them (the records left in the sandbox), never on ok false. So the runner records them on the
   item b path (failed_check rehearsal) too, as 17.1 planned; ok false with kept_test_records is refused.
2. **The step:** keep_test replaces delete_test; "Keep the TEST records in the sandbox for later." is right (built).
3. **Reruns:** each run that keeps records adds its own set. The delete page deletes every kept set of its
   pre-check, and its count is their sum.
   - **Change:** the queue sums every undeleted entry of the pre-check. It no longer filters by run_tag;
     test_data_of.run_tag is still checked as the pre-check's own.
4. **The marker:** the helper keeps the kept records' Ids on Alex's PC (rehearsal-ids.csv), and find_kept_test reads
   exactly those. It stops with nothing deleted if any isn't a TEST record. Record Ids never go to the database;
   run ids are enough on our side (built: find_kept_test's text says "by the Ids saved on your PC").
5. **Fewer found:** this is not a stop.
   - Records already gone are counted as already gone and reported, and the typed count is the number found.
   - ok true with pass means every record found was deleted and confirmed gone.
   - Only a non-TEST record or a non-sandbox org stops the run with nothing deleted.
   - **Change:** the page promises "up to N" and says the terminal asks for the number it finds (built).
   - Approve still sends the request's count (the kept sum), which consume checks; the typed number is the
     terminal's.
   - deleted_by is set on ok true and pass true, as planned.
6. **The result:** exactly a data operation's write (as planned).
7. **Run ids:** enough (test_run_ids, as planned).
8. **Production:** the helper confirms Organization.IsSandbox on the real org before find_kept_test, and stops if
   not. find_kept_test's text says so.
9. **Timing:** they won't honour keep_test_records until s36 is deployed.

### 17.8 s34 as built (2026-11-27): the page and contract side; no database change, no deploy

**runContract.js:**
- PAGES gains delete_test_data, with DELETE_TEST_PAGE, DELETE_TEST_STEPS and GROUPS ['Sandbox clean-up'].
- PHASE_HEADERS gains "Delete sandbox test data".
- STEPS gains keep_test, find_kept_test, delete_kept_test and confirm_gone.
- `stepDef(code, page)` gives the delete page its own type_count (sandbox, "the number … the terminal finds"). Every
  other page keeps STEPS.type_count unchanged. groupedSteps, requestProblems, afterApproveLines and touches read
  through it.
- requestProblems:
  - keep_test_records, true only, on a pre-check or its correction;
  - keep_test exactly when it is set, and never delete_test with it;
  - a correction that reruns the rehearsal may list keep_test in delete_test's place;
  - test_data_of only on the delete page.
- requestProblems on the delete page:
  - one sandbox target org;
  - kind delete;
  - test_data_of {lower-case uuid, run_tag};
  - counts.expected of 1 or more, and no counts.total;
  - no selected_by, undo_of, interrupted, pre_check_request_id, sample or undo;
  - the four steps, in order.
- The delete page's wording:
  - whatChanges, countSentence and bannerLines (the sandbox only, "up to");
  - approveLabel, undoLine, afterApproveLines, countDetail ("Up to N") and selectedByText.
- rerunRequest ends with keep_test on a keeping request.
- `keptTestLine(r, run)`: "N TEST records kept in <sandbox>." on a pre-check or correction page.
  - It sums every well-formed set not yet deleted, per sandbox.
  - It falls back to the run's own kept_test_records.
- `deletePageOrgProblem(r)`.

**RunPage.jsx:**
- The kept line on the status line (run-kept-test).
- No "Checks valid until" line on a delete page.
- No sample record on a delete page, and its outcome is drawn as a write's.
- A delete page with any org but its one sandbox target is not drawn (run-error), so it offers no Approve.

**liveSource.js:** countMismatch covers the delete page.

**simulation.js:** precheck-keep-test, precheck-keep-test-two-sets, delete-test-data and delete-test-data-pretend.

**Unchanged:**
- every existing page's marks, lines and wording;
- the delete page's marks and lines are the run page's own: kind run, running and action id, `run <link id>` with
  the wake note; SIMULATION and pretend on the pretend scenario.
- look.js needed no change.

**Tests:**
- runContract, RunPage, pageMarks, pretend, liveSource and simulation each gain s34 tests.
- Results:
  - switchboard folder 654;
  - full app suite 3941 (7 skipped);
  - scripts 77;
  - runner, tools and mcp index 254 (they import runContract.js);
  - the build compiles.

**Cold review (one round):**
- The must-fix is taken: keptTestLine fell back to the run's set when every recorded set was deleted, so a cleaned-up
  pre-check still read "kept". The run's set is now used only when the database has recorded none.
- Should-fixes taken:
  - keep_test_records needs a rehearsal sandbox org;
  - a keeping pre-check must list keep_test;
  - the kept line sits right after the phases (how the run ended), as 17.1 says.
- Noted, not changed:
  - rerunSteps and CHECK_STEPS.rehearsal still name delete_test. Whoever builds a keeping pre-check's correction
    steps swaps in keep_test; the correction page's check allows it.
  - A delete page's correction reads "doesn't belong on a correction page" rather than "queue a new delete page".
    The database refuses those edits (17.2).
  - lowerIds lower-cases test_data_of.request_id only from s36, so until then an id in capitals is refused.
- It confirmed:
  - no existing page's marks, lines or wording changed;
  - STEPS.type_count is untouched;
  - nothing promises that the typed count equals the kept sum;
  - the RunPage guard comes after every hook;
  - the mcp and runner imports are unchanged.

