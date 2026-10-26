// What a Project card shows, worked out from the live reads (spec section 9, item 3).
// Every threshold comes from the plan's settings; a missing setting turns its flag off.

import { daysBefore } from "../money/moneyFormat";

const DAY_MS = 24 * 3600 * 1000;

/** Whole days from a timestamp or YYYY-MM-DD to `today` (YYYY-MM-DD, Pacific). */
export function daysSince(value, today) {
  if (!value) return null;
  const day = String(value).slice(0, 10);
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
}

/** "Oct 31" from YYYY-MM-DD. */
export function shortDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || "");
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The pace projection: today + remaining × days since the first report ÷ steps used. */
export function estimatedFinish({ effort_estimate: estimate, steps_used: used, first_report_at: first }, today) {
  if (!estimate || !used || !first) return { label: "unknown", day: null };
  if (used >= estimate) return { label: "over estimate", day: null };
  const elapsed = Math.max(1, daysSince(first, today));
  const days = Math.ceil(((estimate - used) * elapsed) / used);
  const day = daysBefore(today, -days);
  return { label: shortDay(day), day };
}

const WAIT_WORDS = { alex: "You", decision: "A decision" };

export function waitingOn(p, groupNames = {}) {
  if (!p.waiting_on_kind && !p.waiting_on) return null;
  if (p.waiting_on_kind === "project") {
    return { text: p.waiting_on || "", groupId: p.waiting_on_group_id, groupName: groupNames[p.waiting_on_group_id] || "another project" };
  }
  const who = p.waiting_on_kind === "hurdle" ? `A ${p.hurdle_kind || ""} hurdle`.replace("  ", " ") : WAIT_WORDS[p.waiting_on_kind];
  return { text: [who, p.waiting_on].filter(Boolean).join(": ") };
}

/** One card's facts. */
export function projectView(p, { estimates = [], memberGroupIds = [], settings = {}, groupNames = {}, today }) {
  const history = estimates.filter((e) => e.group_id === p.group_id);
  const initial = history.find((e) => e.kind === "initial");
  const original = initial?.estimate ?? null;
  const scopeChanges = history.filter((e) => e.kind === "scope_increase" || e.kind === "scope_decrease");
  const sinceReport = daysSince(p.last_report_at, today);
  const stalled = settings.stall_days != null && p.waiting_on_kind !== "project" && p.has_plan
    && (sinceReport === null || sinceReport > settings.stall_days);
  const overSteps = settings.overrun_factor != null && p.effort_estimate
    && p.steps_used > p.effort_estimate * settings.overrun_factor;
  const pastTarget = !!p.target_date && p.target_date < today;
  return {
    ...p,
    original: original !== null && original !== p.effort_estimate ? original : null,
    scopeChanges,
    finish: estimatedFinish(p, today),
    waiting: waitingOn(p, groupNames),
    stalledDays: stalled ? sinceReport : null,
    overrun: overSteps ? "steps" : pastTarget ? "target" : null,
    empty: !memberGroupIds.includes(p.group_id),
  };
}
