// Ideas (Alex's rule, Step 35d), worked out from the live reads:
//   1. Someday and parked Projects, at the top.
//   (Capture targets are left out everywhere.)
//   2. Alfred context: active or someday items and intentions in no group and not tagged "bug",
//      grouped by their first tag that is an app id, the rest under "No app".
//   3. Every other context: items and intentions tagged "idea", grouped by context.
// Oldest first within a group.

import { groupDetailPath, recordPath } from "../viewPaths";
import { RECORD_LINK_BASE } from "../shared/copyRecord";
import { appDisplayName } from "./appNames";

const byAge = (a, b) => (a.created_at || "9999").localeCompare(b.created_at || "9999");

/** "Someday", or "Parked (time): waiting on the M5 Mac". */
export function projectState(p) {
  if (!p.hurdle_kind) return "Someday";
  return `Parked (${p.hurdle_kind})${p.waiting_on ? `: waiting on ${p.waiting_on}` : ""}`;
}

function projectRow(p) {
  const path = groupDetailPath(p.group_id);
  return { id: p.group_id, kind: "project", name: p.name, created_at: p.created_at, path,
    link: `${RECORD_LINK_BASE}${path.slice(1)}`, note: projectState(p) };
}

function recordRow(r, note = null) {
  return { id: r.id, kind: r.type, name: r.name, created_at: r.created_at, path: recordPath(r.id),
    link: `${RECORD_LINK_BASE}${r.id}`, note };
}

/**
 * [{ key, title, icon: { kind: "group" | "app" | "context", value }, rows }], in display order.
 * `apps` is the apps list; empty groups are left out.
 */
export function ideaGroups({ projects = [], records = [], contexts = [], alfredContextId = null, groupedIds = [], apps = [] }) {
  const appIds = new Set(apps.map((a) => a.id));
  const names = Object.fromEntries(apps.map((a) => [a.id, a.name]));
  const grouped = new Set(groupedIds);
  const groups = [];

  if (projects.length) {
    groups.push({ key: "projects", title: "Someday and parked Projects", icon: { kind: "group" },
      rows: projects.map(projectRow).sort(byAge) });
  }

  // Capture targets are working records, not ideas.
  const candidates = records.filter((r) => !r.is_capture_target);
  const alfredRows = candidates.filter((r) => r.context_id === alfredContextId && alfredContextId
    && !grouped.has(r.id) && !r.group_id && !(r.tags || []).includes("bug"));
  const byApp = new Map();
  for (const r of alfredRows) {
    const app = (r.tags || []).find((t) => appIds.has(t)) || null;
    byApp.set(app, [...(byApp.get(app) || []), r]);
  }
  const appOrder = [...byApp.keys()].filter(Boolean)
    .sort((a, b) => appDisplayName(a, names).localeCompare(appDisplayName(b, names)));
  for (const app of appOrder) {
    groups.push({ key: `app:${app}`, title: appDisplayName(app, names), icon: { kind: "app", value: app },
      rows: byApp.get(app).map((r) => recordRow(r)).sort(byAge) });
  }
  if (byApp.has(null)) {
    groups.push({ key: "app:none", title: "No app", icon: { kind: "app", value: null },
      rows: byApp.get(null).map((r) => recordRow(r)).sort(byAge) });
  }

  const ctxName = Object.fromEntries(contexts.map((c) => [c.id, c.name]));
  const byContext = new Map();
  for (const r of candidates) {
    if (r.context_id === alfredContextId || !(r.tags || []).includes("idea")) continue;
    byContext.set(r.context_id, [...(byContext.get(r.context_id) || []), r]);
  }
  const ctxOrder = [...byContext.keys()].sort((a, b) => (ctxName[a] || "").localeCompare(ctxName[b] || ""));
  for (const id of ctxOrder) {
    groups.push({ key: `context:${id}`, title: ctxName[id] || "No context", icon: { kind: "context" },
      rows: byContext.get(id).map((r) => recordRow(r)).sort(byAge) });
  }
  return groups;
}

/** "added Oct 3", Pacific. */
export function addedLabel(iso) {
  if (!iso) return null;
  return `added ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" })}`;
}

export function rowCopy(row) {
  return {
    what: "idea",
    name: row.name,
    facts: [addedLabel(row.created_at) && `Added: ${addedLabel(row.created_at).slice(6)}`, row.note],
    ids: { [row.kind === "project" ? "group_id" : `${row.kind}_id`]: row.id },
    link: row.link,
    question: "Is this worth turning into a project, or should I let it go?",
  };
}

export function groupCopy(group) {
  return {
    what: "ideas",
    name: group.title,
    facts: group.rows.map((r) => `- ${r.name} (${r.kind === "project" ? "group_id" : `${r.kind}_id`}: ${r.id}) ${r.link}`),
    question: "Which of these is worth turning into a project, and which should I let go?",
  };
}
