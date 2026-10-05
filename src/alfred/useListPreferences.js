import { useState } from "react";
import { useSortPreference } from "../shared/SortControl";
import { collapseOnSearch } from "../shared/TagFilter";
import {
  EVENT_SORT_OPTIONS,
  INBOX_SORT_OPTIONS,
  NAMED_RECORD_SORT_OPTIONS,
  INTENTION_SORT_OPTIONS,
} from "../utils/listSortOptions";

// Per-page sort, search and tag-bar state, moved out of Alfred.jsx unchanged and
// called where it was, so the eight sort-preference effects keep their place.
export function useListPreferences() {
  // --- List sort preferences (Step 9b) --------------------------------------
  //
  // One key per page, each persisting independently — changing the Inbox order
  // must not reorder Schedule. Called unconditionally at the top level: Alfred
  // renders every screen from one component, so these are not conditional even
  // though only one list is on screen at a time.
  //
  // Home's is named for the page but governs its **Today tab only**. Active and
  // Paused render ExecutionBadge, are ordered by `started_at` descending from
  // the database, and have none of these fields; the control is rendered inside
  // the Today panel rather than above the tab bar so it cannot imply otherwise.
  // Same reasoning that excluded those two tabs from the row strips in Step 8a.
  const homeSort = useSortPreference("alfred.sort.home", EVENT_SORT_OPTIONS, "time");
  const scheduleSort = useSortPreference("alfred.sort.schedule", EVENT_SORT_OPTIONS, "time");
  const inboxSort = useSortPreference("alfred.sort.inbox", INBOX_SORT_OPTIONS, "created");
  const contextsSort = useSortPreference("alfred.sort.contexts", NAMED_RECORD_SORT_OPTIONS, "title");
  const collectionsSort = useSortPreference("alfred.sort.collections", NAMED_RECORD_SORT_OPTIONS, "title");
  // Step 12.8. Own keys, independent of the other five — changing the Intentions
  // order must not reorder Memories.
  //
  // Both default to "Last modified, newest first". For Intentions that is Alex's
  // call. For Memories it is a judgement: it is a list of ITEMS, and the only
  // other list of items in the app — Context detail's Items — has always been
  // ordered that way. 12.3 also established that a newly touched record is
  // expected at the top, which is the same instinct. Name was the alternative,
  // for consistency with Contexts and Collections, which share this option set;
  // it lost because those two are things you look up and this is a holding pen
  // for what has not been filed yet.
  const intentionsSort = useSortPreference("alfred.sort.intentions", INTENTION_SORT_OPTIONS, "updated");
  const memoriesSort = useSortPreference("alfred.sort.memories", NAMED_RECORD_SORT_OPTIONS, "updated");
  // Context detail: ONE control for all three of its lists. Items and
  // Intentions offer identical choices — only what "Name" reads differs — so a
  // single row drives Items, Intentions and Collections alike. The default is
  // the order Items always had here; Intentions and Collections had none.
  const contextDetailSort = useSortPreference("alfred.sort.context-detail", NAMED_RECORD_SORT_OPTIONS, "updated");

  // Per-page search text, keyed by page. In memory only, unlike the sort
  // preference: it survives opening a record and pressing Back — the text is
  // still visible in the box, so nothing is filtered invisibly — and a reload
  // clears it.
  const [listSearch, setListSearch] = useState({});
  const searchFor = (page) => listSearch[page] || "";
  const setSearchFor = (page) => (value) => {
    setListSearch((prev) => ({ ...prev, [page]: value }));
    // Typing collapses that page's tag bar, so the results are visible while
    // you type — the whole point of the change. The rule itself lives in
    // TagFilter.jsx so the tests can import it rather than reproduce it; it is
    // the one that knows an empty value must change nothing.
    setListTagsCollapsed((prev) => collapseOnSearch(prev, page, value));
  };

  // Which pages have their tag bar collapsed. A sibling of `listSearch` in every
  // respect — same keys, same top-level owner, same lifetime: it survives
  // opening a record and pressing Back, and a reload clears it. Absent means
  // EXPANDED, so `{}` is the state a fresh load starts in.
  //
  // Matches search rather than sort on purpose. A collapsed tag bar is a fact
  // about the sitting you are in, like the text in the box above it — not a
  // preference about how you like Alfred to look, which is what the localStorage
  // sort keys are for. `/contexts/detail` also carries no context id in its URL,
  // so a reload does not land you back on the page anyway.
  //
  // `collection-detail` is a key here but NOT in `listSearch`: that view has no
  // search box, so its bar only ever collapses by hand.
  const [listTagsCollapsed, setListTagsCollapsed] = useState({});
  const tagsCollapsedFor = (page) => !!listTagsCollapsed[page];
  const toggleTagsFor = (page) => () =>
    setListTagsCollapsed((prev) => ({ ...prev, [page]: !prev[page] }));

  return {
    homeSort,
    scheduleSort,
    inboxSort,
    contextsSort,
    collectionsSort,
    intentionsSort,
    memoriesSort,
    contextDetailSort,
    searchFor,
    setSearchFor,
    tagsCollapsedFor,
    toggleTagsFor,
  };
}
