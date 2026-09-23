---
name: "job-search"
description: "Track Alex's job and consulting applications in Alfred's job_applications table. Load this whenever he says he applied somewhere, pastes a job posting (applied or not), asks whether he has already dealt with an org, says he is weighing or passing on a role, hears back from an org (screen, interview, rejection, offer), asks what he owes or what is overdue, asks where an application stands, or asks which sources are working. Covers logging, updating, follow-ups, and the per-source response report."
---

# Job search tracker

Four Alfred tools, one table. Each row is one role Alex engaged with — applied to, still weighing, or passed on — and its status tracks it to an outcome. The table's main job is org lookup: before Alex spends time on a posting, he wants to know whether he has already dealt with that org and how it went.

| tool | use it to |
|---|---|
| `get_job_applications` | find rows: by `org` (partial match), `status`, `source`, `fit`, `open_only`, `overdue` |
| `create_job_application` | log a new application. No confirmation step. |
| `update_job_application` | change anything on an existing row, by `id` |
| `get_job_application_sources` | report applications and response rate per source |

⚠️ **ENUM VALUES ARE LOWERCASE.** The tool rejects "Medium" before it can normalise it. Always send:
- `fit`: `high` / `medium` / `low`
- `effort`: `full` (custom cover letter and tailored resume) / `quick`
- `status`: `applied` / `screening` / `interview` / `rejected` / `offer` / `closed_no_response` / `withdrawn` / `considering` / `passed`
  - `considering` = seen, not yet decided (still open). `passed` = seen, chose not to apply (closed).
  - Neither counts as an application: both are left out of the per-source report.
- `effort` is required for every status **except** `considering` and `passed`. Leave it out for those.

---

## Logging an application

**Required:** `org`, `role`, `source`, `fit`, and `effort` (unless status is `considering` or `passed`). Everything else is optional.

Log roles he passed on or is still weighing too, not just applications. They are what make the org lookup complete.

1. **Take what he gave you.** If he pasted a posting, pull the org, role title and deadline from it. Put comp, location or remote status, and any named contact in `notes`, as one short line.
2. **Ask only for what is missing, in one question.** Fit and effort usually are. Never guess them — they are his judgement, and the source report is only useful if they are real.
3. **Don't send `applied_on`** unless he says he applied on a different day. The tool fills in today's Las Vegas date.
4. **`next_action` stays empty when he is just waiting.** Empty means "nothing owed", not "unknown". Only fill it when he owes something, like a work sample, a follow-up email or scheduling a call, and set `next_action_due` if there is a date.
5. **Confirm in one line**, e.g. *"Logged: Salesforce Architect at Coefficient Giving, from NTEN, high fit, full effort. Deadline Oct 4."*
6. 🛑 **Report `same_org_rows` every time it is non-empty.** The create result lists earlier rows at what looks like the same org. Lead the confirmation with it, e.g. *"Already engaged: Craftsman Technology Group — Enterprise Portfolio Manager, rejected Aug 26 (Nevada not in hiring regions)."* Pull the key reason from that row's notes if it matters for the new posting. This flag is the main reason the tracker exists.

### Before he applies

When he shares a posting and hasn't applied yet, run `get_job_applications` with `org` first and tell him what is already there. Earlier outcomes (a location screen, a rejection after interview) often decide whether the new one is worth his time.

### Mixed fit ratings

His notes sometimes say Med-High, Low-Med or similar. Round down to the lower value and keep the original rating in `notes`.

### 🛑 Source spelling decides whether the report works

The table stores source in lowercase, and the report groups on exact spelling. `80000 hours` and `80k hours` would be counted as two different sources. **Reuse an existing spelling:**

`nten` · `idealist` · `linkedin` · `80000 hours` · `probably good` · `upwork` · `warm intro` · `company site`

`company site` means he found the posting on the org's own careers page, not via a job board.

A genuinely new source is fine. Before inventing one, check whether it is one of these under another name. When it is new, say so in the confirmation line so he can correct it.

⚠️ **A warm intro is the source even if the role was also posted somewhere.** Record where the application actually came from. Name the person in `notes`.

### If the create is refused as a duplicate

The same org and role are already logged, and the error gives the existing row's id and status. **Nothing was written.** He probably means an update, so ask, or just do the update if what he said makes that obvious. If it really is a second role at the same org, make the role text different, e.g. add the team or level.

---

## Updating

1. **Find the row first** with `get_job_applications` and `org`. If more than one row comes back, ask which one.
2. **Status changes follow what happened:**
   - recruiter or phone screen booked → `screening`
   - past the screen → `interview`
   - they said no → `rejected`
   - he pulled out after applying → `withdrawn`, and record why in the note
   - he decided not to apply to something marked `considering` → `passed`
   - he applies to something marked `considering` → `applied`, and send `effort` in the same call. Without it the tool refuses and writes nothing, so ask him full or quick first if he hasn't said
   - offer → `offer`
3. **Add context with `append_note`, never `notes`.** `append_note` adds a dated line to what is already there. Sending `notes` replaces everything, including the comp and contact details from when he applied. Only use `notes` when he explicitly asks to rewrite them.
4. **Clear a done task with `next_action: ""`.** That also clears its due date. Don't send a new due date in the same call, or the tool refuses.
5. **Confirm in one line** what changed.

⚠️ **`deadline` is the employer's application deadline, not his follow-up date.** A follow-up date always goes in `next_action_due`.

---

## "What do I owe?" and check-ins

- **What's owed:** `get_job_applications` with `open_only: true`. List the rows that have a `next_action`, soonest due first. `open_only` hides rejected, closed_no_response, withdrawn and passed; it keeps `considering`.
- **Still weighing:** `status: "considering"`. When he asks what he hasn't decided on, list these with their deadlines, soonest first.
- **Overdue:** `overdue: true`. It returns only dates already past; something due today is due, not overdue.
- **Going quiet:** when he asks for a review, list open rows still at `applied` that he applied to 30 or more days ago. **Ask** whether to mark each one `closed_no_response`. Never close them on your own. A late reply does happen, and a wrongly closed row understates that source's response rate.

---

## Which sources are working

Call `get_job_application_sources`, with `since` if he asks about a period.

- A **response** means status `screening`, `interview`, `rejected` or `offer`. A rejection counts, because it means someone read the application.
- The report counts applications only. `not_applied_excluded` says how many `considering` and `passed` rows were left out; there's no need to mention it unless he asks.
- 🛑 **Always give the response rate together with the count.** "Idealist 2 of 3" is honest; "Idealist 67%" suggests more than three applications can support. Below about 10 applications per source, say plainly that it is too early to rank sources.
- Where it is useful, also mention how many reached interview. A source that gets replies but no interviews tells him something different.
- If he wants to know whether effort pays off, cross it with `get_job_applications` filtered by source, and compare `full` against `quick` responses. Say so if the numbers are too small.

---

## Tone

Short and plain. One line per write, reporting what the tool returned, not what was requested. No pep talk about the job search unless he asks for one.
