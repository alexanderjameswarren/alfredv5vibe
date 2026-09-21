import React from "react";

// The tag filter bar: one pill per tag in use, with its count, on the four
// screens that carry it — the Intentions list, the Memories list, collection
// detail, and the Items accordion on context detail.
//
// Lived inside src/Alfred.jsx until 2026-09-21, when it moved here as a PURE
// MOVE — identical rendering, identical props, identical behaviour — so that
// the collapse-on-typing work could land on a component that has tests of its
// own. It sits beside TagPicker deliberately: one is how you attach a tag, the
// other is how you find things already wearing one.
//
// ─── Where the tags come from ────────────────────────────────────────────────
//
// Counted here, from the rows the caller hands over. There is no query and no
// RPC, so the bar is already scoped to whatever that screen is showing, and
// archived rows never reach it because each caller filters them out first.
//
// That also means the counts are of TAGGED ROWS in the list you are looking at,
// not of anything global. "soup (9)" on the Recipes page means nine of the
// recipes in front of you, not nine in the database.
//
// ─── Ordering: alphabetical, not by frequency (2026-09-21) ───────────────────
//
// This used to sort by count descending with NO tie-break, which meant every
// tag sharing a count landed in row order — an order that is not stable between
// renders and means nothing to the person reading it. On the Recipes page that
// is most of the bar: the counts bunch up in ones and twos, so the pills
// effectively shuffled.
//
// Alphabetical is the one order you can search with your eyes. Knowing that
// "italian" sits between "indian" and "lentils" is worth more than knowing it
// is the fourth most used, because you arrive at this bar already knowing which
// tag you want — you are looking for it, not browsing.
//
// `localeCompare` rather than `<`, so accented tags sort where a reader expects
// rather than after "z" (normaliseTag preserves accents — "café" is a legal
// tag).
//
// NOT the same decision as `tagPoolFrom` in Alfred.jsx, which orders the tag
// PICKER's suggestions and stays frequency-first on purpose. That list is for
// choosing a tag you have not named yet, where the ones you reach for most
// belong under your thumb; this one is for finding a tag you have already
// named. If you are here to make them agree, read the note on `tagPoolFrom`
// first — the difference is the point.
//
// ─── Props ───────────────────────────────────────────────────────────────────
//
// `entities`  rows to count tags from; each may carry a `tags` array or not.
// `activeTag` the tag currently filtering, or null.
// `onFilter`  called with a tag to apply it, or null to clear. Tapping the
//             active tag calls it with null, so a pill is its own toggle.
//
// Renders nothing at all when no tag is in use — an empty bar would be a gap
// above the list with nothing to say.
export default function TagFilter({ entities, activeTag, onFilter }) {
  const tagCounts = {};
  for (const entity of entities) {
    if (entity.tags) {
      for (const tag of entity.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  const sortedTags = Object.entries(tagCounts).sort((a, b) => a[0].localeCompare(b[0]));

  if (sortedTags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {sortedTags.map(([tag, count]) => (
        <button
          key={tag}
          onClick={() => onFilter(activeTag === tag ? null : tag)}
          className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
            activeTag === tag
              ? "bg-primary text-white"
              : "bg-warning-light text-accent-foreground hover:bg-accent/80"
          }`}
        >
          {tag} ({count})
        </button>
      ))}
      {activeTag && (
        <button
          onClick={() => onFilter(null)}
          className="px-3 py-1.5 text-sm rounded-full bg-secondary text-muted-foreground hover:bg-secondary"
        >
          Clear
        </button>
      )}
    </div>
  );
}
