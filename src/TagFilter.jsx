import React from "react";
import { ChevronDown } from "lucide-react";

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
// ─── Collapsing, so the results are visible while typing (2026-09-21) ────────
//
// On the Recipes page this bar is 22 pills — six or seven wrapped rows on a
// phone. Type in the search box underneath it and the matches are pushed off
// screen: you are searching blind, watching the tags you are not using.
//
// So typing collapses it. The caller decides when — this component only
// renders the state it is handed. See `Alfred`'s `listTagsCollapsed`.
//
// CLEARING THE SEARCH BOX DOES NOT BRING IT BACK. Expanding is always a
// deliberate tap. A bar that sprang back the instant the box emptied would
// shove the list down again exactly when you had finished reading it, and a
// backspace is not a request to see the tags.
//
// ─── What survives a collapse ────────────────────────────────────────────────
//
// The toggle, and — if a filter is on — the active tag and Clear. That is the
// whole point: a filter you cannot see is a list silently emptied with no
// visible cause. The active pill answers "why am I looking at three recipes"
// and Clear is the way out, so both stay whatever else is hidden.
//
// The active pill is shown even when NO visible row carries that tag (Alex,
// 2026-09-21). That is precisely the case where the list is emptiest and the
// question is loudest, so hiding the pill there would defeat it. The count is
// dropped rather than printed as "(0)", because the pill is answering "what is
// filtering this", not "how many matched".
//
// ─── A small bar does not collapse at all (2026-09-21) ───────────────────────
//
// See COLLAPSE_MIN_TAGS. Below it there is no toggle and every pill always
// shows. The check is HERE, in the render, not in `collapseOnSearch` — read the
// note on that function for why, and for what the difference buys.
//
// ─── Props ───────────────────────────────────────────────────────────────────
//
// `entities`           rows to count tags from; each may carry a `tags` array.
// `activeTag`          the tag currently filtering, or null.
// `onFilter`           called with a tag to apply it, or null to clear. Tapping
//                      the active tag calls it with null, so a pill is its own
//                      toggle.
// `collapsed`          render only the toggle, plus the active filter if there
//                      is one. Ignored unless `onToggleCollapsed` is supplied.
// `onToggleCollapsed`  called with no arguments to flip that state. Its ABSENCE
//                      is what hides the toggle entirely, which is how a caller
//                      opts out of collapsing — and why `collapsed` alone can
//                      never strand you in a bar with no way to reopen it.
//
// Renders nothing at all when no tag is in use AND nothing is filtering — an
// empty bar would be a gap above the list with nothing to say.
//
// An active filter is always something to say, though, so it keeps the bar
// alive on its own (Step 4b, 2026-09-21). Archive the last tagged row while
// filtered to its tag and every count disappears; the bar used to go with them,
// taking `Clear` along, on the one screen where the list is emptiest. The rule
// decided at Step 2b — a filter that is still filtering must stay visible — now
// holds everywhere rather than almost everywhere.
/**
 * How many distinct tags a bar needs before it is allowed to collapse at all.
 *
 * Below this there is no toggle and every pill always shows. A `Tags (2)`
 * control that hides two pills saves nothing and adds a thing to look at — and
 * on collection detail, which has no search box, nothing could ever collapse
 * that bar anyway, so the toggle's only possible purpose would be to undo
 * itself.
 *
 * FOUR, because three pills fit on one row on a phone. Collapsing a one-row bar
 * cannot save a row: the toggle would simply occupy the row it was meant to
 * free, and you would end up tapping to reveal what was already in front of
 * you. At four the bar can wrap, so there is something to win. Alex's grocery
 * collection carries two tags, which is the case that prompted this.
 *
 * Exported so the tests assert against the same number the component uses,
 * rather than a copy of it that can drift.
 */
export const COLLAPSE_MIN_TAGS = 4;

/**
 * The collapse-on-typing rule, as a pure function over the whole
 * page-keyed map, so `Alfred` and its tests run the SAME code.
 *
 * It lives here rather than inline in `setSearchFor` because of the lesson
 * written at the top of executionColdLoad.test.jsx: `Alfred` cannot be rendered
 * in a test, and a harness that reproduces a rule instead of importing it stays
 * green while the shipping code drifts away from it. Exporting the rule is what
 * lets `TagFilter.test.jsx` test the real one.
 *
 * Two rules, and the second is the one people get wrong:
 *
 *   1. A non-empty search value collapses that page's bar.
 *   2. An EMPTY one changes nothing. Clearing the box does not reopen the bar,
 *      and a programmatic blanking — `viewContextDetail` empties this box when
 *      you open a different context — must not be mistaken for typing.
 *
 * Returns the SAME object when nothing changes, so React skips the re-render.
 *
 * IT DOES NOT KNOW THE TAG COUNT, and deliberately does not try to. Whether a
 * bar is too small to collapse (COLLAPSE_MIN_TAGS) is settled in the render
 * instead, for two reasons. The count is computed from `entities` inside the
 * component, and `Alfred` — which calls this — does not have it; teaching
 * `Alfred` to count tags would put a second copy of that rule in the codebase,
 * which is the twin-drift failure src/utils/tags.js opens by warning about.
 * And a decision taken once, at typing time, would go stale: the render's is
 * continuous, so a bar can never be left hidden by a `true` recorded when it
 * was bigger.
 *
 * The visible consequence: typing on a two-tag screen still records `true`
 * here, and nothing happens, because the render ignores it. If that screen
 * later grows past the threshold the bar will open collapsed. Accepted — the
 * user did type in that screen's search box, which is the gesture that means
 * collapse, and the alternative costs a duplicated counting rule.
 *
 * @param {Object} collapsedByPage current map of page name -> collapsed
 * @param {string} page           which page's search box was typed in
 * @param {string} searchValue    the box's new value
 */
export function collapseOnSearch(collapsedByPage, page, searchValue) {
  if (searchValue === "") return collapsedByPage;
  if (collapsedByPage[page]) return collapsedByPage;
  return { ...collapsedByPage, [page]: true };
}

export default function TagFilter({
  entities,
  activeTag,
  onFilter,
  collapsed = false,
  onToggleCollapsed,
}) {
  const tagCounts = {};
  for (const entity of entities) {
    if (entity.tags) {
      for (const tag of entity.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  const sortedTags = Object.entries(tagCounts).sort((a, b) => a[0].localeCompare(b[0]));

  // Nothing to say and nothing filtering: render nothing rather than a gap.
  //
  // A FILTER STILL FILTERING IS ALWAYS SOMETHING TO SAY (§A3, Step 4b). Archive
  // the last tagged row on a screen while filtered to its tag and every count
  // vanishes — which used to take the whole bar with it, `Clear` included, on
  // the one screen where the list is emptiest and the question "why is there
  // nothing here" is loudest. So an active tag alone keeps the bar alive.
  if (sortedTags.length === 0 && !activeTag) return null;

  // Two conditions, and `isCollapsed` hangs off both — which is what makes a
  // hidden bar with no way to reopen it impossible rather than merely unlikely.
  //
  //   No handler: nothing could reopen it, so it must never close.
  //   Too few tags: collapsing would cost a row rather than save one.
  //
  // Because this is recomputed every render, a bar whose tag count DROPS below
  // the threshold while it is collapsed simply opens again — `canToggle` goes
  // false, `isCollapsed` follows, and every pill is back. The stored `true` is
  // left alone and starts mattering again only if the bar grows.
  const canToggle =
    typeof onToggleCollapsed === "function" && sortedTags.length >= COLLAPSE_MIN_TAGS;
  const isCollapsed = collapsed && canToggle;
  const activeCount = activeTag ? tagCounts[activeTag] : undefined;

  // Two ways the active tag ends up standing on its own: the bar is collapsed,
  // or there are no pills left to stand among. Both render the same thing.
  //
  // NOT the same as an active tag that is merely absent from a bar which still
  // has pills — filter to "beans", archive the last beans row, and a screen
  // with other tags keeps showing those plus `Clear`. That case was decided at
  // Step 2b and is deliberately unchanged here; `Clear` is enough when there is
  // still a bar to read. This is only about there being no bar at all.
  const onlyActivePill = isCollapsed || sortedTags.length === 0;

  const pillClass = (isActive) =>
    `px-3 py-1.5 text-sm rounded-full transition-colors ${
      isActive
        ? "bg-primary text-white"
        : "bg-warning-light text-accent-foreground hover:bg-accent/80"
    }`;

  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {/* First, so it is in the same place whether the bar is open or shut —
          you can reach for it without reading the row. */}
      {canToggle && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "Show tags" : "Hide tags"}
          className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-secondary text-muted-foreground hover:text-dark transition-colors"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 shrink-0 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
            aria-hidden="true"
          />
          Tags ({sortedTags.length})
        </button>
      )}
      {onlyActivePill
        ? activeTag && (
            <button
              type="button"
              onClick={() => onFilter(null)}
              className={pillClass(true)}
            >
              {activeTag}
              {activeCount === undefined ? "" : ` (${activeCount})`}
            </button>
          )
        : sortedTags.map(([tag, count]) => (
            <button
              key={tag}
              onClick={() => onFilter(activeTag === tag ? null : tag)}
              className={pillClass(activeTag === tag)}
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
