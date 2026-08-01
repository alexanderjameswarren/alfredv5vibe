import React from "react";
import { Play } from "lucide-react";
import { formatDuration, formatLastPracticed } from "../lib/samFormat";

// The two-card "Continue" strip at the top of the SAM landing page.
//
// Selection: the two most recently practiced distinct families (already
// resolved upstream — `useSongLibrary` returns `recentFamilies` sorted
// desc, capped at 2). Each card lists every family member practiced
// within 72 HOURS of THAT FAMILY'S OWN `lastPracticedAt` — not of `now()`.
// This is deliberate: a family last practiced four days ago should still
// show that day's sitting reconstructed, not zero variants.
//
// Row cap: 3. Overflow renders "All {n} versions →" (opens FamilySheet
// in Milestone 4). A family with only its root practiced in the window
// renders a single row — visually balanced, not an empty state.
//
// Row 1 is the resume target (accent-filled play button). Subsequent
// rows get an outline button. Whole row is tappable; the play button is
// inside the row's <button>, so a single click loads that member.

const WINDOW_HOURS = 72;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;
const ROW_CAP = 3;

// Return the family members practiced within WINDOW_HOURS of the family's
// own last-practice timestamp, sorted most-recent-first. `family.root`,
// `family.simplified[*]`, `family.drills[*]` are the candidate members;
// only those with a `lastPracticedAt` inside the window qualify.
function recentMembers(family) {
  const anchor = new Date(family.lastPracticedAt).getTime();
  const cutoff = anchor - WINDOW_MS;
  const members = [family.root, ...family.simplified, ...family.drills];
  return members
    .filter(
      (m) =>
        m.lastPracticedAt &&
        new Date(m.lastPracticedAt).getTime() >= cutoff
    )
    .sort((a, b) => (a.lastPracticedAt > b.lastPracticedAt ? -1 : 1));
}

function totalFamilySize(family) {
  return 1 + family.simplified.length + family.drills.length;
}

// Type pill for non-original members. Original songs render without a pill
// — the family root is usually the original, and rows should read clean.
function pillFor(member) {
  if (member.song_type === "simplified") {
    return member.difficulty_tier
      ? `variant · tier ${member.difficulty_tier}`
      : "variant";
  }
  if (member.song_type === "drill") return "drill";
  return null;
}

function ContinueRow({ member, isPrimary, onLoad }) {
  const pill = pillFor(member);
  return (
    <button
      onClick={() => onLoad(member)}
      className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-secondary/60 transition-colors min-h-[52px]"
    >
      <span
        className={`inline-flex items-center justify-center w-10 h-10 rounded-full flex-shrink-0 transition-colors ${
          isPrimary
            ? "bg-primary text-white"
            : "border border-primary text-primary"
        }`}
        aria-hidden="true"
      >
        <Play className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="font-medium text-dark block truncate">
          {member.title}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatLastPracticed(member.lastPracticedAt)} ·{" "}
          {formatDuration(member.totalSeconds)}
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

function ContinueCard({ family, onLoad, onOpenFamily }) {
  const rows = recentMembers(family);
  const shown = rows.slice(0, ROW_CAP);
  const totalSize = totalFamilySize(family);
  const hasOverflow = shown.length < totalSize;

  return (
    <section className="flex-1 min-w-0 bg-card border border-border rounded-xl p-4">
      <button
        onClick={() => onOpenFamily(family)}
        className="w-full text-left mb-2 min-h-[40px] rounded hover:bg-secondary/40 -mx-2 px-2 transition-colors"
      >
        <h3 className="text-base font-semibold text-dark truncate">
          {family.root.title}
        </h3>
      </button>
      <div className="flex flex-col">
        {shown.map((m, i) => (
          <ContinueRow
            key={m.id}
            member={m}
            isPrimary={i === 0}
            onLoad={onLoad}
          />
        ))}
      </div>
      {hasOverflow && (
        <button
          onClick={() => onOpenFamily(family)}
          className="mt-2 text-sm text-primary hover:text-primary-hover px-3 py-2 min-h-[40px] rounded hover:bg-secondary/40 transition-colors"
        >
          All {totalSize} versions →
        </button>
      )}
    </section>
  );
}

export default function ContinueSection({
  recentFamilies,
  onLoad,
  onOpenFamily,
}) {
  if (!recentFamilies || recentFamilies.length === 0) return null;

  return (
    // Side-by-side above 900px viewport, stacked below (Surface portrait +
    // any narrower device). `min-[900px]` is exact per spec § Continue-first;
    // Tailwind's md=768 would be too eager and cramp the cards on a 768px
    // tablet in portrait.
    <div className="flex flex-col min-[900px]:flex-row gap-3 mt-6">
      {recentFamilies.map((family) => (
        <ContinueCard
          key={family.root.id}
          family={family}
          onLoad={onLoad}
          onOpenFamily={onOpenFamily}
        />
      ))}
    </div>
  );
}
