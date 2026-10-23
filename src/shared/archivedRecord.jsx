import React from "react";
import { ArchiveRestore } from "lucide-react";
import { PILL_CLASS } from "./StatusPill";
import { ACTION_BUTTON } from "./actionButton";

// Bug mvjx4363b4bn4gezrys (Restructure P5): an archived record's page shows the
// archived flag and offers Restore as its only action. One piece, used by the
// item, intention and group detail pages.

/** The "Archived" pill, beside the record's (read-only) status. */
export function ArchivedPill() {
  return (
    <span data-archived="" className={PILL_CLASS}>
      Archived
    </span>
  );
}

/** "This item is archived." under the title. `noun`: item, intention, menu, … */
export function ArchivedNotice({ noun }) {
  return (
    <p role="status" className="mt-2 text-sm text-muted-foreground">
      This {noun} is archived.
    </p>
  );
}

/** When a row was archived: archived_at (migration 152), else updated_at for a row not yet backfilled. */
export function archivedAt(row) {
  return row?.archivedAt || row?.updatedAt || "";
}

/** Sort comparator: newest archive first. */
export function byNewestArchive(a, b) {
  return String(archivedAt(b)).localeCompare(String(archivedAt(a)));
}

/** "Archived Oct 23, 2026", or null with no date. */
export function archivedOnLabel(row) {
  const d = new Date(archivedAt(row));
  return archivedAt(row) && !Number.isNaN(d.getTime())
    ? `Archived ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
    : null;
}

/** The one ActionBar entry an archived record gets: Restore, neutral, ArchiveRestore icon. */
export function restoreAction(onClick) {
  return {
    key: "restore",
    menu: { label: "Restore", icon: ArchiveRestore, onClick },
    button: (
      <button onClick={onClick} className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}>
        <ArchiveRestore className="w-4 h-4" />
        Restore
      </button>
    ),
  };
}
