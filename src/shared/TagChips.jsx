import React, { useLayoutEffect, useRef, useState } from "react";
import StatusPill from "./StatusPill";
import ObjectIcon from "./ObjectIcon";

const TAG = "px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full whitespace-nowrap shrink-0";
const MORE = "px-2 py-0.5 bg-secondary/50 text-muted-foreground text-xs rounded-full whitespace-nowrap shrink-0";
const GAP = 8; // gap-2
// Where widths cannot be measured (no ResizeObserver, or nothing laid out yet).
export const FALLBACK_TAGS = 2;

/**
 * How many tags fit in `width`, given each tag's width and the width of the
 * "+N more" chip for each N. Pure, so the rule is tested without a browser.
 */
export function tagsThatFit(width, tagWidths, moreWidth) {
  const total = tagWidths.reduce((sum, w, i) => sum + w + (i ? GAP : 0), 0);
  if (total <= width) return tagWidths.length;
  let used = 0;
  for (let n = 0; n < tagWidths.length; n++) {
    const next = used + (n ? GAP : 0) + tagWidths[n];
    const hidden = tagWidths.length - (n + 1);
    if (next + GAP + moreWidth(hidden) > width) return n;
    used = next;
  }
  return tagWidths.length;
}

/**
 * The narrowest the tag area may be: one tag, plus "+N more" when there are
 * others. Line 2's context label shrinks to leave this much, so a row with a tag
 * always shows at least one.
 */
export function minTagWidth(tagWidths, moreWidth) {
  if (tagWidths.length === 0) return 0;
  return tagWidths[0] + (tagWidths.length > 1 ? GAP + moreWidth : 0);
}

/**
 * A row's tags. Plain: the first three, then "+N more", wrapping with the
 * container. `fit` (row line 2, Restructure P4): one line, as many tags as the
 * width allows, the rest in "+N more"; measured with ResizeObserver.
 */
export default function TagChips({ tags = [], fit = false }) {
  if (!fit) {
    return (
      <>
        {tags.slice(0, 3).map((tag) => (
          <span key={tag} className={TAG}>{tag}</span>
        ))}
        {tags.length > 3 && <span className={MORE}>+{tags.length - 3} more</span>}
      </>
    );
  }
  return <FittedTags tags={tags} />;
}

/**
 * Row line 2 (Restructure P4): status chip, context label, tags, on ONE line.
 * The chip never shrinks; the context label stops at a maximum width with "…";
 * the tags take what is left.
 */
export function RowMetaLine({ statusRow, contextName, tags = [] }) {
  return (
    <div className="flex flex-nowrap items-center gap-2 mt-1 min-w-0">
      <span className="shrink-0 whitespace-nowrap">
        <StatusPill row={statusRow} />
      </span>
      {contextName && (
        <span
          title={contextName}
          // Shrinks (to 3.5rem at least) so the tags keep room for one tag.
          className="inline-flex items-center gap-1 min-w-[3.5rem] max-w-[45%] text-xs bg-warning-light text-foreground px-2 py-0.5 rounded"
        >
          <ObjectIcon type="context" className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{contextName}</span>
        </span>
      )}
      <TagChips tags={tags} fit />
    </div>
  );
}

function FittedTags({ tags }) {
  const boxRef = useRef(null);
  const measureRef = useRef(null);
  const [shown, setShown] = useState(Math.min(tags.length, FALLBACK_TAGS));
  const [minWidth, setMinWidth] = useState(0);
  const key = tags.join("\u0000");

  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure || typeof ResizeObserver === "undefined") {
      setShown(Math.min(tags.length, FALLBACK_TAGS));
      return undefined;
    }
    const fitNow = () => {
      const width = box.clientWidth;
      const chips = [...measure.querySelectorAll("[data-tag]")].map((el) => el.offsetWidth);
      const more = measure.querySelector("[data-more]")?.offsetWidth || 0;
      if (!width || chips.some((w) => !w)) {
        setShown(Math.min(tags.length, FALLBACK_TAGS));
        return;
      }
      setMinWidth(minTagWidth(chips, more) + 1); // +1: offsetWidth rounds
      // "+N more" is measured at its widest N; close enough for every smaller N.
      setShown(tagsThatFit(width, chips, (n) => (n > 0 ? more : 0)));
    };
    fitNow();
    const observer = new ResizeObserver(fitNow);
    observer.observe(box);
    return () => observer.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const hidden = tags.length - shown;
  return (
    <span
      ref={boxRef}
      style={minWidth ? { minWidth } : undefined}
      className="relative flex-1 min-w-0 flex flex-nowrap items-center gap-2 overflow-hidden"
    >
      {tags.slice(0, shown).map((tag) => (
        <span key={tag} className={TAG}>{tag}</span>
      ))}
      {hidden > 0 && <span className={MORE}>+{hidden} more</span>}
      {/* Off-screen copy, for widths only. */}
      <span ref={measureRef} aria-hidden="true" className="absolute invisible flex gap-2 left-0 top-0 w-max pointer-events-none">
        {tags.map((tag) => (
          <span key={tag} data-tag className={TAG}>{tag}</span>
        ))}
        <span data-more className={MORE}>+{tags.length} more</span>
      </span>
    </span>
  );
}
