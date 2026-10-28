import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Boxes } from "lucide-react";
import { GroupTypeIcon } from "../shared/ObjectIcon";
import { groupDetailPath } from "../viewPaths";

// The inbox detail page's Group field (Overwatch 8c, spec section 9): the group the filed
// intention (or, with none, the item) joins. A picklist like Context, of Alex's open groups of
// any type, labelled "<type>: <name>". It lists the chosen context's groups first, with a way to
// see them all.

/** "Project: Overwatch". */
export function groupLabel(g) {
  return `${g.typeLabel}: ${g.name}`;
}

const byLabel = (a, b) => groupLabel(a).localeCompare(groupLabel(b), undefined, { sensitivity: "base" });

/**
 * @param {Array}    groups     useOpenGroups' rows: { id, name, typeLabel, typeIcon, contextId }.
 * @param {string}   contextId  The page's Context; "" for none, which shows every group.
 * @param {string}   value      The chosen group id, "" for none.
 * @param {Function} onChange   (groupId) with "" to clear it.
 */
export default function SuggestedGroup({ groups = [], contextId = "", value = "", onChange, fieldClass, labelClass }) {
  const [showAll, setShowAll] = useState(false);
  const current = groups.find((g) => g.id === value) || null;
  const inContext = contextId ? groups.filter((g) => g.contextId === contextId) : groups;
  const filtering = Boolean(contextId) && !showAll && inContext.length < groups.length;
  const shown = (filtering ? inContext : groups).slice().sort(byLabel);
  // The chosen group stays in the list even when it is outside the context.
  const options = current && !shown.includes(current) ? [current, ...shown] : shown;
  // A suggestion whose group has since closed, or that we could not load.
  const gone = value && !current;

  return (
    <div>
      <label htmlFor="inbox-detail-group" className={labelClass}>
        {current
          ? <GroupTypeIcon icon={current.typeIcon} className="w-4 h-4" />
          : <Boxes className="w-4 h-4" aria-hidden="true" />}
        Group
      </label>
      <select id="inbox-detail-group" value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
        <option value="">No group</option>
        {gone && <option value={value}>Suggested group (no longer open)</option>}
        {options.map((g) => (
          <option key={g.id} value={g.id}>{groupLabel(g)}</option>
        ))}
      </select>
      <div className="mt-1 flex items-center justify-between gap-2 flex-wrap text-sm">
        {current ? (
          <Link to={groupDetailPath(current.id)} className="inline-flex items-center min-h-[44px] text-primary hover:text-primary-hover">
            Open {current.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">
            {gone ? "That group is closed or archived now. Pick another, or No group." : "Filing joins no group."}
          </span>
        )}
        {contextId && inContext.length < groups.length && (
          <button type="button" onClick={() => setShowAll((v) => !v)}
            className="inline-flex items-center min-h-[44px] text-primary hover:text-primary-hover">
            {showAll ? "Only this context's groups" : `Show all groups (${groups.length})`}
          </button>
        )}
      </div>
    </div>
  );
}
