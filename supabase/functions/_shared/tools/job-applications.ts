// Job search — the four tools over public.job_applications.
//
//   get_job_applications        — tier 1. The pipeline read.
//   create_job_application      — tier 1. Log one application.
//   update_job_application      — tier 2. Move it along.
//   get_job_application_sources — tier 1. Which source actually converts.
//
// One row per application, from applied through to outcome. There is no
// history table: `status` IS the pipeline, which is why the table is audited —
// a wrong status silently changes the per-source response rate that
// get_job_application_sources reports.
//
// ⚠️ DATES HERE ARE PACIFIC DATES, NOT UTC ONES. Alex applies in the evening;
// after 17:00 PDT the server's UTC date is already tomorrow. Every "today" in
// this file — the applied_on default, the `overdue` cutoff, the append_note
// stamp — comes from `today()` below and never from the database's
// CURRENT_DATE or from `new Date().toISOString()`.

import { clampLimit, defineTool, envelope } from "../platform.ts";

// Every column except user_id. RLS already scopes every read and write to the
// owner, so the column carries no information the caller does not have, and
// echoing a uuid nobody can act on is noise in every response.
const APP_COLS =
  "id, applied_on, org, role, source, fit, effort, status, deadline, " +
  "next_action, next_action_due, notes, created_at";

// Mirrors job_applications_status_check / _fit_check / _effort_check.
// Duplicated on purpose: a CHECK violation surfaces as an unreadable
// constraint name, and these are the values the caller has to choose from
// BEFORE it writes.
export const VALID_JOB_STATUS = [
  "applied",
  "screening",
  "interview",
  "rejected",
  "offer",
  "closed_no_response",
  "withdrawn",
  "considering",
  "passed",
];
export const VALID_JOB_FIT = ["high", "medium", "low"];
export const VALID_JOB_EFFORT = ["full", "quick"];

// `considering` and `passed` are roles Alex SAW but never applied to. Counting
// them would put every job he looked at into a source's denominator and make
// its response rate a measure of how much that source posts, not of how well it
// converts. They are therefore dropped from every count in the source report.
const NOT_APPLIED_STATUS = ["considering", "passed"];

// `open_only` — still live, nothing has closed the loop. The complement of the
// four terminal statuses (rejected, closed_no_response, withdrawn, passed),
// written out positively so it goes into the query as an IN rather than a NOT
// IN. `considering` is OPEN: undecided is still live.
const OPEN_STATUS = [
  "applied",
  "screening",
  "interview",
  "offer",
  "considering",
];

// Per the status column comment: "A source counts as generating a RESPONSE
// when status is screening, interview, rejected or offer — a rejection is
// still a response." That sentence is the contract for the report below.
const RESPONDED_STATUS = ["screening", "interview", "rejected", "offer"];
const REACHED_INTERVIEW_STATUS = ["interview", "offer"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The vocabulary sentence all four of these tools repeat. Exported so
 * mcp/index.ts appends the SAME text to each description instead of four
 * paraphrases that drift apart the first time a status is added.
 */
export const JOB_VOCAB =
  "VOCABULARY — status: applied (submitted, nothing heard) | screening " +
  "(recruiter or phone screen) | interview (past screening) | rejected (they " +
  "said no) | offer (offer in hand) | closed_no_response (gave up waiting) | " +
  "withdrawn (Alex pulled out) | considering (seen the role, not yet decided " +
  "whether to apply — still open) | passed (seen the role, chose not to " +
  "apply — terminal). considering and passed are roles never applied to, so " +
  "rows with either status are EXCLUDED FROM EVERY PER-SOURCE COUNT in " +
  "get_job_application_sources — they are not in total, responded, " +
  "response_rate, reached_interview, offers or waiting. `effort` is required " +
  "for every other status and is optional (and normally omitted) for " +
  "considering and passed, because no work was done. fit: high | medium | " +
  "low. effort: full | quick. SOURCE is free text but is STORED LOWERCASE " +
  "and trimmed — reuse an " +
  "existing spelling (nten, idealist, linkedin, 80000 hours, probably good, " +
  "upwork, warm intro) before inventing one, or the per-source counts split " +
  "in two and the response-rate report stops meaning anything. Call " +
  "get_job_application_sources to see the spellings already in use.";

// --- Pacific dates ----------------------------------------------------------

const PT_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" — today in America/Los_Angeles, never UTC. */
export function today(): string {
  return PT_DATE.format(new Date());
}

// --- Shared validation ------------------------------------------------------

function fail(tool: string, message: string): Error {
  return new Error(`${tool}: ${message}`);
}

/**
 * A database error, worded by kind — the same split as sam-plans.ts. A
 * constraint or RAISE failure is the database REFUSING the request and is a
 * validation error; anything else is operational and legitimately retryable,
 * so it never carries do-not-retry wording.
 */
function dbError(
  tool: string,
  what: string,
  error: { code?: string; message?: string },
): Error {
  const code = error.code ?? "";
  const message = error.message ?? "(no message)";
  if (code === "P0001" || code.startsWith("22") || code.startsWith("23")) {
    return fail(tool, `validation error: ${message}`);
  }
  return fail(tool, `${what} failed: ${message}${code ? ` [${code}]` : ""}`);
}

/** Required, non-empty, trimmed. For org and role, which keep their casing. */
function requireText(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw fail(tool, `\`${name}\` is required and must be non-empty text.`);
  }
  return v.trim();
}

/**
 * Lowercase + trim, then check against the allowed list. The lowercasing is
 * not cosmetic: job_applications_source_canonical REJECTS any source that is
 * not already `lower(btrim(source))`, so "LinkedIn" is a hard constraint
 * failure rather than a row that merely sorts oddly.
 */
function normaliseEnum(
  tool: string,
  name: string,
  v: unknown,
  allowed: string[],
): string {
  if (typeof v !== "string") {
    throw fail(tool, `\`${name}\` must be text, got ${JSON.stringify(v)}.`);
  }
  const out = v.trim().toLowerCase();
  if (!allowed.includes(out)) {
    throw fail(
      tool,
      `\`${name}\` must be one of ${allowed.join(" | ")}, got ${
        JSON.stringify(v)
      }.`,
    );
  }
  return out;
}

/** Lowercase + trim, no allowed list — source is an open vocabulary. */
function normaliseSource(tool: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw fail(
      tool,
      "`source` is required and must be non-empty text. It is stored " +
        "lowercase; reuse an existing spelling before inventing one.",
    );
  }
  return v.trim().toLowerCase();
}

function requireDate(tool: string, name: string, v: unknown): string {
  if (
    typeof v !== "string" || !DATE_RE.test(v) ||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v
  ) {
    throw fail(
      tool,
      `\`${name}\` must be a Pacific date "YYYY-MM-DD", got ${
        JSON.stringify(v)
      }.`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// get_job_applications — tier 1
// ---------------------------------------------------------------------------

export const getJobApplicationsTool = defineTool({
  name: "get_job_applications",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_job_applications";
    const LIMIT = clampLimit(args.limit as number | undefined);

    let q = ctx.db.from("job_applications").select(APP_COLS);

    // ⚠️ EVERY FILTER GOES INTO THE QUERY, ABOVE THE LIMIT. Filtering the
    // returned page in the handler would read 20 rows and then hand back the 3
    // of them that matched — an answer that reads as "you have 3 overdue" and
    // is really "3 of your 20 most recent are overdue".
    if (args.status !== undefined && args.status !== null) {
      const wanted = (Array.isArray(args.status)
        ? args.status as unknown[]
        : [args.status]).map((s) => normaliseEnum(T, "status", s, VALID_JOB_STATUS));
      q = q.in("status", wanted);
    }

    if (args.source !== undefined && args.source !== null) {
      // Lowercased first: the column is canonically lowercase, so an eq on
      // "LinkedIn" matches nothing and reads as "no applications from
      // LinkedIn" rather than as a spelling mistake.
      q = q.eq("source", normaliseSource(T, args.source));
    }

    if (args.org !== undefined && args.org !== null) {
      const org = requireText(T, "org", args.org);
      q = q.ilike("org", `%${org}%`);
    }

    if (args.fit !== undefined && args.fit !== null) {
      q = q.eq("fit", normaliseEnum(T, "fit", args.fit, VALID_JOB_FIT));
    }

    if (args.open_only === true) {
      // The complement of rejected / closed_no_response / withdrawn / passed,
      // stated as an IN over the five live statuses. `considering` is one of
      // them: a role Alex has not decided about is still an open loop, whereas
      // `passed` is the decision not to apply and is therefore terminal.
      // Combines with an explicit `status`
      // filter by INTERSECTION — open_only together with status 'rejected'
      // correctly returns nothing, rather than one of the two being dropped.
      q = q.in("status", OPEN_STATUS);
    }

    if (args.overdue === true) {
      // Strictly before today: something due TODAY is due, not overdue. A NULL
      // next_action_due fails this comparison and drops out, which is right —
      // no action owed, nothing to be late for.
      q = q.lt("next_action_due", today());
    }

    const { data, error } = await q
      .order("applied_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw dbError(T, "read", error);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return envelope(rows, {
      limit_applied: LIMIT,
      truncated: rows.length >= LIMIT,
    });
  },
});

// ---------------------------------------------------------------------------
// create_job_application — tier 1
// ---------------------------------------------------------------------------
//
// TIER 1, UNGATED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. Alex logs
// roughly three applications a day. A tier-3 gate would turn each one into two
// round trips to record a fact he just stated, and a capture step people
// confirm three times a day is a capture step they stop using. The blast
// radius is one new row in an audited table; the realistic mistake — logging
// the same job twice — is caught by the duplicate guard below, which is the
// thing a confirmation prompt would actually have been catching.

export const createJobApplicationTool = defineTool({
  name: "create_job_application",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_job_application";

    const org = requireText(T, "org", args.org);
    const role = requireText(T, "role", args.role);
    const source = normaliseSource(T, args.source);
    const fit = normaliseEnum(T, "fit", args.fit, VALID_JOB_FIT);

    // Resolved BEFORE effort, because whether effort is required depends on it.
    const status = args.status === undefined || args.status === null
      ? "applied"
      : normaliseEnum(T, "status", args.status, VALID_JOB_STATUS);

    // -----------------------------------------------------------------------
    // effort IS CONDITIONALLY REQUIRED, AND THE CHECK IS HERE, NOT LEFT TO THE
    // DATABASE
    // -----------------------------------------------------------------------
    // job_applications_effort_when_applied allows a NULL effort only for
    // `considering` and `passed` — the two statuses where no application was
    // written, so there is no amount of work to record. Its violation arrives
    // as a constraint name, which tells the caller nothing about which of the
    // two fields to change; this states the rule instead.
    const effort = args.effort === undefined || args.effort === null
      ? null
      : normaliseEnum(T, "effort", args.effort, VALID_JOB_EFFORT);
    if (effort === null && !NOT_APPLIED_STATUS.includes(status)) {
      throw fail(
        T,
        `\`effort\` is required unless status is ${
          NOT_APPLIED_STATUS.join(" or ")
        }, and status here is "${status}". Nothing was written. Pass effort: ` +
          `full (tailored CV and cover letter) or quick (light-touch ` +
          `submission) — or, if Alex has not actually applied to this one, ` +
          `pass status: considering (not yet decided) or passed (decided ` +
          `against) and leave effort out.`,
      );
    }

    // ⚠️ ALWAYS SENT EXPLICITLY, NEVER LEFT TO THE COLUMN DEFAULT. That default
    // is CURRENT_DATE, which is the SERVER'S UTC date: an application logged at
    // 19:00 Pacific would be stamped tomorrow. Not a cosmetic error —
    // applied_on is the sort key of every read here and the `since` filter of
    // the source report.
    const appliedOn = args.applied_on === undefined || args.applied_on === null
      ? today()
      : requireDate(T, "applied_on", args.applied_on);

    const deadline = args.deadline === undefined || args.deadline === null
      ? null
      : requireDate(T, "deadline", args.deadline);
    const nextAction =
      args.next_action === undefined || args.next_action === null
        ? null
        : requireText(T, "next_action", args.next_action);
    const nextActionDue =
      args.next_action_due === undefined || args.next_action_due === null
        ? null
        : requireDate(T, "next_action_due", args.next_action_due);
    const notes = args.notes === undefined || args.notes === null
      ? null
      : requireText(T, "notes", args.notes);

    if (nextActionDue !== null && nextAction === null) {
      // Mirrors job_applications_due_needs_action as a sentence. The column
      // comment is explicit that next_action_due is only allowed alongside a
      // next_action; the constraint's own message names neither column
      // usefully.
      throw fail(
        T,
        "`next_action_due` was given with no `next_action`. A due date needs " +
          "something that is due — pass what Alex owes next, or drop the date.",
      );
    }

    // -----------------------------------------------------------------------
    // DUPLICATE GUARD — WRITES NOTHING WHEN IT FIRES
    // -----------------------------------------------------------------------
    // Logging the same job twice is the realistic failure at three a day, and
    // it is invisible afterwards: two rows for one application inflate that
    // source's `total` and halve its response rate forever, because only one
    // of them can ever reach `screening`.
    //
    // ⚠️ ilike NARROWS, THE HANDLER DECIDES. ilike gives the case-insensitive
    // match in the query, but its pattern metacharacters (% and _) would make
    // an org like "Acme_Corp" match "AcmeXCorp". So the candidate rows are
    // re-checked here on trimmed lowercase equality, which is the rule actually
    // being claimed.
    const { data: existing, error: dupErr } = await ctx.db
      .from("job_applications")
      .select("id, org, role, applied_on, status")
      .ilike("org", org)
      .ilike("role", role)
      .limit(10);
    if (dupErr) throw dbError(T, "duplicate check", dupErr);

    const key = (s: unknown) => String(s ?? "").trim().toLowerCase();
    const hit = ((existing ?? []) as Array<Record<string, unknown>>).find(
      (r) => key(r.org) === key(org) && key(r.role) === key(role),
    );
    if (hit) {
      // ⚠️ A VALIDATION ERROR, SO NO DO-NOT-RETRY WORDING. The caller SHOULD
      // act again — with update_job_application on the row named here, or with
      // a corrected org/role if this really is a different job. The terminal
      // guardrail phrasing is reserved for budget and loop denials, where
      // retrying genuinely cannot change the outcome.
      throw fail(
        T,
        `nothing was written — "${role}" at "${org}" is already logged ` +
          `(id ${hit.id}, applied_on ${hit.applied_on}, status ${hit.status}). ` +
          `Matching ignores case. To move that application along, call ` +
          `update_job_application with that id. If this really is a different ` +
          `job at the same org, make the role text distinguish them.`,
      );
    }

    const row: Record<string, unknown> = {
      applied_on: appliedOn,
      org,
      role,
      source,
      fit,
      effort,
      status,
      deadline,
      next_action: nextAction,
      next_action_due: nextActionDue,
      notes,
    };

    const { data, error } = await ctx.db
      .from("job_applications")
      .insert(row)
      .select(APP_COLS)
      .single();
    if (error) throw dbError(T, "insert", error);

    const inserted = data as Record<string, unknown>;

    // -----------------------------------------------------------------------
    // SAME-ORG FLAG — INFORMATION, NOT A REFUSAL
    // -----------------------------------------------------------------------
    // The duplicate guard above already refused an exact org + role repeat.
    // This is the softer neighbour: OTHER roles at what looks like the same
    // organisation. Alex wants to know he has history with them — two
    // applications to one org is context for the cover letter, and a rejection
    // there last month is worth knowing before he chases this one.
    //
    // ⚠️ CONTAINMENT IN BOTH DIRECTIONS, WHICH IS WHY THIS FILTERS IN THE
    // HANDLER. "Acme" must match "Acme Corporation" and "Acme Corporation"
    // must match "Acme"; a column filter can only express one of those, and
    // ilike's % and _ would additionally make "Acme_Corp" match "AcmeXCorp".
    // So the scan is bounded and the comparison is done here on trimmed
    // lowercase text, which is the rule actually being claimed.
    const SAME_ORG_SCAN = 2000;
    const SAME_ORG_LIMIT = clampLimit(undefined);
    let sameOrgRows: Array<Record<string, unknown>> = [];
    let sameOrgError: string | null = null;

    const { data: siblings, error: sibErr } = await ctx.db
      .from("job_applications")
      .select("id, org, role, status, applied_on, created_at")
      .neq("id", inserted.id as string)
      .order("applied_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(SAME_ORG_SCAN);

    if (sibErr) {
      // ⚠️ THE INSERT ALREADY SUCCEEDED, SO THIS IS NOT AN ERROR RESPONSE.
      // Throwing here would report a failed create for a row that exists, and
      // the retry it invites would come back as a duplicate refusal. The
      // failure is reported in the payload instead, next to the row it could
      // not annotate.
      sameOrgError = sibErr.message ?? "(no message)";
    } else {
      const orgKey = org.trim().toLowerCase();
      sameOrgRows = ((siblings ?? []) as Array<Record<string, unknown>>)
        .filter((r) => {
          const other = String(r.org ?? "").trim().toLowerCase();
          if (other === "" || orgKey === "") return false;
          return orgKey.includes(other) || other.includes(orgKey);
        })
        .slice(0, SAME_ORG_LIMIT)
        .map((r) => ({
          id: r.id,
          org: r.org,
          role: r.role,
          status: r.status,
          applied_on: r.applied_on,
        }));
    }

    return sameOrgError === null
      ? { ...inserted, same_org_rows: sameOrgRows }
      : {
        ...inserted,
        same_org_rows: sameOrgRows,
        same_org_rows_error:
          `the application WAS created; only the same-org lookup failed, so ` +
          `same_org_rows is empty rather than known-empty: ${sameOrgError}`,
      };
  },
});

// ---------------------------------------------------------------------------
// update_job_application — tier 2
// ---------------------------------------------------------------------------
//
// Tier 2: it changes an existing row and the audit trigger makes it reversible
// via platform.rollback_audit_entry. Not tier 3 — moving an application from
// `applied` to `screening` is the ordinary operation this table exists for,
// and gating it would put a confirmation in front of the single most routine
// write in the app.

export const updateJobApplicationTool = defineTool({
  name: "update_job_application",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_job_application";

    const id = args.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw fail(T, `\`id\` must be a UUID, got ${JSON.stringify(id)}.`);
    }

    if (args.notes !== undefined && args.append_note !== undefined) {
      throw fail(
        T,
        "pass `notes` OR `append_note`, not both. `notes` REPLACES the whole " +
          "field; `append_note` adds a dated line and never overwrites. " +
          "Sending both means one of them silently loses, and there is no " +
          "reading of the request that says which.",
      );
    }

    const { data: before, error: findErr } = await ctx.db
      .from("job_applications")
      .select(APP_COLS)
      .eq("id", id)
      .maybeSingle();
    if (findErr) throw dbError(T, "lookup", findErr);
    if (!before) {
      throw fail(
        T,
        `no application with id ${id}. Nothing was written. Use ` +
          `get_job_applications to find it — this tool will not create a row, ` +
          `because a typo'd id that quietly inserted a second application is ` +
          `exactly how a duplicate gets created instead of a status corrected.`,
      );
    }
    // Snapshotted, not aliased — append_note reads the PREVIOUS notes below and
    // must not be looking at an object the client could hand back changed.
    const prev = { ...(before as Record<string, unknown>) };

    const patch: Record<string, unknown> = {};

    // --- fields that cannot be cleared (NOT NULL columns) -------------------
    if (args.applied_on !== undefined) {
      patch.applied_on = requireDate(T, "applied_on", args.applied_on);
    }
    if (args.org !== undefined) patch.org = requireText(T, "org", args.org);
    if (args.role !== undefined) patch.role = requireText(T, "role", args.role);
    if (args.source !== undefined) {
      patch.source = normaliseSource(T, args.source);
    }
    if (args.fit !== undefined) {
      patch.fit = normaliseEnum(T, "fit", args.fit, VALID_JOB_FIT);
    }
    if (args.effort !== undefined) {
      patch.effort = normaliseEnum(T, "effort", args.effort, VALID_JOB_EFFORT);
    }
    if (args.status !== undefined) {
      patch.status = normaliseEnum(T, "status", args.status, VALID_JOB_STATUS);
    }

    // ⚠️ THE effort RULE IS THE DATABASE'S TO ENFORCE HERE, UNLIKE IN create.
    // job_applications_effort_when_applied requires an effort for every status
    // except `considering` and `passed`. create knows the whole row it is
    // writing and so can state the rule itself; this tool only knows a patch,
    // and the row it lands on may already carry an effort from an earlier
    // write. Re-deriving the rule from `prev` would put a second copy of the
    // constraint in the handler that drifts the moment the constraint changes.
    // So a `considering` row promoted to `applied` with no effort is refused by
    // the CHECK, and dbError passes the database's own message through verbatim
    // without do-not-retry wording — the caller should retry, with an effort.

    // --- clearable fields ---------------------------------------------------
    // ⚠️ ABSENT, EMPTY AND NULL ARE THREE DIFFERENT THINGS HERE. Absent means
    // "leave it alone"; "" and null both mean "clear it". Collapsing absent
    // into null with `??` would blank next_action on every status-only update,
    // which is how a follow-up Alex still owes disappears without a trace.
    const clearable = (name: string, v: unknown): null | string => {
      if (v === null) return null;
      if (typeof v !== "string") {
        throw fail(T, `\`${name}\` must be text, null, or "" to clear it.`);
      }
      const t = v.trim();
      return t === "" ? null : t;
    };

    if (args.deadline !== undefined) {
      const v = clearable("deadline", args.deadline);
      patch.deadline = v === null ? null : requireDate(T, "deadline", v);
    }
    if (args.notes !== undefined) {
      patch.notes = clearable("notes", args.notes);
    }

    let clearingAction = false;
    if (args.next_action !== undefined) {
      const v = clearable("next_action", args.next_action);
      patch.next_action = v;
      clearingAction = v === null;
    }
    if (args.next_action_due !== undefined) {
      const v = clearable("next_action_due", args.next_action_due);
      patch.next_action_due = v === null
        ? null
        : requireDate(T, "next_action_due", v);
    }

    // -----------------------------------------------------------------------
    // CLEARING next_action CLEARS ITS DUE DATE, IN THE SAME PATCH
    // -----------------------------------------------------------------------
    // job_applications_due_needs_action forbids a due date with no action. A
    // caller saying "nothing is owed any more" is not thinking about the date
    // field at all, and without this the UPDATE fails on a constraint whose
    // message names neither what was asked for nor what to do about it.
    if (clearingAction) {
      if (patch.next_action_due !== undefined && patch.next_action_due !== null) {
        // The one case that is a genuine contradiction rather than an omission:
        // clear the action AND set a due date, in one call. Forcing null here
        // would discard a date the caller explicitly asked for.
        throw fail(
          T,
          "`next_action` was cleared and `next_action_due` was set in the " +
            "same call. A due date needs something that is due. Clear both, " +
            "or pass the next_action this date belongs to.",
        );
      }
      patch.next_action_due = null;
    }

    // --- append_note --------------------------------------------------------
    // ⚠️ APPENDS, NEVER OVERWRITES — that is the entire reason it exists beside
    // `notes`. The date prefix is PACIFIC and is stamped here rather than
    // accepted from the caller: the note is being written now, and a
    // caller-supplied date could back-date a line in a running log.
    if (args.append_note !== undefined) {
      const line = requireText(T, "append_note", args.append_note);
      const stamped = `${today()}: ${line}`;
      const current = prev.notes as string | null;
      patch.notes = current && current.trim() !== ""
        ? `${current}\n${stamped}`
        : stamped;
    }

    if (Object.keys(patch).length === 0) {
      throw fail(
        T,
        "nothing to change. Pass at least one of applied_on, org, role, " +
          "source, fit, effort, status, deadline, next_action, " +
          "next_action_due, notes, or append_note.",
      );
    }

    // Validity is judged on the ROW THAT WOULD RESULT, not on the patch: a due
    // date and the action it belongs to can legitimately arrive in separate
    // calls, so the only question that means anything is what the row looks
    // like afterwards.
    const after = { ...prev, ...patch };
    if (after.next_action_due !== null && after.next_action === null) {
      throw fail(
        T,
        "this row would have a `next_action_due` and no `next_action`. A due " +
          "date needs something that is due — pass what Alex owes next, or " +
          'clear the due date by sending next_action_due: "".',
      );
    }

    const { data, error } = await ctx.db
      .from("job_applications")
      .update(patch)
      .eq("id", id)
      .select(APP_COLS)
      .single();
    if (error) throw dbError(T, "update", error);

    return data;
  },
});

// ---------------------------------------------------------------------------
// get_job_application_sources — tier 1
// ---------------------------------------------------------------------------

export const getJobApplicationSourcesTool = defineTool({
  name: "get_job_application_sources",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_job_application_sources";

    // ⚠️ NOT clampLimit, DELIBERATELY. The 50-row ceiling bounds a LIST a model
    // will read; this reads two narrow columns purely to count them, and
    // capping it at 50 would produce a response-rate report over the 50 most
    // recent applications while calling itself the source report. 2000 is an
    // explicit ceiling on an aggregate, and hitting it is reported, not hidden.
    const ROW_CAP = 2000;

    let q = ctx.db.from("job_applications").select("source, status");
    if (args.since !== undefined && args.since !== null) {
      q = q.gte("applied_on", requireDate(T, "since", args.since));
    }

    const { data, error } = await q
      .order("applied_on", { ascending: false })
      .limit(ROW_CAP);
    if (error) throw dbError(T, "read", error);

    const fetched = (data ?? []) as Array<{ source: string; status: string }>;

    // ⚠️ considering AND passed ARE DROPPED BEFORE ANY COUNTING, NOT AFTER.
    // These are roles Alex looked at and never applied to. Leaving them in
    // `total` would make every source's response rate a function of how many
    // postings he browsed there, and a source he skimmed forty jobs on and
    // applied to two would read as a 5% converter. They are excluded from
    // total, and therefore from responded, response_rate, reached_interview,
    // offers and waiting as well.
    const rows = fetched.filter((r) => !NOT_APPLIED_STATUS.includes(r.status));
    const notApplied = fetched.length - rows.length;

    // Aggregated HERE rather than in SQL: the counts are a handful of boolean
    // tests over at most 2000 two-column rows, and a view or RPC would put the
    // definition of "responded" in a second place that has to be kept in step
    // with the status column comment.
    const by = new Map<string, {
      source: string;
      total: number;
      responded: number;
      reached_interview: number;
      offers: number;
      waiting: number;
    }>();

    for (const r of rows) {
      let e = by.get(r.source);
      if (!e) {
        e = {
          source: r.source,
          total: 0,
          responded: 0,
          reached_interview: 0,
          offers: 0,
          waiting: 0,
        };
        by.set(r.source, e);
      }
      e.total += 1;
      if (RESPONDED_STATUS.includes(r.status)) e.responded += 1;
      if (REACHED_INTERVIEW_STATUS.includes(r.status)) e.reached_interview += 1;
      if (r.status === "offer") e.offers += 1;
      if (r.status === "applied") e.waiting += 1;
    }

    const sources = [...by.values()]
      .map((e) => ({
        source: e.source,
        total: e.total,
        responded: e.responded,
        // Two decimal places: 0.33, not 0.3333333333333333. A rate over a
        // handful of applications is not precise to sixteen digits and must
        // not look as though it is.
        response_rate: Math.round((e.responded / e.total) * 100) / 100,
        reached_interview: e.reached_interview,
        offers: e.offers,
        waiting: e.waiting,
      }))
      // Total descending; ties broken by name so the order is stable between
      // calls rather than whatever the row order happened to produce.
      .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));

    return envelope({
      since: (args.since as string | undefined) ?? null,
      applications_counted: rows.length,
      not_applied_excluded: notApplied,
      sources,
      reading:
        "One entry per source, counting APPLICATIONS ONLY. Rows with status " +
        "considering or passed are roles Alex never applied to and are " +
        "excluded from every count here, including `total`; " +
        "`not_applied_excluded` says how many were left out. `responded` " +
        "counts screening, interview, " +
        "rejected and offer — a rejection IS a response, per the status " +
        "column comment, because it means the application was read. `waiting` " +
        "is status 'applied' only; closed_no_response and withdrawn are in " +
        "`total` but in none of the other counts, so responded + waiting need " +
        "not equal total. `response_rate` is responded / total to 2dp and " +
        "means little at a small `total` — read it next to the count, never " +
        "on its own.",
    }, {
      limit_applied: ROW_CAP,
      // ⚠️ SURFACED, BECAUSE A CLIPPED AGGREGATE LOOKS EXACTLY LIKE A COMPLETE
      // ONE. Every other truncation in this file returns fewer rows, which is
      // visible; here the clip changes the NUMBERS while the shape stays whole,
      // and nothing in the payload itself would give it away.
      // `fetched`, not `rows`: the cap applies to what the query read, before
      // considering/passed were dropped. Testing the filtered count would hide
      // a clip on a 2000-row read that happened to contain excluded rows.
      truncated: fetched.length >= ROW_CAP,
    });
  },
});
