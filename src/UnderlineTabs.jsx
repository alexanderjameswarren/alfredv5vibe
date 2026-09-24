/**
 * Alfred's underline tabs — Clipboard Step 21b.
 *
 * One row of tab buttons under a hairline, the selected one carrying a brown underline.
 * Three screens use it: Home's Active / Paused / Today, the Recycle Bin's eight record
 * types, and the Inbox's source filter.
 *
 * ── Why it is a component now ────────────────────────────────────────────────
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
 * looked identical. Tabs say "this is a view of one list" rather than "this is a
 * property of these rows", which is what the source filter actually is.
 *
 * ── The scrolling row ────────────────────────────────────────────────────────
 *
 * `overflow-x-auto` is always on. The Recycle Bin has eight tabs and needed it; the
 * inbox has up to seven and needs it on a phone. It costs nothing on a row that fits.
 */

/**
 * @param {Array} tabs
 *   `{ key, label, count?, icon? }`. `count` is rendered in brackets after the label and
 *   omitted when undefined — the Recycle Bin's tabs have no counts. `icon` is a lucide
 *   component, used by the inbox's source tabs.
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
      className={`flex border-b border-border overflow-x-auto ${className}`}
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
            className={`inline-flex items-center gap-1.5 pb-2 border-b-2 whitespace-nowrap cursor-pointer transition-colors ${
              active
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {Glyph && <Glyph className="w-4 h-4 shrink-0" aria-hidden="true" />}
            {label}
            {count !== undefined && ` (${count})`}
          </button>
        );
      })}
    </div>
  );
}
