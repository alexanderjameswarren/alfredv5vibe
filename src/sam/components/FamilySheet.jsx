import React, { useEffect } from "react";
import { Play, X, LineChart, Plus } from "lucide-react";
import { formatDuration, formatLastPracticed } from "../lib/samFormat";

// Modal sheet listing every member of a family regardless of recency.
// Opened by tapping a card heading or the `All {n} versions →` link on
// ContinueSection.
//
// Order (spec §FamilySheet):
//   1. Original (family.root)
//   2. Simplified variants, difficulty_tier ascending
//   3. Drills, most-recently-practiced first
//
// Never-practiced members render muted but stay playable — spec explicitly
// says "visible and playable, but visibly untouched." Distinguishes items
// the user has actually engaged with from ones that are still greenfield.
//
// Scroll preservation: this is a modal overlay, not a route change, so the
// landing page underneath keeps its scroll position naturally.

function orderedMembers(family) {
  // family.simplified is already tier-asc-then-title-asc from useSongLibrary.
  // family.drills is already lastPracticedAt-desc-then-title-asc.
  return [family.root, ...family.simplified, ...family.drills];
}

function pillFor(member) {
  if (member.song_type === "simplified") {
    return member.difficulty_tier
      ? `variant · tier ${member.difficulty_tier}`
      : "variant";
  }
  if (member.song_type === "drill") return "drill";
  return null;
}

function SheetRow({ member, onLoad }) {
  const played = !!member.lastPracticedAt;
  const pill = pillFor(member);
  return (
    <button
      onClick={() => onLoad(member)}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left transition-colors min-h-[52px] ${
        played ? "hover:bg-secondary/60" : "hover:bg-secondary/40"
      }`}
    >
      <span
        className={`inline-flex items-center justify-center w-10 h-10 rounded-full flex-shrink-0 transition-colors ${
          played
            ? "border border-primary text-primary"
            : "border border-border text-muted-foreground"
        }`}
        aria-hidden="true"
      >
        <Play className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span
          className={`font-medium block truncate ${
            played ? "text-dark" : "text-muted-foreground"
          }`}
        >
          {member.title}
        </span>
        <span className="text-xs text-muted-foreground">
          {played
            ? `${formatLastPracticed(member.lastPracticedAt)} · ${formatDuration(
                member.totalSeconds
              )}`
            : "never played"}
        </span>
      </span>
      {pill && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex-shrink-0">
          {pill}
        </span>
      )}
    </button>
  );
}

export default function FamilySheet({
  family,
  onClose,
  onLoad,
  onStats,
  onNewDrill,
}) {
  // Close on Escape. Effect only runs while a family is open — no listener
  // hanging around when the sheet isn't rendered.
  useEffect(() => {
    if (!family) return undefined;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [family, onClose]);

  if (!family) return null;

  const members = orderedMembers(family);

  return (
    // Full-viewport backdrop; tap outside the sheet to dismiss. Standard
    // modal pattern — used elsewhere in SAM for the song-edit dialog.
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={`${family.root.title} — family`}
      >
        {/* Header — family title + close */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-dark truncate">
              {family.root.title}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              {members.length} {members.length === 1 ? "version" : "versions"}
              {family.lastPracticedAt
                ? ` · last practiced ${formatLastPracticed(family.lastPracticedAt)}`
                : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
            title="Close"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Member list — scrolls when tall */}
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex flex-col">
            {members.map((m) => (
              <SheetRow key={m.id} member={m} onLoad={onLoad} />
            ))}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 p-3 border-t border-border">
          <button
            onClick={() => onStats(family)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded border border-border text-sm text-dark hover:bg-secondary/60 min-h-[44px]"
          >
            <LineChart className="w-4 h-4" />
            Practice history
          </button>
          <button
            onClick={() => onNewDrill(family)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded border border-border text-sm text-dark hover:bg-secondary/60 min-h-[44px]"
          >
            <Plus className="w-4 h-4" />
            New drill from this
          </button>
        </div>
      </div>
    </div>
  );
}
