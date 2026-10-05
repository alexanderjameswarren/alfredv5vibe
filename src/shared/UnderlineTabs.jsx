/**
 * Alfred's underline tabs — Clipboard Step 21b, compressed in 21c.
 *
 * One row of tab buttons under a hairline, the selected one carrying a brown underline.
 * Three screens use it: Home's Active / Paused / Today, the Recycle Bin's eight record
 * types, and the Inbox's source filter.
 *
 * ── Why it is a component ────────────────────────────────────────────────────
 *
 * It was the same eight-class string written out in two places, once by hand three times
 * over and once through a `.map`. Nothing held them together, which is the same shape of
 * problem `EditCard` and `PinnedFooter` were extracted to close — and the inbox would
 * have been a third copy.
 *
 * ── Why the inbox uses tabs and not pills ────────────────────────────────────
 *
 * The source filter WAS `TagFilter`, reusing the tag pills. It worked and it read wrong:
 * the pills sat directly above cards carrying real tag pills, so two different things
 * looked identical. Tabs say "this is a view of one list" rather than "this is a property
 * of these rows", which is what the source filter actually is.
 *
 * ── Narrow screens: compress, do not scroll (Step 21c) ───────────────────────
 *
 * The row used to be `overflow-x-auto`, which hides tabs off the right edge — and a tab
 * you have to discover by swiping is not one tap away.
 *
 * So it compresses the way the TOP NAVIGATION already does, at the same breakpoint and
 * by the same rule: **below `lg` a tab shows only its icon and its count**, with the full
 * name kept as `title` and `aria-label` so the accessible name survives. The nav carries
 * ten destinations from 640px up this way (`hidden lg:inline` on its labels); this is
 * that decision reused rather than a second one invented beside it.
 *
 * The count survives the label deliberately, again following the nav: an inbox glyph on
 * its own says nothing about whether there is anything in it.
 *
 * ⚠️ ONLY A TAB WITH AN ICON COMPRESSES. Without one there would be nothing left to
 * show — a bare count, or on the Recycle Bin's tabs, which have no counts either,
 * nothing at all. So a label with no icon beside it always shows, which is what keeps
 * Home and the Recycle Bin exactly as they were.
 *
 * `flex-wrap` is the safety net under all of it, as it is on the nav: if a row still
 * cannot fit, it takes a second line rather than clipping a tab off the end. A wrapped
 * tab is still reachable; a clipped one is not.
 */

/**
 * @param {Array} tabs
 *   `{ key, label, count?, icon? }`. `count` is rendered after the label and omitted only
 *   when undefined — the Recycle Bin's tabs have no counts, while "All (0)" on an empty
 *   inbox is the truth. `icon` is a lucide component; supplying one opts that tab into
 *   compressing below `lg`.
 * @param {string}   activeKey  Which tab is selected.
 * @param {Function} onSelect   Called with a tab's key.
 * @param {string}   [ariaLabel] Names the group for a screen reader.
 * @param {string}   [className] Layout only — the gap between tabs and the margin below.
 */
export default function UnderlineTabs({
  tabs,
  activeKey,
  onSelect,
  ariaLabel,
  className = "gap-6 mb-4",
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex flex-wrap border-b border-border ${className}`}
    >
      {tabs.map(({ key, label, count, icon: Glyph }) => {
        const active = key === activeKey;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(key)}
            // Both, and both always: the label is HIDDEN at narrow widths rather than
            // removed, so the accessible name has to come from somewhere that survives —
            // and the title is what tells a mouse user what a lone glyph means.
            title={label}
            aria-label={label}
            className={`inline-flex items-center gap-1.5 pb-2 border-b-2 whitespace-nowrap cursor-pointer transition-colors ${
              active
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {Glyph && <Glyph className="w-4 h-4 shrink-0" aria-hidden="true" />}
            {/* A tab with no icon keeps its label at every width; there would be nothing
                left of it otherwise. */}
            <span className={Glyph ? "hidden lg:inline" : undefined}>{label}</span>
            {count !== undefined && <span className="tabular-nums">({count})</span>}
          </button>
        );
      })}
    </div>
  );
}
