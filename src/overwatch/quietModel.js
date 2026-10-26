// Quiet lately (spec section 9, item 2): apps past their rhythm, worked out live.
// Last use is the newer of the activity view's date and the latest nightly note's quiet_apps flag,
// which the nightly run fills from each app's own data when the activity log has no row.

import { daysBefore } from "../money/moneyFormat";
import { daysSince, shortDay } from "./projectsModel";

/** A Pacific YYYY-MM-DD for when the note says the app was last used, or null. */
export function noteLastUse(flag, forDate) {
  if (!flag) return null;
  if (flag.last_used_on) return String(flag.last_used_on).slice(0, 10);
  const n = Number(flag.days_since);
  if (!forDate || flag.days_since === null || flag.days_since === "" || Number.isNaN(n)) return null;
  return daysBefore(forDate, n);
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** True when an ease_off watch item for the app is in force today. */
function easedOff(appId, watch, today) {
  return watch.some((w) => w.kind === "ease_off" && w.app_id === appId
    && (!w.starts_on || w.starts_on <= today) && (!w.ends_on || w.ends_on >= today));
}

/**
 * The quiet apps, quietest first (no activity yet, then most days). Apps with no rhythm_days or
 * an ease_off in force are left out. `lastActivity` rows: { app_id, last_occurred_at } (UTC);
 * dates are compared as Pacific days via the caller's `toDay`.
 */
export function quietApps({ profiles = [], lastActivity = [], note = null, watch = [], today, toDay }) {
  const flags = note?.flags?.quiet_apps || [];
  const rows = [];
  for (const p of profiles) {
    if (p.rhythm_days == null || easedOff(p.app_id, watch, today)) continue;
    const viewRow = lastActivity.find((a) => a.app_id === p.app_id);
    const fromView = viewRow?.last_occurred_at ? toDay(viewRow.last_occurred_at) : null;
    const fromNote = noteLastUse(flags.find((f) => f.app === p.app_id), note?.for_date);
    const lastUsed = newer(fromView, fromNote);
    const days = lastUsed ? daysSince(lastUsed, today) : null;
    if (days !== null && days <= p.rhythm_days) continue;
    rows.push({ appId: p.app_id, rhythm: p.rhythm_days, lastUsed, days, red: days !== null && days >= 2 * p.rhythm_days });
  }
  return rows.sort((a, b) => (a.days === null ? -1 : b.days === null ? 1 : b.days - a.days));
}

export function lastUsedLabel(row) {
  return row.lastUsed ? `Last used ${shortDay(row.lastUsed)}` : "No activity yet";
}
