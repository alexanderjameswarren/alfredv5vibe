import {
  inboxDetailPath,
  intentionDetailPath,
  executionPath,
  samSongPath,
} from "../viewPaths";

// Where a resolved record opens. Pure: takes resolve_record's result
// ({table, row, match_count} or null) plus a lookup into Alfred's loaded state,
// and returns one destination:
//
//   {kind: "path", path}                    a screen with its own address
//   {kind: "item" | "context" | "collection", id}  a detail view opened via state
//   {kind: "generic"}                       the read-only record page
//   {kind: "missing"}                       nothing has this id
//
// A record link must never land on a list: every state-backed screen is only
// chosen when its row is in state, since those screens bounce to their list
// otherwise. Anything else falls back to the generic page.
//
// lookup: {inbox(id) -> row|null, item(id), intention(id), context(id),
//          collection(id) -> boolean, archivedTarget(inboxId) -> {kind, id}|null}

const path = (p) => ({ kind: "path", path: p });
const state = (kind, id) => ({ kind, id });

// Live capture -> its detail; archived -> what it became, if that is loaded.
function openInbox(id, lookup) {
  const row = id && lookup.inbox(id);
  if (!row) return null;
  if (!row.archived) return path(inboxDetailPath(id));
  const t = lookup.archivedTarget(id);
  if (t?.kind === "item" && lookup.item(t.id)) return state("item", t.id);
  if (t?.kind === "intention" && lookup.intention(t.id)) return path(intentionDetailPath(t.id));
  return null;
}

const openIntention = (id, lookup) =>
  id && lookup.intention(id) ? path(intentionDetailPath(id)) : null;

const openCollection = (id, lookup) =>
  id && lookup.collection(id) ? state("collection", id) : null;

// Executions and SAM songs fetch by id from their own address, so no state check.
export const RECORD_SCREENS = {
  inbox: (row, lookup) => openInbox(row.id, lookup),
  intents: (row, lookup) => openIntention(row.id, lookup),
  executions: (row) => path(executionPath(row.id)),
  sam_songs: (row) => path(samSongPath(row.id)),
  items: (row, lookup) => (lookup.item(row.id) ? state("item", row.id) : null),
  contexts: (row, lookup) => (lookup.context(row.id) ? state("context", row.id) : null),
  item_collections: (row, lookup) => openCollection(row.id, lookup),
  clips: (row, lookup) => openInbox(row.inbox_id, lookup),
  reminders: (row, lookup) =>
    openInbox(row.inbox_id, lookup) || openIntention(row.intent_id, lookup),
  notification_steps: (row) => row.execution_id && path(executionPath(row.execution_id)),
  collection_items: (row, lookup) => openCollection(row.collection_id, lookup),
};

export function recordDestination(result, lookup) {
  if (!result || !result.table || !result.row) return { kind: "missing" };
  const screen = RECORD_SCREENS[result.table];
  return (screen && screen(result.row, lookup)) || { kind: "generic" };
}
