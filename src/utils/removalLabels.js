/** "Removed" reads as deliberate; "Checked off" as the tail of a shopping trip. */
export function removalReasonLabel(reason) {
  return reason === "completed" ? "Checked off" : "Removed";
}

/**
 * Collapse removals into the actions that produced them.
 *
 * Rows written by one action share an exact `removed_at` — they go in a single
 * INSERT, so Postgres gives them one transaction timestamp, confirmed to
 * microsecond equality across a multi-item completion in Step 4. Grouping is
 * therefore exact string equality, never a rounded or bucketed time window,
 * which would fuse genuinely separate actions that happened to land close
 * together. Input must already be sorted newest-first.
 */
export function groupRemovalsByAction(removals) {
  const groups = [];
  for (const removal of removals) {
    const current = groups[groups.length - 1];
    if (
      current &&
      current.removedAt === removal.removedAt &&
      current.reason === removal.reason
    ) {
      current.rows.push(removal);
    } else {
      groups.push({
        removedAt: removal.removedAt,
        reason: removal.reason,
        rows: [removal],
      });
    }
  }
  return groups;
}
