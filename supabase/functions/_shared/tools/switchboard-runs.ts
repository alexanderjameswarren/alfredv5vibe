// ============================================================================
// supabase/functions/_shared/tools/switchboard-runs.ts
//
// Switchboard 3 run pages, from Claude's side (sb3_pages-h6v B3). Spec: docs/technical-spec-sb3_pages-h6v.md 4.1,
// 4.3, 10a-10c. Each tool runs the page's own rules first (src/switchboard/runs/runContract.js, the one copy), then
// the 250/251 database function, whose refusal text comes back unchanged.
//
//   queue_switchboard_run_request   tier 2  queue a run request (no link, nothing runs; moves a pre-check's sample)
//   correct_switchboard_run_request tier 2  correct a request: new version, its checks and live links voided
//   issue_switchboard_run_link      tier 2  issue a request's (or its code review's) page link
//   record_switchboard_code_review  tier 2  record Claude's code review at one commit; older ones superseded
//
// Approval is only ever Alex's click on the page (switchboard-run-pages); none of these approves or runs anything.
// Database access ONLY through ctx.db.
// ============================================================================

import { defineTool } from "../platform.ts";
import { dbError, fail } from "./claude-notifications.ts";
import { EDIT_RERUNS, codeReviewProblems, requestProblems } from "../../../../src/switchboard/runs/runContract.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The database refusing (250/251): signed out, not found, refused by a link rule, a check or a bad value.
const REFUSALS = new Set(["28000", "P0002", "55000", "23514", "22023", "22P02"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function requireUuid(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v.trim())) throw fail(tool, `\`${name}\` must be a UUID.`);
  return v.trim().toLowerCase();
}

/** The page's rules said no: every problem, each a sentence saying what to add or fix. Nothing reached the database. */
function refuseProblems(tool: string, problems: string[]): never {
  throw fail(tool, `refused before the database (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.join(" ")}`);
}

/** The database function, its refusal passed through word for word. */
async function call(tool: string, what: string, db: any, fn: string, params: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, params);
  if (error) {
    if (REFUSALS.has(error.code ?? "")) throw fail(tool, `refused: ${error.message}`);
    throw dbError(tool, what, error);
  }
  return data;
}

export const queueSwitchboardRunRequestTool = defineTool({
  name: "queue_switchboard_run_request",
  // Tier 2, not 1: with pre_check_request_id it also updates an existing row (the pre-check's sample moves).
  tier: 2,
  tables: {
    reads: ["switchboard_run_requests", "switchboard_run_links", "switchboard_run_samples"],
    writes: ["switchboard_run_requests", "switchboard_run_samples"],
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_run_request";
    const r = args.request;
    if (!isObject(r)) throw fail(tool, "`request` must be the run request object (spec 4.1).");
    // The chat never supplies evidence or a sample: the pre-check's result does, in the database.
    if ("evidence" in r) throw fail(tool, "leave evidence out: only a pre-check's result records passed checks; on a data operation name the pre-check with pre_check_request_id.");
    if ("sample" in r) throw fail(tool, "leave the sample out: the pre-check stores it, and it moves with the checks to the data operation.");
    if (r.page === "correction") throw fail(tool, "a correction is made with correct_switchboard_run_request on the request it corrects.");
    if (r.pre_check_request_id !== undefined) {
      if (r.page !== "dataop") throw fail(tool, "only a data operation names its pre-check (pre_check_request_id).");
      requireUuid(tool, "pre_check_request_id", r.pre_check_request_id);
      r.pre_check_request_id = (r.pre_check_request_id as string).trim().toLowerCase();
    }
    // s28 (O5): undo_of.request_id is lower-cased, as pre_check_request_id is; requestProblems then checks it is a
    // lower-case uuid, and the queue (257) that it names the caller's own data operation.
    if (isObject(r.undo_of) && typeof r.undo_of.request_id === "string") r.undo_of.request_id = r.undo_of.request_id.trim().toLowerCase();
    // s28: pretend ({scenario}, with simulation) and the structured allows go on as sent; runContract checks their shape.
    const problems = requestProblems(r) as string[];
    if (problems.length) refuseProblems(tool, problems);
    return await call(tool, "queueing the request", ctx.db, "switchboard_queue_run_request", { p_request: r });
  },
});

export const correctSwitchboardRunRequestTool = defineTool({
  name: "correct_switchboard_run_request",
  tier: 2,
  tables: {
    reads: ["switchboard_run_requests", "switchboard_run_links", "switchboard_code_reviews"],
    writes: ["switchboard_run_requests", "switchboard_run_links", "switchboard_code_reviews"],
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "correct_switchboard_run_request";
    const requestId = requireUuid(tool, "request_id", args.request_id);
    const kind = args.edit_kind;
    if (typeof kind !== "string" || !Object.hasOwn(EDIT_RERUNS, kind)) {
      throw fail(tool, `\`edit_kind\` must be one of ${Object.keys(EDIT_RERUNS).join(", ")}.`);
    }
    if (EDIT_RERUNS[kind as keyof typeof EDIT_RERUNS] === "new_request") {
      throw fail(tool, `a change to the ${kind} needs a new request through diagnosis, not a correction. No link was issued.`);
    }
    const r = args.request;
    const changed = args.changed;
    if (!isObject(r)) throw fail(tool, "`request` must be the whole corrected request (spec 4.1).");
    if (!isObject(changed)) throw fail(tool, "`changed` must be {reason, items: [{what, old, new}]}.");
    if ("evidence" in r || "sample" in r) throw fail(tool, "a correction carries no evidence or sample.");
    if (typeof r.pre_check_request_id === "string") r.pre_check_request_id = r.pre_check_request_id.trim().toLowerCase();
    // The page's rules on the request as it will be: its base page's rules (counts, undo, deadlines) for everything
    // but the steps; and for a kind that reruns a check, the correction page's rule that its steps are only what the
    // edit reruns. A wording or allowance edit keeps the request's own steps, checked on its base page.
    const { data: row, error: readError } = await ctx.db.from("switchboard_run_requests").select("page, base_page")
      .eq("id", requestId).maybeSingle();
    if (readError) throw dbError(tool, "reading the request", readError);
    if (!row) throw fail(tool, `refused: no such request: ${requestId}.`);
    const basePage = (row as Record<string, unknown>).base_page;
    const reruns = EDIT_RERUNS[kind as keyof typeof EDIT_RERUNS] as string[];
    const withChange = { ...r, changed: { ...changed, edit_kind: kind } };
    const isStep = (p: string) => /^(Fix steps|Add steps)/.test(p);
    const asBase = requestProblems({ ...withChange, page: basePage }) as string[];
    const problems = reruns.length
      ? [...asBase.filter((p) => !isStep(p)), ...(requestProblems({ ...withChange, page: "correction" }) as string[]).filter(isStep)]
      : asBase;
    if (problems.length) refuseProblems(tool, problems);
    return await call(tool, "correcting the request", ctx.db, "switchboard_correct_run_request",
      { p_request_id: requestId, p_edit_kind: kind, p_request: r, p_changed: changed });
  },
});

export const issueSwitchboardRunLinkTool = defineTool({
  name: "issue_switchboard_run_link",
  tier: 2,
  tables: {
    reads: ["switchboard_run_requests", "switchboard_run_links", "switchboard_code_reviews", "switchboard_settings"],
    writes: ["switchboard_run_links"],
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "issue_switchboard_run_link";
    const requestId = requireUuid(tool, "request_id", args.request_id);
    const reviewId = args.review_id === undefined || args.review_id === null ? null : requireUuid(tool, "review_id", args.review_id);
    return await call(tool, "issuing the link", ctx.db, "switchboard_issue_run_link", { p_request_id: requestId, p_review_id: reviewId });
  },
});

export const recordSwitchboardCodeReviewTool = defineTool({
  name: "record_switchboard_code_review",
  tier: 2,
  tables: { reads: ["switchboard_run_requests"], writes: ["switchboard_code_reviews"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "record_switchboard_code_review";
    const requestId = requireUuid(tool, "request_id", args.request_id);
    const review = args.review;
    if (!isObject(review)) throw fail(tool, "`review` must be the code review object (spec 4.3).");
    // Alex's side (status, acknowledgements, answers) is the page's, never Claude's.
    for (const k of ["status", "acknowledged", "acks", "answers", "superseded_by"]) {
      if (k in review) throw fail(tool, `leave ${k} out: only Alex's answer on the review page sets it.`);
    }
    const problems = codeReviewProblems(review) as string[];
    if (problems.length) refuseProblems(tool, problems);
    return await call(tool, "recording the review", ctx.db, "switchboard_record_code_review", { p_request_id: requestId, p_review: review });
  },
});
