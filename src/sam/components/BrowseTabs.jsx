import React, { useState } from "react";
import { Play, Plus, Pencil, Archive, ArchiveRestore } from "lucide-react";
import {
  formatDuration,
  formatLastPracticed,
  formatCreated,
} from "../lib/samFormat";

// Segmented browse control with three tabs — Recent / All songs / Drills —
// plus a right-aligned "+ Add" button. Sits below the Continue section and
// the WeekStrip. Replaces the pre-M5 flat "Your songs" + "Drills" +
// "Archived songs" sections.
//
// Data source is always `useSongLibrary` (families / allSongsFlat /
// drillsFlat / archivedFamilies). Never re-fetches on tab change — cheap
// derived-shape swap only.
//
// Tabs (spec §BrowseTabs):
//   Recent    flat, allSongsFlat, muted family prefix when child ≠ root
//             (e.g. "Someone Like You · Arpeggios")
//   All songs grouped by family — root then indented children with type
//             pills; created_at right-aligned via formatCreated. Footer
//             link toggles the same layout scoped to archivedFamilies.
//   Drills    flat, drillsFlat, every song_type='drill' regardless of
//             whether it has a parent
//
// Row height ≥ 40px (touch target — Surface tablet); action buttons ≥ 44px.

function tabClass(active) {
  return [
    "flex-1 min-h-[44px] px-3 py-2 text-sm font-medium transition-colors",
    active
      ? "bg-primary text-white"
      : "text-muted-foreground hover:text-dark hover:bg-secondary/60",
  ].join(" ");
}

function pillFor(song) {
  if (song.song_type === "simplified") {
    return song.difficulty_tier
      ? `variant · tier ${song.difficulty_tier}`
      : "variant";
  }
  if (song.song_type === "drill") return "drill";
  return null;
}

// Compact flat row used by Recent + Drills tabs. `familyPrefix` is null
// for parent-less rows and roots; a string like "Someone Like You" when
// the row is a child within a visible family, so the user can locate the
// context of the flat-listed variant/drill.
function FlatRow({ song, familyPrefix, onLoad, onEdit, onArchive }) {
  const played = !!song.lastPracticedAt;
  const pill = pillFor(song);
  return (
    <div
      onClick={() => onLoad(song)}
      className="flex items-center gap-3 w-full px-3 py-2 bg-card border border-border rounded-lg hover:bg-secondary transition-colors min-h-[52px] cursor-pointer"
    >
      <span
        className={`inline-flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0 ${
          played
            ? "border border-primary text-primary"
            : "border border-border text-muted-foreground"
        }`}
        aria-hidden="true"
      >
        <Play className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {familyPrefix && (
            <span className="text-sm text-muted-foreground truncate">
              {familyPrefix} ·
            </span>
          )}
          <span className="font-medium text-dark truncate">{song.title}</span>
          {pill && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex-shrink-0">
              {pill}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {played
            ? `${formatLastPracticed(song.lastPracticedAt)} · ${formatDuration(
                song.totalSeconds
              )}`
            : "never played"}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onEdit(song);
        }}
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-primary rounded"
        title="Edit song"
        aria-label={`Edit ${song.title}`}
      >
        <Pencil className="w-4 h-4" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onArchive(song);
        }}
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-warning rounded"
        title="Archive song"
        aria-label={`Archive ${song.title}`}
      >
        <Archive className="w-4 h-4" />
      </button>
    </div>
  );
}

// One row within a grouped family list on the All songs tab. `indent`
// shifts children right 44px per spec.
function GroupedRow({
  song,
  isChild,
  onLoad,
  onEdit,
  onAction,
  actionKind, // 'archive' | 'restore'
}) {
  const played = !!song.lastPracticedAt;
  const pill = isChild ? pillFor(song) : null;
  const createdCaption = formatCreated(song.created_at);
  const ActionIcon = actionKind === "restore" ? ArchiveRestore : Archive;
  const actionTitle = actionKind === "restore" ? "Restore song" : "Archive song";
  return (
    <div
      onClick={() => onLoad(song)}
      className={`flex items-center gap-3 w-full px-3 py-2 bg-card border border-border rounded-lg hover:bg-secondary transition-colors min-h-[52px] cursor-pointer ${
        isChild ? "ml-[44px]" : ""
      }`}
    >
      <span
        className={`inline-flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0 ${
          played
            ? "border border-primary text-primary"
            : "border border-border text-muted-foreground"
        }`}
        aria-hidden="true"
      >
        <Play className="w-4 h-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-dark truncate">{song.title}</span>
          {pill && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex-shrink-0">
              {pill}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {played
            ? `${formatLastPracticed(song.lastPracticedAt)} · ${formatDuration(
                song.totalSeconds
              )}`
            : "never played"}
        </div>
      </div>
      {createdCaption && (
        <span className="text-xs text-muted-foreground flex-shrink-0 hidden sm:inline">
          {createdCaption}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onEdit(song);
        }}
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-primary rounded"
        title="Edit song"
        aria-label={`Edit ${song.title}`}
      >
        <Pencil className="w-4 h-4" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAction(song);
        }}
        className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded ${
          actionKind === "restore"
            ? "text-muted-foreground hover:text-success"
            : "text-muted-foreground hover:text-warning"
        }`}
        title={actionTitle}
        aria-label={`${actionTitle} ${song.title}`}
      >
        <ActionIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

function GroupedList({ families, onLoad, onEdit, onAction, actionKind }) {
  if (families.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground py-8">
        Nothing here yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {families.map((family) => (
        <React.Fragment key={family.root.id}>
          <GroupedRow
            song={family.root}
            isChild={false}
            onLoad={onLoad}
            onEdit={onEdit}
            onAction={onAction}
            actionKind={actionKind}
          />
          {family.simplified.map((child) => (
            <GroupedRow
              key={child.id}
              song={child}
              isChild={true}
              onLoad={onLoad}
              onEdit={onEdit}
              onAction={onAction}
              actionKind={actionKind}
            />
          ))}
          {family.drills.map((child) => (
            <GroupedRow
              key={child.id}
              song={child}
              isChild={true}
              onLoad={onLoad}
              onEdit={onEdit}
              onAction={onAction}
              actionKind={actionKind}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

function FlatList({ items, familiesByRootId, onLoad, onEdit, onArchive }) {
  if (items.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground py-8">
        Nothing here yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {items.map((song) => {
        // Muted family prefix only when the row is a child of a visible
        // family and its own title differs from the root title. Roots and
        // stand-alone drills (no visible parent) get no prefix.
        let prefix = null;
        if (
          song.familyRootId &&
          song.familyRootId !== song.id &&
          familiesByRootId?.has(song.familyRootId)
        ) {
          prefix = song.familyRootTitle;
        }
        return (
          <FlatRow
            key={song.id}
            song={song}
            familyPrefix={prefix}
            onLoad={onLoad}
            onEdit={onEdit}
            onArchive={onArchive}
          />
        );
      })}
    </div>
  );
}

export default function BrowseTabs({
  families,
  familiesByRootId,
  allSongsFlat,
  drillsFlat,
  archivedFamilies,
  archivedCount,
  loading,
  onLoad,
  onEdit,
  onArchive,
  onRestore,
  onAddClick,
}) {
  const [tab, setTab] = useState("recent"); // 'recent' | 'all' | 'drills'
  const [showArchived, setShowArchived] = useState(false);

  return (
    <div className="mt-6">
      {/* Tab bar + Add button */}
      <div className="flex items-stretch gap-2 mb-3">
        <div className="flex-1 flex bg-secondary/40 rounded-lg overflow-hidden border border-border">
          <button
            onClick={() => setTab("recent")}
            className={tabClass(tab === "recent")}
          >
            Recent
          </button>
          <button
            onClick={() => {
              setTab("all");
              setShowArchived(false);
            }}
            className={tabClass(tab === "all")}
          >
            All songs
          </button>
          <button
            onClick={() => setTab("drills")}
            className={tabClass(tab === "drills")}
          >
            Drills
          </button>
        </div>
        <button
          onClick={onAddClick}
          className="flex items-center gap-1 px-3 min-h-[44px] rounded-lg border border-border text-sm font-medium text-dark hover:bg-secondary transition-colors"
          aria-label="Add a song"
        >
          <Plus className="w-4 h-4" />
          Add
        </button>
      </div>

      {loading ? (
        <div className="text-center text-sm text-muted-foreground py-8">
          Loading library…
        </div>
      ) : (
        <>
          {tab === "recent" && (
            <FlatList
              items={allSongsFlat}
              familiesByRootId={familiesByRootId}
              onLoad={onLoad}
              onEdit={onEdit}
              onArchive={onArchive}
            />
          )}

          {tab === "all" && (
            <>
              <GroupedList
                families={showArchived ? archivedFamilies : families}
                onLoad={onLoad}
                onEdit={onEdit}
                onAction={showArchived ? onRestore : onArchive}
                actionKind={showArchived ? "restore" : "archive"}
              />
              {(archivedCount > 0 || showArchived) && (
                <div className="mt-4 text-center">
                  <button
                    onClick={() => setShowArchived((v) => !v)}
                    className="text-sm text-muted-foreground hover:text-dark min-h-[44px] px-2"
                  >
                    {showArchived
                      ? "Hide archived songs"
                      : `View archived songs (${archivedCount})`}
                  </button>
                </div>
              )}
            </>
          )}

          {tab === "drills" && (
            <FlatList
              items={drillsFlat}
              familiesByRootId={familiesByRootId}
              onLoad={onLoad}
              onEdit={onEdit}
              onArchive={onArchive}
            />
          )}
        </>
      )}
    </div>
  );
}
