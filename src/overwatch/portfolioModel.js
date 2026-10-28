// The portfolio plan on the Projects section (spec section 9, item 3): Now, Next, Later and "Not in the plan",
// worked out from getPortfolioPlans. Lanes in position order; slices in position order within a lane.

import { groupLink } from "./overwatchCopy";

const byPosition = (a, b) => a.position - b.position;

export const STATUS_WORDS = { planned: "Planned", in_progress: "In progress", done: "Done", paused: "Paused" };

/** "Alpha (Phase 2)". */
export function sliceTitle(s) {
  return `${s.name}${s.phases ? ` (${s.phases})` : ""}`;
}

/** The portfolio to show: the remembered one if it still exists, else the first. */
export function pickPortfolio(portfolios, rememberedId) {
  return portfolios.find((p) => p.id === rememberedId) || portfolios[0] || null;
}

export function portfolioView(portfolio, data) {
  const plan = data.plans.find((p) => p.portfolio_id === portfolio.id) || null;
  if (!plan) return { portfolio, plan: null, now: [], next: [], later: [], notInPlan: [] };
  const progress = new Map(data.progress.map((p) => [p.group_id, p]));
  const lanes = data.lanes.filter((l) => l.plan_id === plan.id).sort(byPosition);
  const slicesOf = (lane) => data.slices.filter((s) => s.lane_id === lane.id).sort(byPosition).map((s) => ({
    ...s,
    lane: lane.name,
    name: progress.get(s.group_id)?.name || data.groupNames[s.group_id] || "Unnamed project",
    progress: progress.get(s.group_id) || null,
  }));
  const perLane = lanes.map((lane) => {
    const all = slicesOf(lane);
    const current = all.find((s) => s.status === "in_progress") || null;
    const upNext = all.find((s) => s.status === "planned") || null;
    return {
      lane,
      current,
      upNext,
      rest: all.filter((s) => s !== current && s !== upNext && s.status !== "done"),
      done: all.filter((s) => s.status === "done").length,
    };
  });
  const named = new Set(data.slices.filter((s) => s.plan_id === plan.id).map((s) => s.group_id));
  const contexts = portfolio.context_ids || [];
  return {
    portfolio,
    plan,
    now: perLane.map(({ lane, current }) => ({ lane, slice: current })),
    next: perLane.filter((l) => l.upNext).map(({ lane, upNext }) => ({ lane, slice: upNext })),
    later: perLane.filter((l) => l.rest.length || l.done).map(({ lane, rest, done }) => ({ lane, slices: rest, done })),
    notInPlan: data.progress.filter((p) => contexts.includes(p.context_id) && !named.has(p.group_id)),
  };
}

function statusText(s) {
  return `${STATUS_WORDS[s.status] || s.status}${s.status === "paused" && s.paused_reason ? ` (${s.paused_reason})` : ""}`;
}

/** One slice, paste-ready. */
export function sliceCopy(s, portfolioName) {
  return {
    what: "slice",
    name: `${sliceTitle(s)} of the ${portfolioName} plan`,
    facts: [
      `Lane: ${s.lane}`,
      `Status: ${statusText(s)}`,
      s.why && `Why here: ${s.why}`,
      s.progress?.project_code && `Project code: ${s.progress.project_code}`,
    ],
    ids: { slice_id: s.id, group_id: s.group_id, plan_id: s.plan_id },
    link: groupLink(s.group_id),
    question: "What should I do about this?",
  };
}

/** A group of two or more slices copies once, on its heading. */
export function slicesCopy(title, slices, portfolioName) {
  return {
    what: `${title.toLowerCase()} slices`,
    name: `${portfolioName} plan`,
    facts: slices.map((s) => `- ${sliceTitle(s)}, lane ${s.lane}, ${statusText(s)} (group_id: ${s.group_id}) ${groupLink(s.group_id)}`),
    question: "What should I do about these?",
  };
}

export function notInPlanCopy(projects, portfolioName) {
  return {
    what: "projects not in the plan",
    name: `${portfolioName} plan`,
    facts: projects.map((p) => `- ${p.name} (group_id: ${p.group_id}) ${groupLink(p.group_id)}`),
    question: "Where should these go in the plan, if anywhere?",
  };
}
