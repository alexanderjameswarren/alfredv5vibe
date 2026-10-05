import React from "react";
import ObjectIcon from "./ObjectIcon";

/**
 * The metadata under a detail view's title: which context the record lives in,
 * and its tags. One component so the item and intention pages cannot drift.
 *
 * The context is PLAIN TEXT behind the context glyph, not a pill. It used to be
 * a rounded `bg-warning-light` badge — the same fill, size and very nearly the
 * same shape as a tag chip — so the one thing in the header that was not a tag
 * was the thing that looked most like one. The glyph is the same `FolderOpen`
 * the Contexts list puts beside a context row, which is what makes this read as
 * a location rather than a label someone attached.
 *
 * Tags render in FULL. The list-view cards stop at three and add "+N more"
 * because they are summaries competing for room on a crowded row; a detail view
 * is the page you opened in order to see everything, so there is nothing left
 * to abbreviate for. The chip styling is copied from those cards deliberately —
 * a tag should look like a tag wherever you meet it.
 *
 * Display only. Editing tags stays in the edit form until the tag picker lands.
 *
 * Renders nothing when there is neither a context nor a tag, rather than an
 * empty row that reads as a gap under the title.
 */
export default function DetailMeta({ contextName, tags }) {
  const shown = Array.isArray(tags) ? tags : [];
  if (!contextName && shown.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {contextName && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ObjectIcon type="context" className="w-4 h-4 text-primary" />
          <span className="min-w-0 break-words">{contextName}</span>
        </p>
      )}
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shown.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
