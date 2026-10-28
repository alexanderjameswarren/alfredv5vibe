import { supabase } from "../supabaseClient";
import { daysBefore, pacificToday } from "../money/moneyFormat";
import { rowDay } from "./activityModel";

/**
 * Overwatch tab reads. Spec: docs/technical-spec-overwatch-q4n.md section 9.
 * Straight to PostgREST under owner RLS, read only: nothing on the tab writes.
 */

const NOTE_COLUMNS = "id, period, for_date, body, flags, plan_id, created_at";
const RUN_COLUMNS = "id, status, started_at, finished_at";
const INBOX_COLUMNS = "id, captured_text, created_at, source_type, source_metadata, source_app";

function fail(what, error) {
  console.warn(`[overwatch] ${what}:`, error?.message); // eslint-disable-line no-console
  throw new Error(`${what}. Please try again.`);
}

/** The latest nightly note, and the latest weekly note from the last 7 days (or null). */
export async function getNotes(today = pacificToday()) {
  const [nightly, weekly] = await Promise.all([
    supabase.from("overwatch_notes").select(NOTE_COLUMNS).eq("period", "nightly")
      .order("for_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("overwatch_notes").select(NOTE_COLUMNS).eq("period", "weekly")
      .gte("for_date", daysBefore(today, 6)).order("for_date", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (nightly.error) fail("Could not load tonight's note", nightly.error);
  if (weekly.error) fail("Could not load the weekly note", weekly.error);
  return { nightly: nightly.data || null, weekly: weekly.data || null };
}

/** One note by id, or null. */
export async function getNote(id) {
  const { data, error } = await supabase.from("overwatch_notes").select(NOTE_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail("Could not load the briefing", error);
  return data || null;
}

/** The run that wrote a note: the newest real run of its job for its date (details.local_date), or null. */
export async function getRunForNote(note) {
  const { data, error } = await supabase.from("platform_runs").select(`${RUN_COLUMNS}, details`)
    .eq("app", "overwatch").eq("job", note.period).eq("details->>local_date", note.for_date)
    .order("started_at", { ascending: false }).limit(5);
  if (error) return null;
  return (data || []).find((r) => r.status !== "running" && !r.details?.duplicate_of) || null;
}

/** The latest real (not duplicate) nightly and weekly runs, from the newest 20. */
export async function getLatestRuns() {
  const { data, error } = await supabase.from("platform_runs").select(`${RUN_COLUMNS}, error_message, details, job`)
    .eq("app", "overwatch").in("job", ["nightly", "weekly"])
    .order("started_at", { ascending: false }).limit(20);
  if (error) fail("Could not load the last report", error);
  const real = (data || []).filter((r) => !r.details?.duplicate_of && r.status !== "running");
  return {
    nightly: real.find((r) => r.job === "nightly") || null,
    weekly: real.find((r) => r.job === "weekly") || null,
  };
}

/**
 * Active Projects, live: overwatch_project_progress, then for those groups their estimate
 * history, their live member count, the names of the groups they wait on, and the plan's settings.
 */
export async function getProjects() {
  const { data: rows, error } = await supabase.rpc("overwatch_project_progress", {});
  if (error) fail("Could not load the projects", error);
  const projects = rows || [];
  const ids = projects.map((p) => p.group_id);
  const waitIds = [...new Set(projects.map((p) => p.waiting_on_group_id).filter(Boolean))];
  const none = Promise.resolve({ data: [], error: null });
  const [estimates, members, waits, plan, type] = await Promise.all([
    ids.length
      ? supabase.from("project_estimates").select("group_id, kind, estimate, steps_added, at_step, reason, created_at")
        .in("group_id", ids).order("created_at", { ascending: true })
      : none,
    ids.length
      ? supabase.from("item_group_members").select("group_id").in("group_id", ids).is("removed_at", null)
        .in("member_type", ["item", "intention"])
      : none,
    waitIds.length ? supabase.from("item_groups").select("id, name").in("id", waitIds) : none,
    supabase.from("overwatch_plans").select("id, settings").eq("active", true).maybeSingle(),
    // The icon the Groups list shows for a Project.
    supabase.from("group_types").select("icon").eq("kind", "project").limit(1).maybeSingle(),
  ]);
  for (const [what, res] of [["estimates", estimates], ["members", members], ["waits", waits], ["plan", plan], ["type", type]]) {
    if (res.error) fail(`Could not load the projects' ${what}`, res.error);
  }
  return {
    projects,
    estimates: estimates.data || [],
    memberGroupIds: (members.data || []).map((m) => m.group_id),
    groupNames: Object.fromEntries((waits.data || []).map((g) => [g.id, g.name])),
    settings: plan.data?.settings || {},
    projectIcon: type.data?.icon || "SquareKanban",
  };
}

const SLICE_COLUMNS = "id, plan_id, lane_id, position, group_id, phases, why, status, paused_reason, status_changed_at";

/**
 * The portfolio plans (spec 4.16, section 9 item 3): unarchived portfolios in switch order, each one's
 * active plan, its lanes and slices, every unclosed Project's progress (for the Now cards and "Not in
 * the plan"), and the names of slice groups that progress does not cover (closed ones).
 */
export async function getPortfolioPlans() {
  const empty = { portfolios: [], plans: [], lanes: [], slices: [], progress: [], groupNames: {} };
  const { data: portfolios, error } = await supabase.from("portfolios").select("id, name, context_ids, position")
    .eq("archived", false).order("position", { ascending: true }).order("name", { ascending: true });
  if (error) fail("Could not load the portfolios", error);
  if (!portfolios?.length) return empty;
  const plans = await supabase.from("portfolio_plans").select("id, portfolio_id, theory, review_by, created_at")
    .eq("active", true).in("portfolio_id", portfolios.map((p) => p.id));
  if (plans.error) fail("Could not load the portfolio plans", plans.error);
  const planIds = (plans.data || []).map((p) => p.id);
  const none = Promise.resolve({ data: [], error: null });
  const [lanes, slices, progress] = await Promise.all([
    planIds.length
      ? supabase.from("portfolio_lanes").select("id, plan_id, name, position, note").in("plan_id", planIds)
        .order("position", { ascending: true })
      : none,
    planIds.length
      ? supabase.from("portfolio_slices").select(SLICE_COLUMNS).in("plan_id", planIds).order("position", { ascending: true })
      : none,
    supabase.rpc("overwatch_project_progress", { p_status: ["someday", "active", "background"] }),
  ]);
  for (const [what, res] of [["lanes", lanes], ["slices", slices], ["projects", progress]]) {
    if (res.error) fail(`Could not load the plan's ${what}`, res.error);
  }
  const known = new Set((progress.data || []).map((p) => p.group_id));
  const missing = [...new Set((slices.data || []).map((s) => s.group_id))].filter((id) => !known.has(id));
  const names = missing.length ? await supabase.from("item_groups").select("id, name").in("id", missing) : { data: [] };
  return {
    portfolios,
    plans: plans.data || [],
    lanes: lanes.data || [],
    slices: slices.data || [],
    progress: progress.data || [],
    groupNames: Object.fromEntries((names.data || []).map((g) => [g.id, g.name])),
  };
}

/** Quiet lately's live reads: each app's newest activity, the profiles' rhythms, and the ease_off watch items. */
export async function getQuiet() {
  const [last, profiles, watch] = await Promise.all([
    supabase.from("overwatch_app_last_activity").select("app_id, last_occurred_at"),
    supabase.from("app_profiles").select("app_id, rhythm_days"),
    supabase.from("overwatch_watch").select("kind, app_id, starts_on, ends_on").eq("kind", "ease_off"),
  ]);
  for (const [what, res] of [["activity", last], ["profiles", profiles], ["watch items", watch]]) {
    if (res.error) fail(`Could not load the apps' ${what}`, res.error);
  }
  return { lastActivity: last.data || [], profiles: profiles.data || [], watch: watch.data || [] };
}

const ACTIVITY_COLUMNS = "id, occurred_at, app_id, context_id, group_id, target_type, target_id, kind, title, summary, source, source_ref";

/**
 * One Pacific day's activity, newest first. The read spans the day a day either side in UTC (the
 * (user_id, occurred_at) index serves it) and keeps the rows whose day is `day`: the Pacific date
 * of occurred_at, or for the nightly run's rows the date in source_ref, since the run logs a day
 * after it ends.
 */
export async function getActivityDay(day) {
  const { data, error } = await supabase.from("activity").select(ACTIVITY_COLUMNS)
    .gte("occurred_at", `${daysBefore(day, 1)}T00:00:00Z`).lt("occurred_at", `${daysBefore(day, -2)}T00:00:00Z`)
    .order("occurred_at", { ascending: false }).limit(1000);
  if (error) fail("Could not load the activity", error);
  return (data || []).filter((r) => rowDay(r) === day);
}

/** Names for the Project groups a day's activity counts toward, and the Project type's icon. */
export async function getActivityGroupInfo(groupIds) {
  const none = Promise.resolve({ data: [], error: null });
  const [groups, type] = await Promise.all([
    groupIds.length ? supabase.from("item_groups").select("id, name").in("id", groupIds) : none,
    supabase.from("group_types").select("icon").eq("kind", "project").limit(1).maybeSingle(),
  ]);
  if (groups.error) fail("Could not load the projects' names", groups.error);
  return {
    names: Object.fromEntries((groups.data || []).map((g) => [g.id, g.name])),
    projectIcon: type.data?.icon || "SquareKanban",
  };
}

/**
 * Ideas (spec section 9, item 5): Someday Projects, and active ones parked behind a hurdle, with
 * when each group was added and the context (and its app) it sits in.
 */
export async function getIdeas() {
  const { data: rows, error } = await supabase.rpc("overwatch_project_progress", { p_status: ["someday", "active"] });
  if (error) fail("Could not load the ideas", error);
  const ideas = (rows || []).filter((p) => p.group_status === "someday" || p.hurdle_kind);
  const ids = ideas.map((p) => p.group_id);
  const contextIds = [...new Set(ideas.map((p) => p.context_id).filter(Boolean))];
  const none = Promise.resolve({ data: [], error: null });
  const [groups, contexts] = await Promise.all([
    ids.length ? supabase.from("item_groups").select("id, created_at").in("id", ids) : none,
    contextIds.length ? supabase.from("contexts").select("id, name, app_id").in("id", contextIds) : none,
  ]);
  if (groups.error) fail("Could not load the ideas' dates", groups.error);
  if (contexts.error) fail("Could not load the ideas' contexts", contexts.error);
  const added = Object.fromEntries((groups.data || []).map((g) => [g.id, g.created_at]));
  const ctx = Object.fromEntries((contexts.data || []).map((c) => [c.id, c]));
  return ideas.map((p) => ({ ...p, created_at: added[p.group_id] || null, context: ctx[p.context_id] || null }));
}

/**
 * The items and intentions Ideas can show (Alex's rule, Step 35d): in the Alfred context, every
 * active or someday one; elsewhere, those tagged "idea". Also every context, and which of these
 * records are live members of any group. The rule itself is applied in ideasModel.js.
 */
export async function getIdeaRecords() {
  const { data: contexts, error } = await supabase.from("contexts").select("id, name, app_id").eq("archived", false);
  if (error) fail("Could not load the contexts", error);
  const alfred = (contexts || []).find((c) => c.name.trim().toLowerCase() === "alfred");
  const none = Promise.resolve({ data: [], error: null });
  const live = (q) => q.in("status", ["active", "someday"]).eq("archived", false).limit(500);
  const itemCols = "id, name, context_id, tags, status, created_at, is_capture_target";
  const intentCols = "id, text, context_id, tags, status, created_at, group_id";
  const reads = await Promise.all([
    alfred ? live(supabase.from("items").select(itemCols).eq("context_id", alfred.id)) : none,
    live(supabase.from("items").select(itemCols).contains("tags", ["idea"])),
    alfred ? live(supabase.from("intents").select(intentCols).eq("context_id", alfred.id)) : none,
    live(supabase.from("intents").select(intentCols).contains("tags", ["idea"])),
  ]);
  for (const r of reads) if (r.error) fail("Could not load the ideas", r.error);
  const byId = new Map();
  for (const r of [...reads[0].data, ...reads[1].data]) byId.set(r.id, { ...r, type: "item" });
  for (const r of [...reads[2].data, ...reads[3].data]) byId.set(r.id, { ...r, name: r.text, type: "intention" });
  const records = [...byId.values()];
  const ids = records.map((r) => r.id);
  const members = ids.length
    ? await supabase.from("item_group_members").select("member_id").in("member_id", ids).is("removed_at", null)
    : { data: [], error: null };
  if (members.error) fail("Could not load the ideas' groups", members.error);
  return {
    records,
    contexts: contexts || [],
    alfredContextId: alfred?.id || null,
    groupedIds: (members.data || []).map((m) => m.member_id),
  };
}

/** Open friction entries, newest first, and the active plan's settings for the pattern trigger. */
export async function getOpenFriction() {
  const [entries, plan] = await Promise.all([
    supabase.from("process_friction").select("id, occurred_at, what_happened, process, project_code, suggested_fix")
      .eq("status", "open").order("occurred_at", { ascending: false }).limit(200),
    supabase.from("overwatch_plans").select("settings").eq("active", true).maybeSingle(),
  ]);
  if (entries.error) fail("Could not load the friction", entries.error);
  if (plan.error) fail("Could not load the plan", plan.error);
  return { entries: entries.data || [], settings: plan.data?.settings || {} };
}

/**
 * The apps, read fresh every time the tab loads. Not the app-wide useApps cache, which keeps
 * the list for the whole browser session, so a new apps row would not show until a full reload.
 */
export async function getApps() {
  const { data, error } = await supabase.from("apps").select("id, name, icon, path").order("name", { ascending: true });
  if (error) fail("Could not load the apps", error);
  return data || [];
}

/** Overwatch's untriaged inbox items, newest first. */
export async function getNeedsYou() {
  const { data, error } = await supabase.from("inbox").select(INBOX_COLUMNS)
    .eq("source_app", "overwatch").is("triaged_at", null).eq("archived", false)
    .order("created_at", { ascending: false }).limit(50);
  if (error) fail("Could not load what needs you", error);
  return data || [];
}

/** The first non-empty line of a capture. */
export function firstLine(text) {
  return (text || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
}
