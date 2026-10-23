import React, { useState } from "react";
import { Plus } from "lucide-react";
import { matchesQuery } from "../utils/search";
import ObjectIcon from "../shared/ObjectIcon";

const RESULT_CAP = 50;
export const memberKey = (memberType, memberId) => `${memberType}:${memberId}`;

/**
 * Items and intentions that can join a group: live, not already in it, not a
 * group's own intention, and in `contextId` unless widened to all contexts.
 */
export function memberCandidates({ items = [], intents = [], contextId, allContexts, excluded, search }) {
  const inScope = (r) => allContexts || !contextId || r.contextId === contextId;
  const rows = [
    ...items
      .filter((i) => !i.archived && inScope(i))
      .map((i) => ({ memberType: "item", record: i, name: i.name || "", tags: i.tags || [] })),
    ...intents
      .filter((i) => !i.archived && !i.groupId && inScope(i))
      .map((i) => ({ memberType: "intention", record: i, name: i.text || "", tags: i.tags || [] })),
  ];
  return rows
    .filter((r) => !excluded.has(memberKey(r.memberType, r.record.id)))
    .filter((r) => matchesQuery(search, r.name, ...r.tags))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Search-and-add for group members: tap a row to add it. */
export default function MemberPicker({ items, intents, contexts, contextId, excluded, onAdd }) {
  const [search, setSearch] = useState("");
  const [allContexts, setAllContexts] = useState(!contextId);
  const results = memberCandidates({ items, intents, contextId, allContexts, excluded, search });
  const contextName = (id) => contexts.find((c) => c.id === id)?.name;
  const scopeName = contextName(contextId);

  return (
    <div className="mt-3 p-3 border border-border rounded-lg bg-background">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search items and intentions..."
        aria-label="Search items and intentions"
        className="w-full px-3 py-2 border border-border rounded-lg text-base mb-2"
        autoFocus
      />
      {contextId && (
        <label className="flex items-center gap-2 mb-2 min-h-[44px]">
          <input
            type="checkbox"
            checked={allContexts}
            onChange={(e) => setAllContexts(e.target.checked)}
            className="rounded accent-primary"
          />
          <span className="text-sm">
            Search all contexts{!allContexts && scopeName ? ` (now: ${scopeName} only)` : ""}
          </span>
        </label>
      )}
      <div className="space-y-2" style={{ maxHeight: "50vh", overflowY: "auto" }}>
        {results.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">
            {search.trim() ? "Nothing matches" : "Nothing left to add"}
            {!allContexts && contextId ? " in this context" : ""}
          </p>
        ) : (
          results.slice(0, RESULT_CAP).map((r) => (
            <button
              type="button"
              key={memberKey(r.memberType, r.record.id)}
              onClick={() => onAdd(r.memberType, r.record.id)}
              className="w-full flex items-center gap-2 p-3 border border-border rounded-lg bg-card hover:border-primary text-left"
            >
              <ObjectIcon type={r.memberType} className="w-4 h-4 text-muted-foreground" />
              <span className="flex-1 min-w-0">
                <span className="block font-medium text-sm truncate">{r.name || "Untitled"}</span>
                {allContexts && contextName(r.record.contextId) && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <ObjectIcon type="context" className="w-3 h-3" />
                    {contextName(r.record.contextId)}
                  </span>
                )}
              </span>
              <Plus className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
            </button>
          ))
        )}
        {results.length > RESULT_CAP && (
          <p className="text-xs text-muted-foreground text-center py-1">
            Showing {RESULT_CAP} of {results.length}. Search to narrow.
          </p>
        )}
      </div>
    </div>
  );
}
