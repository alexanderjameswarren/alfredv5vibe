// The plan page (spec section 9, item 3): one version's lanes and slices, and its copy text.

import { RECORD_LINK_BASE } from "../shared/copyRecord";
import { overwatchPlanPath } from "../viewPaths";
import { STATUS_WORDS, sliceTitle } from "./portfolioModel";

export const AUTHOR_WORDS = { alex: "Alex", overwatch: "Overwatch" };

/** Lanes in order, each with its slices in order, each slice with its group's name and project code. */
export function planLanes({ lanes, slices, groups }) {
  return [...lanes].sort((a, b) => a.position - b.position).map((lane) => ({
    ...lane,
    slices: slices.filter((s) => s.lane_id === lane.id).sort((a, b) => a.position - b.position).map((s) => ({
      ...s,
      lane: lane.name,
      name: groups[s.group_id]?.name || "Unnamed project",
      project_code: groups[s.group_id]?.project_code || null,
    })),
  }));
}

/** True once review_by is before today (both YYYY-MM-DD). */
export function reviewPassed(reviewBy, today) {
  return !!reviewBy && reviewBy < today;
}

function sliceLine(s, i) {
  const status = `${STATUS_WORDS[s.status]}${s.status === "paused" && s.paused_reason ? ` (${s.paused_reason})` : ""}`;
  return `  ${i + 1}. ${sliceTitle(s)}: ${status}${s.why ? ` — ${s.why}` : ""} (group_id: ${s.group_id})`;
}

/** "Overwatch: <portfolio> plan", the theory, the slices, "Let's review this plan." */
export function planCopy(portfolio, plan, lanes) {
  return {
    what: `${portfolio.name} plan`,
    facts: [
      `Theory:\n${plan.theory}`,
      plan.notes_for_next_review && `Notes for next review: ${plan.notes_for_next_review}`,
      plan.review_by && `Review by: ${plan.review_by}`,
      `Reason for this version: ${plan.reason}`,
      `Written by ${AUTHOR_WORDS[plan.written_by] || plan.written_by}, ${String(plan.created_at).slice(0, 10)}${plan.active ? "" : " (an older version)"}`,
      ...lanes.flatMap((l) => [`Lane ${l.name}:`, ...(l.slices.length ? l.slices.map(sliceLine) : ["  no slices"])]),
    ],
    ids: { portfolio_id: portfolio.id, plan_id: plan.id },
    link: `${RECORD_LINK_BASE}${overwatchPlanPath(portfolio.id, plan.active ? null : plan.id).slice(1)}`,
    question: "Let's review this plan.",
  };
}
