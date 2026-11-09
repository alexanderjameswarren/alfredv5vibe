// switchboard-panel's logic, free of Deno and the database so `node --test` can run it. index.ts supplies `Deps`.
// Spec: docs/technical-spec-switchboard2-h8r.md 8.1, "Panel".

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const MIN_KEY = 32;
// The step segment is s, a digit, then any letters or digits (s1, s86, s86k, s86kd), as claims reads it (switchboard s86l).
const PROJECT_OF_TAG = /^([a-z0-9_]+-[a-z0-9]+)-s\d[a-z0-9]*-[a-z0-9]{4}$/;

/** A run tag's project code, or null when it isn't a run tag. */
export function projectOfTag(tag: string | null | undefined): string | null {
  return PROJECT_OF_TAG.exec(tag ?? "")?.[1] ?? null;
}

type Clip = { run_tag: string | null; inbox_id: string | null };
type InboxRow = { id: string; archived: boolean | null };
type Portfolio = { id: string; position: number };
type Plan = { id: string; portfolio_id: string };
type Lane = { id: string; plan_id: string; name: string; position: number };
type Slice = { plan_id: string; lane_id: string; position: number; group_id: string; status: string };
type ProjectPlan = { group_id: string; project_code: string | null };

export type Deps = {
  panelKey: string;
  /** CLI clips with a run tag, newest first. */
  latestCliClips(): Promise<Clip[]>;
  inboxRows(ids: string[]): Promise<InboxRow[]>;
  /** Actions with needs_click, an unused link and a status still open. */
  waitingActions(): Promise<{ project_code: string }[]>;
  portfolios(): Promise<Portfolio[]>;
  activePlans(portfolioIds: string[]): Promise<Plan[]>;
  lanes(planIds: string[]): Promise<Lane[]>;
  slices(planIds: string[]): Promise<Slice[]>;
  projectPlans(groupIds: string[]): Promise<ProjectPlan[]>;
};

export type PanelData = {
  clips: Clip[];
  inbox: InboxRow[];
  actions: { project_code: string }[];
  portfolios: Portfolio[];
  plans: Plan[];
  lanes: Lane[];
  slices: Slice[];
  projectPlans: ProjectPlan[];
};

/** Each project's latest report's inbox id, from clips newest first. Null when that clip has none. */
function latestReports(clips: Clip[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const c of clips) {
    const project = projectOfTag(c.run_tag);
    if (project && !out.has(project)) out.set(project, c.inbox_id);
  }
  return out;
}

/**
 * Each project's lane, and its rank across every plan: portfolio, then lane, then slice. A project can
 * have slices in several lanes, so its first slice with work left decides; if all are done, its first.
 */
function laneOrder({ portfolios, plans, lanes, slices, projectPlans }: PanelData): Map<string, { lane: string; lane_order: number }> {
  const portfolioPos = new Map(portfolios.map((p) => [p.id, p.position]));
  const planPos = new Map(plans.map((p) => [p.id, portfolioPos.get(p.portfolio_id) ?? Number.MAX_SAFE_INTEGER]));
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  const codes = new Map(projectPlans.filter((p) => p.project_code).map((p) => [p.group_id, p.project_code as string]));

  const rank = (s: Slice) => [planPos.get(s.plan_id) ?? Number.MAX_SAFE_INTEGER, laneById.get(s.lane_id)?.position ?? Number.MAX_SAFE_INTEGER, s.position];
  const before = (a: number[], b: number[]) => {
    const i = a.findIndex((v, n) => v !== b[n]);
    return i === -1 ? 0 : a[i] - b[i];
  };
  const firstOf = new Map<string, Slice>();
  for (const s of slices) {
    const code = codes.get(s.group_id);
    if (!code || !laneById.has(s.lane_id)) continue;
    const held = firstOf.get(code);
    const better = !held || (held.status === "done") !== (s.status === "done")
      ? !held || held.status === "done"
      : before(rank(s), rank(held)) < 0;
    if (better) firstOf.set(code, s);
  }
  const ordered = [...firstOf.entries()].sort(([, a], [, b]) => before(rank(a), rank(b)));
  return new Map(ordered.map(([code, s], i) => [code, { lane: laneById.get(s.lane_id)!.name, lane_order: i + 1 }]));
}

/** Built field by field, so nothing else in a row can reach the panel. */
export function buildPanel(data: PanelData) {
  const reports = latestReports(data.clips);
  const unarchived = new Set(data.inbox.filter((r) => r.archived === false).map((r) => r.id));
  const waiting = new Set(data.actions.map((a) => a.project_code));
  const lanes = laneOrder(data);
  const codes = [...new Set([...reports.keys(), ...waiting, ...lanes.keys()])].sort();
  const projects: Record<string, unknown> = {};
  for (const code of codes) {
    const inboxId = reports.get(code);
    projects[code] = {
      report_unread: inboxId ? unarchived.has(inboxId) : false,
      waiting_on_alex: waiting.has(code),
      lane: lanes.get(code)?.lane ?? null,
      lane_order: lanes.get(code)?.lane_order ?? null,
    };
  }
  return { ok: true, projects };
}

/** Constant-time comparison; the length pre-check stops timingSafeEqual's throw from leaking the length. */
function keyMatches(provided: string | null, expected: string): boolean {
  if (!provided || expected.length < MIN_KEY) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (!keyMatches(req.headers.get("x-switchboard-panel-key"), deps.panelKey)) return json({ ok: false, error: "unauthorized" }, 401);
  if (req.method !== "GET") return json({ ok: false, error: "GET only" }, 405);

  const [clips, actions, portfolios] = await Promise.all([deps.latestCliClips(), deps.waitingActions(), deps.portfolios()]);
  const inboxIds = [...latestReports(clips).values()].filter((id): id is string => Boolean(id));
  const plans = await deps.activePlans(portfolios.map((p) => p.id));
  const planIds = plans.map((p) => p.id);
  const [inbox, lanes, slices] = await Promise.all([deps.inboxRows(inboxIds), deps.lanes(planIds), deps.slices(planIds)]);
  const projectPlans = await deps.projectPlans([...new Set(slices.map((s) => s.group_id))]);
  return json(buildPanel({ clips, inbox, actions, portfolios, plans, lanes, slices, projectPlans }));
}
