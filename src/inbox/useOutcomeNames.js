import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

/**
 * What each inbox.outcome table is called and how its rows are named.
 * `icon` is an ObjectIcon type; job applications have none and use the Jobs app icon.
 */
export const OUTCOME_TYPES = {
  items: { word: "Item", icon: "item", columns: "id, name", name: (r) => r.name },
  intents: { word: "Intention", icon: "intention", columns: "id, text", name: (r) => r.text },
  events: { word: "Event", icon: "event", columns: "id, text", name: (r) => r.text },
  job_applications: {
    word: "Job application",
    appIcon: "Briefcase",
    columns: "id, org, role",
    name: (r) => [r.role, r.org].filter(Boolean).join(" at "),
  },
};

export const outcomeKey = (table, id) => `${table}:${id}`;

/** { table: [ids] } across every row's outcome, known tables only, no repeats. */
export function outcomeIdsByTable(rows) {
  const ids = {};
  for (const row of rows || []) {
    for (const entry of Array.isArray(row?.outcome) ? row.outcome : []) {
      if (!OUTCOME_TYPES[entry?.table] || !entry.id) continue;
      (ids[entry.table] = ids[entry.table] || new Set()).add(entry.id);
    }
  }
  return Object.fromEntries(Object.entries(ids).map(([t, set]) => [t, [...set].sort()]));
}

/**
 * Names for every outcome entry, one query per table.
 * Returns { "table:id": name }, with null for a record that is gone.
 */
export async function fetchOutcomeNames(rows) {
  const byTable = outcomeIdsByTable(rows);
  const names = {};
  await Promise.all(
    Object.entries(byTable).map(async ([table, ids]) => {
      const type = OUTCOME_TYPES[table];
      const { data, error } = await supabase.from(table).select(type.columns).in("id", ids);
      if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
      for (const id of ids) names[outcomeKey(table, id)] = null;
      for (const r of data || []) names[outcomeKey(table, r.id)] = type.name(r) || "";
    }),
  );
  return names;
}

/** The names map for these rows, or null until it loads (or when the read fails, logged). */
export default function useOutcomeNames(rows) {
  const [names, setNames] = useState(null);
  const signature = JSON.stringify(outcomeIdsByTable(rows));

  useEffect(() => {
    let live = true;
    if (signature === "{}") {
      setNames({});
      return undefined;
    }
    fetchOutcomeNames(rows)
      .then((n) => live && setNames(n))
      .catch((err) => {
        console.error("[useOutcomeNames]", err);
        if (live) setNames(null);
      });
    return () => {
      live = false;
    };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  return names;
}
