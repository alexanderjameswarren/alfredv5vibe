/**
 * Marks a collection row's tag button.
 *
 * Two things read it: the button handles its own switch on the press, and the
 * outside-tap dismissal skips any press that lands on one. See both.
 */
export const TAG_TOGGLE_ATTR = "data-tag-toggle";

/**
 * The three screens that share one `filterTag`, and therefore the three between
 * which it must NOT travel (spec §A5).
 *
 * Filtering Memories to "beans" and then opening a context page used to arrive
 * with "beans" still applied. On a context whose items happen to carry no tags
 * at all that is worse than untidy: `TagFilter` renders nothing when no tag is
 * in use — no pills, and no Clear — so the list came back filtered to empty
 * with no visible cause and no way out. Clearing on arrival removes the
 * inheritance, and with it the trap.
 *
 * `collections` is deliberately absent. Collection detail filters on
 * `collectionFilterTag`, a separate value over a separate vocabulary — see the
 * comment on its declaration.
 */
export const TAG_FILTERED_VIEWS = ["intentions", "memories", "context-detail"];
