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
type LinkRow = {
  project_code: string; kind: string | null; status: string; link_expires_at: string | null; link_used_at: string | null;
  chat_url: string | null;
};

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
  /** Actions with a live link (189): link_issued, a link hash, unused, not expired. Never the hash itself. */
  liveLinks(nowIso: string): Promise<LinkRow[]>;
  /** s6 (L3d): switchboard_run_links not used and not voided (250). Never the token hash. */
  runLinks(): Promise<RunLinkRow[]>;
  /** The run links' requests, for their project code. */
  runRequests(ids: string[]): Promise<{ id: string; project_code: string }[]>;
  /** The review links' reviews, for their status. */
  codeReviews(ids: string[]): Promise<{ id: string; status: string }[]>;
};
type RunLinkRow = {
  id: string; request_id: string; review_id: string | null; used_at: string | null; voided_at: string | null; created_at: string;
};
type LiveLink = { kind: string | null; expires_at: string | null; chat_url: string | null };

export type PanelData = {
  clips: Clip[];
  inbox: InboxRow[];
  actions: { project_code: string }[];
  portfolios: Portfolio[];
  plans: Plan[];
  lanes: Lane[];
  slices: Slice[];
  projectPlans: ProjectPlan[];
  links?: LinkRow[];
  /** Each project's newest pending run or review link, already resolved (pendingRunLinks). */
  runLive?: Map<string, LiveLink>;
};

/**
 * s6 (L3d): each project's newest pending /run/ or /review/ link. A run link (review_id null) is pending until it is
 * used or voided. A review link is never used (consume refuses it), so it is pending while not voided and its review
 * is still open. kind sf_run or sf_review; these links have no expiry and no chat, so both are null.
 */
export function pendingRunLinks(
  links: RunLinkRow[], requests: { id: string; project_code: string }[], reviews: { id: string; status: string }[],
): Map<string, LiveLink> {
  const projectOf = new Map(requests.map((r) => [r.id, r.project_code]));
  const open = new Set(reviews.filter((r) => r.status === "open").map((r) => r.id));
  const out = new Map<string, LiveLink>();
  const newest = new Map<string, number>();
  for (const l of links) {
    if (l.used_at !== null || l.voided_at !== null) continue;
    if (l.review_id !== null && !open.has(l.review_id)) continue;
    const code = projectOf.get(l.request_id);
    const at = Date.parse(l.created_at);
    if (!code || (newest.get(code) ?? -Infinity) >= at) continue;
    newest.set(code, at);
    out.set(code, { kind: l.review_id === null ? "sf_run" : "sf_review", expires_at: null, chat_url: null });
  }
  return out;
}

/** A link's kind in the panel's words, as 227's switchboard_issue_link puts it in the url. */
const panelKind = (kind: string | null) => (kind === "sf_deploy" || kind === "sf_test" ? "deploy" : kind);

/** Each project's newest live link (latest expiry; 30 minutes from issue, so latest issued), checked again here. */
function liveLinks(links: LinkRow[], now: number) {
  const out = new Map<string, LiveLink>();
  const newest = new Map<string, number>();
  for (const l of links) {
    const exp = Date.parse(l.link_expires_at ?? "");
    if (l.status !== "link_issued" || l.link_used_at !== null || !(exp > now)) continue;
    if ((newest.get(l.project_code) ?? -Infinity) >= exp) continue;
    newest.set(l.project_code, exp);
    out.set(l.project_code, { kind: panelKind(l.kind), expires_at: l.link_expires_at as string, chat_url: l.chat_url ?? null });
  }
  return out;
}

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
export function buildPanel(data: PanelData, now = Date.now()) {
  const reports = latestReports(data.clips);
  const unarchived = new Set(data.inbox.filter((r) => r.archived === false).map((r) => r.id));
  const waiting = new Set(data.actions.map((a) => a.project_code));
  const lanes = laneOrder(data);
  // A live git-style link wins over a run link: it expires in 30 minutes and has a chat; the run link stays lit.
  const live = new Map<string, LiveLink>([...(data.runLive ?? new Map()), ...liveLinks(data.links ?? [], now)]);
  const codes = [...new Set([...reports.keys(), ...waiting, ...lanes.keys(), ...live.keys()])].sort();
  const projects: Record<string, unknown> = {};
  for (const code of codes) {
    const inboxId = reports.get(code);
    projects[code] = {
      report_unread: inboxId ? unarchived.has(inboxId) : false,
      waiting_on_alex: waiting.has(code),
      lane: lanes.get(code)?.lane ?? null,
      lane_order: lanes.get(code)?.lane_order ?? null,
      live_link: live.get(code) ?? null,
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

export async function handle(req: Request, deps: Deps, now = Date.now()): Promise<Response> {
  if (!keyMatches(req.headers.get("x-switchboard-panel-key"), deps.panelKey)) return json({ ok: false, error: "unauthorized" }, 401);
  if (req.method !== "GET") return json({ ok: false, error: "GET only" }, 405);

  const [clips, actions, portfolios, links] = await Promise.all([
    deps.latestCliClips(), deps.waitingActions(), deps.portfolios(),
    // A failed live-link read never takes the other fields down: every live_link is then null.
    deps.liveLinks(new Date(now).toISOString()).catch(() => []),
  ]);
  const runLive = await runLinksOf(deps);
  const inboxIds = [...latestReports(clips).values()].filter((id): id is string => Boolean(id));
  const plans = await deps.activePlans(portfolios.map((p) => p.id));
  const planIds = plans.map((p) => p.id);
  const [inbox, lanes, slices] = await Promise.all([deps.inboxRows(inboxIds), deps.lanes(planIds), deps.slices(planIds)]);
  const projectPlans = await deps.projectPlans([...new Set(slices.map((s) => s.group_id))]);
  return json(buildPanel({ clips, inbox, actions, portfolios, plans, lanes, slices, projectPlans, links, runLive }, now));
}

/** The pending run and review links; any failed read leaves them all out, never the rest of the panel. */
async function runLinksOf(deps: Deps): Promise<Map<string, LiveLink>> {
  try {
    const links = await deps.runLinks();
    if (!links.length) return new Map();
    const reviewIds = [...new Set(links.map((l) => l.review_id).filter((id): id is string => Boolean(id)))];
    const [requests, reviews] = await Promise.all([
      deps.runRequests([...new Set(links.map((l) => l.request_id))]),
      reviewIds.length ? deps.codeReviews(reviewIds) : Promise.resolve([]),
    ]);
    return pendingRunLinks(links, requests, reviews);
  } catch {
    return new Map();
  }
}
