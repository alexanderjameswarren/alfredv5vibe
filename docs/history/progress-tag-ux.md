# Progress: Tag UX and Inbox Tag Storage

## Status: Steps 0-5 COMPLETE — migrated, deployed, verified. Next up: Step 6
(the enrichment skill). Change A and Change B are both finished.

Reference: `docs/technical-spec-tag-ux.md`

One step at a time. Stop after each step and wait for confirmation before
starting the next.

---

## Step 0 — COMPLETE (2026-09-21). Redeploy cancelled.

Prerequisite. Closed without deploying, because there was nothing to fix.

- [x] Confirm whether the deployed `mcp` Edge Function predates migration 039
      — **DISPROVEN.** It is current. See "Step 0 findings" below.
- [x] ~~Redeploy `supabase/functions/mcp`~~ — **CANCELLED** (Alex, 2026-09-21).
      The deployed bundle is byte-identical to repo HEAD, and the bug the
      redeploy targeted does not exist, so it would have been a no-op over
      identical code. The comment fixes below ship with Step 5, which deploys
      the `mcp` function anyway.
- [x] Fix the stale comment in `getIntents` that still says
      `intents.tags is jsonb` — done in the repo, **not deployed**
- [x] Fix the second stale jsonb comment in `getItems` — `tool-handlers.ts`,
      the comment above `const { data, error } = await query` inside
      `getItems` (~54). Approved by Alex 2026-09-21. **Comment only** — behaviour is
      untouched, because `ai-enrich` depends on it and it is out of scope here.
- [x] Verify `get_intents` with `tags: ["ai"]` returns the three tagged
      intentions — **it already does**, against the currently deployed function

### Step 0 findings

**The theory was that the deployed function predates migration 039. It does not.**

1. `supabase functions list` reports `mcp` at **version 100, updated
   2026-09-20 12:43 UTC** — today, and six days *after* the tags commit
   (`eda53e1`, 2026-09-14) that accompanied migration 039.
2. Downloaded the deployed bundle to a scratch dir and diffed it against repo
   HEAD. `mcp/index.ts`, `_shared/tags.ts` and `_shared/platform.ts` are all
   **byte-identical**. `_shared/tags.ts` was *created* by the tags commit, so
   its presence at HEAD content proves the bundle was built at or after it.
   (The extraction aborted before `_shared/alfred-tools/` — the CLI refuses to
   write the bundle's `source/src/...` entries outside `supabase/functions` —
   so that one file was not diffed directly. Three-for-three on the rest, from
   a single bundle built from a single tree, settles it.)

**`get_intents` with a tags filter is not broken either.** Against the currently
deployed function:

| Call | Result |
|---|---|
| `tags:["ai"]`, `limit:50` | **3 rows** — the three `ai` intentions |
| `tags:["ai"]`, `include_archived:true`, `limit:50` | `[]` |

The difference is the **post-limit filtering bug** already filed as out of scope
in the spec (`tool-handlers.ts`, `getIntents`, the `params.tags` filter, ~267).
`.limit()` is applied by Postgres *before* the client-side tag filter, and `clampLimit` hard-caps it at 50
whatever the caller asks. Adding archived rows to the pool pushes the three `ai`
rows past row 50, so they never reach the filter.

**Cause of the original report:** the investigation that produced this spec only
ever probed `get_intents` with `include_archived: true`, and read the resulting
empty array as a broken filter. That was my error in the prior investigation, and
the spec inherited it. The prerequisite in the spec's Overview is therefore void.

Success criterion 9 ("`get_intents` with a `tags` filter returns matching
intentions") was **already met** and needed no deploy. Deleted from the spec
2026-09-21, along with the Overview's prerequisite paragraph.

---

## Step 1 — COMPLETE (2026-09-21). Alphabetical ordering in the tag filter bar.

- [x] `TagFilter` sorts by tag name ascending using `localeCompare`, replacing
      the frequency-descending sort. At the time it sat at
      `src/Alfred.jsx:724-763` (**moved to `src/TagFilter.jsx` in Step 2a**),
      with its new docblock at `:690-723` — the old `:690-727` reference in the
      spec pointed at the function itself and is now the docblock.
- [x] Counts still render inside each pill — the pill body is untouched
- [x] All four call sites covered. They needed no edits: the sort lives inside
      `TagFilter`, and every caller reaches it. Call sites are
      `src/Alfred.jsx:6123` (intentions), `:6183` (memories), `:6466`
      (collection detail) and `:9236` (context detail, Items accordion).
      Those four shifted again in Step 2a — see that step for current numbers.

The whole behavioural change is one expression:

```js
// was: .sort((a, b) => b[1] - a[1])
const sortedTags = Object.entries(tagCounts).sort((a, b) => a[0].localeCompare(b[0]));
```

Full suite green (60 suites, 1209 tests). Production build compiles clean under
`CI=true`, warnings as errors.

### Step 1 decisions and surprises

- **`localeCompare`, not `<`.** `normaliseTag` preserves accents, so "café" is a
  legal tag; a plain comparison sorts it after "z". No locale argument passed —
  the browser default is right for a single-user app, and pinning one would be a
  guess with no evidence behind it.
- **`tagPoolFrom` stays frequency-first, deliberately.** Its docblock used to
  justify its ordering partly by saying it "matches the order `TagFilter`
  already shows its pills in" — which this change made false, so that clause is
  now a note explaining why the two deliberately differ. The picker offers a tag
  you have not named yet (common ones first); the bar helps you find one you
  already have in mind (alphabetical). A later reader will want to make them
  agree; the comment tells them not to.
- **Surprise: no test coverage exists for `TagFilter`, and I did not add any.**
  It is an unexported local function inside a 539 KB monolith, so it cannot be
  rendered in isolation without restructuring. Adding an export or extracting a
  helper purely to test a one-line sort is not worth the blast radius in that
  file. **Recommendation for Step 2:** that step adds collapse state, an
  active-filter pill and an expand control to this same component — real UI
  logic that does deserve tests. Extracting `TagFilter` into its own file
  (alongside `src/TagPicker.jsx`, which is tested) is the natural moment, and
  Step 2 is when to decide it. Flagging, not doing — Step 2 was explicitly out
  of scope here. → **ADOPTED. Alex split Step 2 into 2a (the move) and 2b (the
  collapse); 2a landed 2026-09-21 with 16 tests.**
- **No behaviour changed beyond order.** Counting, the archived exclusion, the
  Clear pill, the active-pill styling and the click handler are all untouched.
- **Every `src/Alfred.jsx` line reference in the spec was refreshed.** The new
  `TagFilter` docblock pushed everything below it down by 40 lines, which
  invalidated ~20 pointers the spec presents as verified findings — including
  all of Step 5's triage-UI line list. Each new number was checked against the
  code it claims to point at. Steps 2–5 can trust the spec's pointers again.
- **A fourth spec error, not on Alex's list.** The out-of-scope bullet blamed
  the post-limit bug on `searchItems` as well as `getIntents`, citing
  `tool-handlers.ts:60`. Both wrong, both mine: line 60 was inside `getItems`,
  which has no `.limit()` and so is unaffected, and `searchItems` has no tag
  filter at all. `getIntents` is the only affected function. Corrected in the
  spec — **the filed Alfred item probably wants narrowing to match.**

---

## Step 2a — COMPLETE (2026-09-21). Extract TagFilter, no behaviour change.

Split out of the old Step 2 (Alex, 2026-09-21) so the move can be reviewed on
its own rather than tangled up with the collapse rewrite.

- [x] `TagFilter` moved from `src/Alfred.jsx` into `src/TagFilter.jsx`, beside
      `src/TagPicker.jsx`, following that file's conventions (imports, `//`
      header block, `export default function`)
- [x] Pure move — identical rendering, identical props, identical behaviour.
      The component body is byte-for-byte what it was; only the export keyword
      and the comment style around it changed.
- [x] All four call sites resolve to the import. **They needed no textual
      edits:** the component is a default export under the same name, so
      `<TagFilter …>` at `src/Alfred.jsx:6049` (intentions), `:6109`
      (memories), `:6392` (collection detail) and `:9162` (context detail,
      Items accordion) is unchanged and now resolves to the import at `:31`.
- [x] 16 unit tests in `src/TagFilter.test.jsx`, written against behaviour as
      it stands today — the safety net for 2b
- [x] Full suite green: **61 suites, 1225 tests** (was 60 / 1209)
- [x] Production build compiles clean under `CI=true`, warnings as errors
- [x] Every `src/Alfred.jsx` line pointer in the spec refreshed and checked

### Step 2a decisions and surprises

- **Test conventions follow `TagPicker.test.jsx`, not the SAM suites.** That
  file uses plain Jest matchers only — no `@testing-library/jest-dom` — and
  reads the DOM through small helper extractors. Kept that: the central
  assertion here is "these pills, in this order, with these counts", which is
  an array comparison and reads better than a pile of `toBeInTheDocument`.
  `toBeEmptyDOMElement` was swapped for `expect(container.innerHTML).toBe("")`
  to stay inside the convention.
- **Two things noticed and deliberately NOT fixed**, per the pure-move rule.
  Both are recorded in the tests so the behaviour is pinned either way:
  1. **The count is of tag OCCURRENCES, not rows.** A row whose `tags` array
     held `["soup", "soup"]` would make the pill read one higher. Harmless
     today — `normaliseTags` dedupes on every write path, so no stored row can
     be in that shape — but the pill would lie if one ever were.
  2. **`Clear` shows for a tag no visible row carries.** Filter to "beans",
     archive the last beans row, and the bar renders the remaining tags plus
     `Clear`, with no "beans" pill. That is arguably correct — `Clear` is the
     only way back from a list filtered to nothing — but it is worth a decision
     rather than an accident, and 2b's active-filter pill will have to take a
     position on it.
- **No prop or signature changes.** `entities` / `activeTag` / `onFilter`
  exactly as before. 2b will add to this surface; 2a did not.
- **`tagPoolFrom`'s docblock updated** — it referred to `TagFilter` "above",
  which is now a different file. Pointer only; the frequency-first ordering and
  its reasoning are untouched.
- **Surprise: this file's own forward checklists were stale, and had been since
  before Step 1.** Steps 3, 4 and 5 still carried the ORIGINAL investigation
  line numbers — `4477`, `1414`, `2836`, `tool-handlers.ts:606/:689`, and the
  nine triage-UI lines — which Step 1's docblock had already invalidated and
  Step 2a shifted again. Only the spec was refreshed last session; the progress
  file was missed. All now updated and each checked against the code it points
  at, edge-function pointers included. **Both documents now agree**, which is
  the bit that matters for Step 5.
- **Line pointers are now a recurring tax.** Three sessions in a row have
  spent real effort re-deriving them, and Step 2b will shift them a fourth
  time. Not proposing anything now, but if it bites again the answer is
  probably to cite a stable anchor (a function name, a distinctive string)
  instead of a line number. → **ADOPTED. Both documents were converted to
  stable anchors before Step 2b (2026-09-21): enclosing function, plus a string
  to search for, with the line number kept only as an approximate `(~n)` hint.**

---

## Step 2b — COMPLETE (2026-09-21). Collapse the tag bar on typing.

- [x] `listTagsCollapsed` state object added as a sibling of `listSearch`
      (`Alfred`, `const [listTagsCollapsed, setListTagsCollapsed] = useState({})`,
      ~1722), keyed by the same page names plus `collection-detail`
- [x] `TagFilter` accepts `collapsed` and `onToggleCollapsed`
- [x] Typing a character into a screen's search box collapses that screen's bar
- [x] Clearing the search box does NOT auto-expand
- [x] When collapsed with a filter active, the active filter pill stays visible,
      with `Clear` beside it
- [x] When collapsed with no filter, only the toggle shows
- [x] Applied at all four call sites
- [x] Active-filter pill when the tag is no longer in the list — **decided by
      Alex 2026-09-21: show it.** The pill exists to answer "why is this list
      empty", so hiding it in the one case where the list IS empty defeats it.
- [x] All 16 existing `src/TagFilter.test.jsx` tests pass **unchanged** — not
      one needed editing. 16 new tests added on top.

Suite: **61 suites, 1241 tests** (was 61 / 1225). Build clean under `CI=true`.

### What it looks like

Expanded, the bar gains one control at the front:

    [▾ Tags (22)] [beans (9)] [beef (2)] [chicken (4)] … [vegetarian (26)]

Collapsed with a filter on, that is the whole bar:

    [▸ Tags (22)] [beans (9)] [Clear]

Collapsed with no filter:

    [▸ Tags (22)]

### Step 2b decisions and surprises

- **The toggle sits FIRST, not last.** It is then in the same place whether the
  bar is open or shut, so it can be reached without reading the row — which
  matters most on the phone, which is the whole point of the step. Collapsed,
  the row also reads in the right order: what this control is, why the list is
  filtered, how to stop.
- **The toggle shows the count of hidden tags** — `Tags (22)` — so you know the
  size of what you are opening before you open it.
- **No handler means no toggle, and `collapsed` is then ignored.** A bar that
  cannot be reopened must never be closed, so `collapsed` only takes effect when
  `onToggleCollapsed` is supplied. This is also why the 16 original tests pass
  untouched: none of them pass a handler, so none of them render a toggle. That
  is the component's rule, not a test convenience.
- **The collapsed active pill drops its count when the tag is absent.** It reads
  `beans`, not `beans (0)`. The pill is answering "what is filtering this", not
  "how many matched", and `(0)` invites the reading that the count is a result.
- **Surprise: collection detail has no search box at all.** Nothing can ever
  collapse that bar by typing; the toggle is its only control. It also has no
  `listSearch` key, so `collection-detail` is a collapse-only key — the one
  place `listTagsCollapsed` and `listSearch` do not share a keyspace. Given it
  is a separate vocabulary with its own `collectionFilterTag`, that seemed
  right rather than worth forcing into line.
- **The collapse rule is exported as `collapseOnSearch`, not inlined.**
  `executionColdLoad.test.jsx` opens by explaining that `Alfred` cannot be
  rendered in a test, and that a harness reproducing a rule instead of importing
  it "can stay green while the shipping code drifts away from it". Inlining the
  rule in `setSearchFor` would have left "typing collapses / clearing does not"
  either untested or tested against a copy. `Alfred` now calls the exported
  function, and the tests import that same function.
- **Still nothing rendered when no tag is in use** — collapsed or not, filter or
  not. So a stale `activeTag` inherited from another screen still shows no
  `Clear` on a screen whose rows carry no tags. Unchanged from 2a, out of scope
  here, and **Step 3 removes the inheritance that causes it.**
- **Not done, deliberately:** no filter reset on navigation, no suggestion-pool
  change, nothing inbox-related.

---

## Step 2c — COMPLETE (2026-09-21). No collapse below four tags.

Added after 2b shipped: on a bar with a couple of tags the toggle is pure
chrome. `Tags (2)` hiding two pills saves nothing and adds a thing to look at,
and on collection detail — which has no search box — nothing could ever fire it,
so its only purpose would be to undo itself.

- [x] `COLLAPSE_MIN_TAGS = 4`, exported from `src/TagFilter.jsx` so the tests
      assert against the component's own number rather than a copy
- [x] Below it: no toggle, and every pill always shows
- [x] Below it, typing does not collapse the bar
- [x] A collapsed bar whose count drops below the threshold shows its pills
      again — the outcome that must be impossible is impossible
- [x] Recipes (22 tags) behaves exactly as it did

The whole change is one condition:

```js
const canToggle =
  typeof onToggleCollapsed === "function" && sortedTags.length >= COLLAPSE_MIN_TAGS;
const isCollapsed = collapsed && canToggle;
```

Suite: **61 suites, 1249 tests** (was 61 / 1241). Build clean under `CI=true`.

### Why the threshold is 4

Three pills fit on one row on a phone. Collapsing a one-row bar cannot save a
row — the toggle would simply occupy the row it was meant to free, and you would
tap to reveal what was already in front of you. At four the bar can wrap, so
there is something to win. The grocery collection carries two tags, which is the
case that prompted it.

### The guard is in the RENDER, not in `collapseOnSearch`

Asked for explicitly, and the reasoning matters because the two behave
differently:

- **`collapseOnSearch` cannot see the tag count.** It runs in `Alfred`, and the
  count is computed from `entities` inside `TagFilter`. Enforcing there would
  mean teaching `Alfred` to count tags — **a second copy of the counting rule**,
  which is exactly the twin-drift failure `src/utils/tags.js` opens by warning
  about, and which has already cost this project once.
- **A render guard is continuous; a typing-time guard is a snapshot.** Decided
  once at typing time, the answer goes stale the moment the data changes.
  Recomputed every render, it cannot: a bar can never be left hidden by a `true`
  recorded when it was bigger. That is what makes "a hidden bar with no way to
  reopen it" impossible by construction rather than by a separate safety net.

### The stale `collapsed: true` is deliberate, not a quirk

Typing on a sub-threshold screen still records `true`. Nothing happens, because
the render ignores it — but if that screen later grows past four tags, the bar
opens collapsed.

**Kept on purpose (Alex, 2026-09-21).** The user did perform the gesture that
means collapse; discarding their intent based on a tag count they were not
thinking about would be the more surprising behaviour. Recorded here so a later
reader does not "fix" it.

### Six existing tests were edited — with permission, and why

2b's collapse tests were built on a **three-tag** fixture, and a threshold of
four makes a three-tag bar non-collapsible by definition. They were not catching
a regression; they were asserting the behaviour 2c removes. Flagged before
touching them, and Alex approved the widening.

The fixture in the `TagFilter — collapsed` block went from three tags to five,
and test three's one-tag fixture went to five while keeping an `activeTag` none
of the pills carry. **No assertion logic changed** — every test makes exactly
the claim it made before, on a bar big enough for collapsing to mean something.

The identical `THREE` fixture in the *filtering* and *Clear* blocks was left
alone: neither passes `onToggleCollapsed`, so neither is affected, and the net
over non-collapse behaviour is untouched.

### Also

- **Searching never changes the tag counts.** All four bars count the
  *unsearched* list — `intentionsWithoutActiveEvent`, `memoriesWithoutContext`,
  the context's `items`, the collection's `members` — while `visibleMemories` /
  `visibleIntentions` are the searched ones. So the pills and the count are
  fixed while you type, and a search can never cross the threshold. Only a data
  change can: archiving a row, editing tags, or a background refresh.
- The spec's call-site table was converted to anchors at the same time; it was
  still carrying bare line numbers that 2b had shifted.

---

## Step 3 — COMPLETE (2026-09-21). Tag filter resets on navigation.

- [x] `filterTag` clears when arriving at one of the three screens that share it
      from a different screen
- [x] Follows the existing pattern in `Alfred` -> `viewContextDetail`, whose
      `setSearchFor("context-detail")("")` line now clears the tag filter beside
      the search text (~4443)
- [x] `collectionFilterTag` remains separate and untouched
- [x] TagFilter's 32 tests pass **unchanged** — none needed editing

Two places, because there are two shapes of "a different screen":

```js
// Alfred -> setView. Arriving at a filtered screen from another screen.
if (TAG_FILTERED_VIEWS.includes(nextView) && nextView !== view) setFilterTag(null);

// Alfred -> viewContextDetail. Context to context: the view name never
// changes, but the vocabulary under it does.
if (contextId !== selectedContextId) { setSearchFor("context-detail")(""); setFilterTag(null); }
```

`TAG_FILTERED_VIEWS` is a module constant next to `TAG_TOGGLE_ATTR`, so the
three screens that share the filter are named in one greppable place.

### Why `setView` and not an effect

An effect watching `view` would clear one render too late — the new screen would
paint once with the old filter still applied. `setView` is also the whole story:
`view` is derived from the URL, so browser Back never passes through it, which is
exactly the behaviour wanted. Opening a record from a filtered list and pressing
Back keeps the filter, the same way it keeps the search text.

The `nextView !== view` guard is what stops re-selecting the screen you are
already on from clearing a filter you just set on it.

### The Step 2b hole: CONFIRMED closed, not assumed

The trap was: a screen whose rows carry no tags renders no bar at all — no
pills, no `Clear` — so an inherited filter left the list filtered to empty with
no visible cause and no way out.

Checked by enumerating every route into the three screens, not by assuming:

- **`setView`** — clears. Every nav item, every in-app link.
- **`viewContextDetail`** — clears on a context change, including context to
  context where `setView` alone would not fire.
- **`navigate(-1)`** (`leaveAddPage`, in-app) — returns to a screen you already
  occupied, where the filter was already yours or already cleared on the way
  out.
- **`navigate(viewToPath("context-detail"), { replace: true })`**
  (`leaveAddPage`) — **cold load only**, reached when `location.state?.fromApp`
  is absent. On a cold load `filterTag` is `null`, so there is nothing to
  inherit.
- **`navigate(parentPath(...))`** — the stale-link redirect guard and the
  cold-load add-page fallback. Cold load again; `filterTag` is `null`.

**No warm route reaches a different filterable screen with a stale filter.**

### What is left, and it is NOT inheritance

One case survives, and it is worth stating precisely rather than claiming a
clean sweep. You are on a filterable screen with a filter set, and that screen's
tags all vanish underneath you — archive the last tagged row while filtered to
its tag. `TagFilter` then renders nothing, so there is no `Clear` on that screen.

It is no longer a dead end, which is the part Step 3 changed: leaving for either
of the other two filtered screens now clears the filter, so you can always get
out by navigating. Before Step 3 the filter followed you and you could not.

Closing it entirely would mean rendering the bar whenever `activeTag` is set,
even with no tags to show. **It would break none of the 32 tests** — no test
covers an active filter over zero tags. Roughly three lines. Left undone because
it is a behaviour change neither Step 3 nor Step 4 asked for; flagging it as a
decision rather than taking it.

→ **TAKEN. Alex called it in as Step 4b (2026-09-21); see below.** The estimate
held: three lines, and all 32 passed unchanged.

---

## Step 4 — COMPLETE (2026-09-21). Archived rows out of the suggestion pool.

- [x] `tagPool` filters archived out of `items` and `intents` before calling
      `tagPoolFrom`
- [x] `tagPoolFrom` itself unchanged — still frequency-then-alphabetical
- [ ] Verified on device: the picker no longer offers `urgent`, `test tag`,
      `another tag`, `due`, `late`, `overdue`, `past`, `outdoor maintenance`,
      `cleaning` *(awaiting Alex's device check)*

```js
const tagPool = useMemo(
  () => tagPoolFrom(items.filter((i) => !i.archived), intents.filter((i) => !i.archived)),
  [items, intents]
);
```

Filtered at the call site rather than inside `tagPoolFrom`, which stays a pure
"count the tags in these lists" helper with no opinion about what belongs in
them. Its ordering is untouched and must stay that way: a suggestion list wants
the tags you reach for most under your thumb, which is the opposite of what the
filter bar wants.

### Two of the nine are real tags, not debris

`outdoor maintenance` and `cleaning` are genuine household tags on real
intentions that happen to be archived. **Their disappearance from the picker is
not data loss.** The rows still hold them, `get_tags` still counts them if those
rows are ever unarchived, and nothing was written or deleted — the picker simply
stopped suggesting vocabulary that no living record uses. The other seven
(`due`, `late`, `overdue`, `past`, `urgent` on one test intention; `test tag`
and `another tag` on two test items) are debris.

### Surprise: this change is not testable where it landed

Checked rather than assumed. `tagPoolFrom` is a local function declaration at
`src/Alfred.jsx` (~720) and is **not exported** — `Alfred.jsx` exports only its
default component — so no test can reach it, and the archived filtering sits in
`Alfred`, which cannot be rendered in a test.

So Step 4 ships with **no test coverage at all**, and the device check is the
only verification. Saying so rather than working around it, as asked.

If it is worth fixing, the precedent is `collapseOnSearch`: export the rule from
a file that tests can import. Here that would mean moving `tagPoolFrom` into
`src/TagFilter.jsx` (or its own module) and exporting it together with a small
`activeRows` helper — maybe fifteen lines, and it would make both the ordering
and the archived exclusion assertable. **Alex's call; not taken here.**

→ **DEFERRED ON PURPOSE, WITH A TICKET (Alex, 2026-09-21.)** Filed as its own
Alfred item rather than folded into this project. Step 4 stays exactly as it
shipped. This is a deliberate deferral, not an oversight — if you are reading
this because you found an untested `tagPool`, the gap is known and tracked, and
the device check in the Step 4 verification is what stands in for coverage
today.

---

## Step 4b — COMPLETE (2026-09-21). The bar survives having no tags.

Taken from the note left at the end of Step 3. The rule decided at Step 2b —
**a filter that is still filtering must stay visible** — held everywhere except
one place, and this closes it so it holds everywhere.

- [x] `TagFilter` renders the bar whenever a filter is active, even with no tags
- [x] The lone pill shows the tag name with the count dropped, not `(0)`
- [x] `Clear` works from that state, and so does tapping the pill
- [x] No entities and no active filter still renders nothing
- [x] All 40 existing tests pass **unchanged** — none needed editing. 10 new.

Suite: **61 suites, 1259 tests** (was 61 / 1249). Build clean under `CI=true`.

The estimate from Step 3 held — three lines of logic:

```js
// was: if (sortedTags.length === 0) return null;
if (sortedTags.length === 0 && !activeTag) return null;

// and the lone-pill branch now has two reasons to fire, not one
const onlyActivePill = isCollapsed || sortedTags.length === 0;
```

### The case, concretely

Filter a screen to `beans`. Archive the last row carrying `beans`, and it was
the only tagged row on that screen. Every count vanishes. The bar used to vanish
with them — pills, `Clear`, all of it — leaving an empty list, no explanation,
and no way to undo the filter on that screen. Step 3 had already downgraded it
from a dead end to an inconvenience by clearing the filter when you navigate
away; now there is nothing to escape from in the first place.

### What was deliberately NOT changed

An active tag that is merely **absent from a bar that still has pills**. Filter
to `beans`, lose the last beans row, but the screen still carries `soup`: you
see `soup (1)` and `Clear`, with no lone `beans` pill beside them.

That asymmetry is on purpose and worth naming, because it looks like an
oversight. Alex decided it at Step 2b for the expanded bar, and the reasoning
still holds: `Clear` is enough when there is still a bar to read. 4b is about
there being **no bar at all**. Changing it would also have meant editing the
Step 2b test that pins it, which is the signal to stop and ask rather than
quietly widen scope.

### Surprise: none

The three-line estimate and the "breaks none of the 32" prediction from Step 3
both held exactly. Worth recording only because it is the first time in this
project a flagged-and-deferred item came back and cost precisely what it was
said to cost.

---

## Step 5 — COMPLETE (2026-09-21). Inbox column cutover, migrated and deployed.

Sequencing, agreed with Alex and followed: code ready and committed first, then
he ran migration 062 and `check_platform_conformance`, then the deploy.

### Ran, and what it showed

`check_platform_conformance` returned **CONFORMANT — 42 tables, no drift**, both
after the migration and again through the freshly deployed `mcp`.

| | Before | After |
|---|---|---|
| Type | `jsonb`, nullable, default `'[]'::jsonb` | `ARRAY`, **NOT NULL**, default `'{}'::text[]` |
| Rows with tags | 3 | 3 |
| Distinct values | `ai`, `bug` (x3), `dj`, `mcp`, `ui` | identical |

Deployed 2026-09-21 19:48 UTC, all three ACTIVE, every `verify_jwt` flag
unchanged from its pre-deploy value:

| Function | Version | verify_jwt |
|---|---|---|
| `mcp` | 102 → **103** | false |
| `ai-enrich` | 10 → **11** | true |
| `email-capture` | 7 → **8** | false |

### 1. The window analysis was TESTED, not just reasoned

Recorded deliberately, because **the spec asserted the opposite** and a future
reader will find that assertion. B1 said the deployed `mcp` function's hand-typed
column list would fail at request time, and that nothing should be captured in
the window between migration and deploy.

Both were wrong, and this is no longer an argument — it is a measurement. On
device, against the **OLD deployed code and the NEW column**:

- the inbox listed normally;
- captures with AI suggestions still showed their tag chips;
- a fresh capture saved and landed.

The reasoning held: the column keeps its NAME, only its type changes, and
PostgREST serialises `text[]` and a jsonb array to the same JSON array of
strings. 062's header now carries the corrected analysis; the spec's B1 still
carries the original claim and should be read with this entry beside it.

**The lesson is not "the spec was wrong".** It is that a claim of the form "this
will break at request time" is cheap to test and expensive to believe. The cost
of believing it was a scarier-than-necessary deploy plan; the cost of testing it
was one grep and one device check.

### 2. Nothing needed normalising — and that is a RESULT, not a waste

Every stored tag was already canonical. The normalisation half of the migration —
the `pg_temp.normalise_tag` function, the dedupe, the order-preserving
re-aggregation, the 20-cap — changed nothing, because there was nothing to
change.

🛑 **Read that as evidence the write-path discipline works, not as evidence the
normalisation was pointless.** Every write path into `inbox.suggested_tags`
already runs `normaliseTags`: `ai-enrich`'s `submit_suggestions`, both MCP inbox
tools, `createInboxItem`, `updateInboxItem`. The two that do not — `email-capture`
and `handleCapture` — write a literal empty array, so there is nothing to
normalise. That is four normalised writers and two that cannot produce dirty
data, which is exactly why the migration found nothing to clean.

The normaliser was a safety net under a floor that turned out to be solid. The
correct conclusion is that the floor is solid, and the way to keep it solid is to
keep every new writer going through `normaliseTags`. A future writer that skips
it would not be caught by anything — there is no database constraint enforcing
canonical form, only discipline at the call sites. **If that discipline ever
needs defending, this is the evidence that it has been holding.**

### A landmine found while deploying — FIXED 2026-09-21

`email-capture` has **no `[functions.email-capture]` section in
`supabase/config.toml`**, but runs in production with `verify_jwt = false`. The
CLI defaults that flag to **true** when nothing declares otherwise, so a bare
`npx supabase functions deploy email-capture` would flip it and **silently 401
every Postmark webhook** — email capture would stop working with no error
anywhere Alex would see.

This deploy passed `--no-verify-jwt` explicitly, so production is unchanged. But
the next person to deploy that function without knowing is one command away from
breaking it.

The fix is four lines in `config.toml`, codifying what production already does:

```toml
[functions.email-capture]
enabled = true
# 🛑 JWT verification OFF. Called by Postmark's webhook, which has no user token
# and cannot present one. Same shape as notify-dispatch.
verify_jwt = false
```

~~**Not applied** — deployment configuration was not in this step's scope and
changing it is Alex's call.~~

→ **APPLIED 2026-09-21**, as its own change, at Alex's instruction. Both facts
re-confirmed first rather than trusted from memory:

- `supabase/config.toml` had exactly five `[functions.*]` sections, and the
  string `email` appeared **nowhere** in the file.
- `email-capture` was deployed at **v8 with `verify_jwt = false`**.

So the problem was real and the fix applies to it.

**Audited every deployed function rather than the five I remembered.** Six are
deployed; five were declared. `email-capture` was the only gap — and the only
one where a gap is dangerous:

| Function | verify_jwt | Was declared? | Exposure |
|---|---|---|---|
| `mcp` | false | yes | — |
| `ai-enrich` | true | yes | — |
| `push-send` | true | yes | — |
| `sam-song-scores` | true | yes | — |
| `notify-dispatch` | false | yes | — |
| `email-capture` | **false** | **NO** | bare deploy would flip it to true |

A missing entry only bites when production runs `false`, because the CLI default
is `true` — an undeclared `true` function would have been deployed correctly by
accident. `email-capture` was the only undeclared function running `false`.

After the change: six declared, six agreeing with production, **zero gaps or
mismatches**, and the TOML parses.

**NO DEPLOY, and none is needed.** `config.toml` is read by the CLI at deploy
time; it does not reach production on its own. Production already runs
`verify_jwt = false`. The entry changes nothing that is running — it changes
what the NEXT deploy will do, which until now depended on someone remembering
to type `--no-verify-jwt`. Writing it down is the whole fix.

### What the comment says, and why it is not a copy of notify-dispatch's

Writing the entry meant reading `email-capture`'s actual auth, and it is weaker
than the obvious comparison suggests. `notify-dispatch` is guarded by a shared
secret in the `x-dispatch-secret` header, checked before any work.
**`email-capture` has no secret at all.** Its only gate is that the `To` address
must match one of two hard-coded patterns in `USER_MAPPINGS`; anything else is
refused with a 200 so Postmark does not retry.

So the endpoint is effectively public: anyone who learns the URL and the address
shape can put a row in the inbox. Recorded in the config comment as survivable
rather than fine — the inbox IS the human-approval gate, so the blast radius is
junk to triage, not data written anywhere that matters. A shared secret in the
Postmark webhook URL is the cheap hardening if it is ever wanted. **Not done;
not asked for; flagged.**

The entry also carries forward the reset warning from `notify-dispatch`: that
flag has gone back to `true` on its own in this project before, *despite* having
a declared entry. So the config makes the next deploy correct by default, but it
is not a guarantee — re-check after every deploy.

### The window is cosmetic. Nothing breaks.

The spec's B1 warned that dropping the column would break the deployed `mcp`
function's hand-typed column list at request time. **That is wrong, and it was
worth checking rather than believing.** Every access to `inbox.suggested_tags`
in the codebase is a plain column read or a plain JS-array write — grepped, no
jsonb operator (`?|`, `@>`, `->`, `jsonb_array_elements`) touches it anywhere
outside the migration itself.

| Path | During the window | Why |
|---|---|---|
| `get_inbox` read | **fine** | The column keeps its NAME; only the type changes. PostgREST serialises `text[]` and a jsonb array to the same JSON array of strings. |
| `ai-enrich` re-enrich echo | **fine** | `buildPreviousSuggestions` JSON.stringifies whatever it read. Same array, same JSON. |
| Triage `JSON.stringify` dirty-checks | **fine** | `toCamelCase` recurses into arrays but returns non-objects untouched, so an array of strings passes through unchanged. Both sides of the comparison are the same JS array they always were. |
| Writes (all six sites) | **fine** | Every one sends a JS array. PostgREST coerces a JSON array into `text[]` — which is exactly how `items.tags` has worked since 039. |
| `suggested_tags: null` | **n/a** | Nothing writes null. `normaliseTags` returns `[]` for undefined, `updateInboxItem` only sets the key when defined, and both unnormalised writers send `[]`. The new `NOT NULL` is safe. |

Two genuine, minor risks rather than breakages:

- **PostgREST schema-cache staleness.** Supabase reloads the cache on DDL via an
  event trigger, but if it lags, the first request or two after the migration
  could see the old type. Self-healing; retry.
- **Normalised values look different.** A row holding `["Whole Foods"]` reads
  back `["whole foods"]`. That is the migration doing its job, and it makes the
  dirty-check MORE correct, not less: a non-canonical stored tag used to make a
  triage card permanently dirty.

**So the "do not capture anything in the window" instruction in 062's header is
over-cautious.** Capturing during the window is safe. Left to Alex whether to
soften it.

### 🛑 A REAL PROBLEM, and it is in the migration, not the code

Migration 062's `UPDATE` has no trigger guard, and **migration 039 — its direct
precedent — has one, with a long note explaining why.**

`inbox` carries both a `set_updated_at` BEFORE UPDATE trigger (039: "on all six
Alfred tables", confirmed by pg_trigger) and the generic `audit_row` trigger
(registry says `audited: true`). 040's note confirms `ALTER TABLE` is DDL and
fires neither — so the ADD/DROP/RENAME are safe. **The `UPDATE` is not.**

Worse, 062's `WHERE` is broader than 039's. It matches
`suggested_tags IS NOT NULL AND jsonb_typeof(...) = 'array'` — and the column
default is `'[]'::jsonb`, which IS an array. So it touches **nearly every inbox
row**, including every row that has no tags at all. 039 deliberately touched
only rows that actually had tags.

Consequences of running it as written:

- Every inbox row gets `updated_at = now()`. The inbox has a **"Last modified"**
  sort option (`INBOX_SORT_OPTIONS`), and `InboxCard` renders that timestamp. The
  whole inbox would read as modified today — exactly the outcome 039 called
  "visible and irreversible" and guarded against.
- One audit row per inbox row, for a change that touched nothing in most of them.

Recommended fix, matching 039 — narrow the WHERE *and* guard the trigger:

```sql
alter table public.inbox disable trigger user;   -- TRIGGER GUARD
UPDATE ... WHERE i.suggested_tags IS NOT NULL
             AND jsonb_typeof(i.suggested_tags) = 'array'
             AND jsonb_array_length(i.suggested_tags) > 0;   -- ADDED
alter table public.inbox enable trigger user;    -- TRIGGER GUARD
```

Rows holding `[]` need no update at all: the new column already defaults to
`'{}'`. ~~**Flagged, not edited — 062 is Alex's file and his to run.**~~

→ **APPLIED 2026-09-21, at Alex's instruction.** 062 now carries the
`DISABLE/ENABLE TRIGGER USER` guard around the UPDATE and the
`jsonb_array_length(...) > 0` clause, matching 039. Both sit inside the
transaction, so a rollback restores the triggers automatically.

**The conversion is therefore NOT AUDITED, deliberately, and 062 says so.**
`DISABLE TRIGGER USER` takes `audit_row` down with `set_updated_at` — they
cannot be separated at that granularity. That is the right trade: the audit log
explains changes to DATA, and this statement changes a representation, not a
meaning. What happened is recorded in a numbered migration, with before/after
queries either side of it. One audit row per inbox row would bury a real signal
under a rename. 039 has no equivalent note because 039 never discussed the audit
trigger at all — 040 is where `audit_row` is named — so this is the first time
that consequence has been written down.

Two smaller things in 062, same category, **also corrected**:

- ~~Its header still says `040_inbox_suggested_tags_text_array.sql`, and the
  `COMMENT ON COLUMN` it writes says "as of migration 040".~~ Both now say
  `062`, and the column comment credits 039 for items/intents.
- ~~Its "will fail at request time" warning is the claim disproved above.~~
  Replaced with the corrected analysis, including the two things to expect
  (schema-cache lag, normalised values reading back differently) and an explicit
  "capturing during the window is safe".

### What the code side actually needed: nothing functional

Stated plainly because it is the surprise of this step. **No functional code
change was required, at any of the sixteen touchpoints.** Not the six write
sites, not the two reads, not the ten triage-UI locations, not the
triage-to-item boundary. Every one already spoke plain JS arrays, and the spec
was right that PostgREST coerces at the boundary.

What was changed is accuracy, so the next reader does not re-derive all of the
above:

- `mcp/index.ts`, `getInboxTool` — a note on the hand-typed `.select(...)`
  recording that a RENAME or DROP would still break it but a RETYPE did not.
- `mcp/index.ts`, `getItemsTool` — stale comment claiming the tag filter uses
  the jsonb `?|` operator. Wrong since 039; it is `tags && p_tags`.
- `src/Alfred.jsx`, `storage.set` — its comment named `'[]'::jsonb` as a column
  default it relies on the database to assign.
- `supabase/functions/_shared/tags.ts` — records that all three tag columns are
  now `text[]`, and that nothing in the tag path depends on it.
- `email-capture/index.ts`, the `inboxRecord` literal — visited as asked;
  nothing jsonb-specific surrounds it. Comment sharpened.
- `Alfred` -> `handleCapture` — visited as asked; `suggestedTags: []`, nothing
  jsonb-specific around it, unchanged.

### Testing: what is and is not covered

Honestly, and without working around it:

- **Nothing here is unit-testable, and nothing new was made testable.** Edge
  functions need Deno and a live PostgREST; `Alfred.jsx` cannot be rendered.
  Deno is not installed locally, so the edge functions were not even
  type-checked — though every edit to them was comment-only, so there is no
  type risk to check.
- **The 1259-test suite passing proves only that the browser build is
  unaffected**, which given the changes is exactly what it should prove.
- **The device verification IS the test for this step.** Capture, enrich,
  re-enrich and triage end to end, including a mixed-case and an underscored tag
  so normalisation is visible.

This is the same class of gap as `tagPoolFrom` in Step 4, and the same answer:
said out loud rather than papered over. Unlike Step 4 there is no cheap
extraction that would fix it — the rule under test is PostgREST's coercion, not
ours.

### Not done

Nothing deployed. Migration not run. Step 6 (the enrichment skill) untouched.

---

## Step 5 checklist — the touchpoints

SQL migration is run by hand before the DEPLOY, not before the code. See
"Manual prerequisites".

Every location below is anchored by its enclosing function plus a string to
search for. The `(~n)` is last-known line, approximate and not to be trusted —
search for the string.

**Edge functions**

- [x] `mcp/index.ts`, `getInboxTool` — the hand-typed `.select(...)` string of
      21 columns still names `suggested_tags` correctly (~334)
- [x] `ai-enrich/index.ts`, `buildPreviousSuggestions` — the `fields` array
      handles a text array (~379)
- [x] `ai-enrich/index.ts`, the `submit_suggestions` update —
      `suggested_tags: normaliseTags(suggestions.suggested_tags)` (~582)
- [x] `mcp/index.ts`, `createInboxItemTool` —
      `suggested_tags: normaliseTags(args.suggested_tags)` (~197)
- [x] `tool-handlers.ts`, `createInboxItem` —
      `suggested_tags: normaliseTags(params.suggested_tags)` (~627)
- [x] `tool-handlers.ts`, `updateInboxItem` —
      `updates.suggested_tags = normaliseTags(params.suggested_tags)` (~710)
- [x] `email-capture/index.ts`, the `inboxRecord` literal —
      `suggested_tags: []` (~207)

**Browser — the ten triage-UI locations, one per line**

- [x] `Alfred` -> `handleCapture` — `suggestedTags: []` in the new-capture
      record (~2802)
- [x] `CLEARED_ENRICHMENT` (module constant above `InboxCard`) —
      `suggestedTags: []` (~7299)
- [x] `InboxCard` —
      `const [intentTags, setIntentTags] = useState(inboxItem.suggestedTags || [])`
      (~7359)
- [x] `InboxCard` —
      `const [itemTags, setItemTags] = useState(inboxItem.suggestedTags || [])`
      (~7400)
- [x] `InboxCard`, the re-seed effect, under `if (inboxItem.suggestIntent)` —
      `setIntentTags(inboxItem.suggestedTags || [])` (~7436)
- [x] `InboxCard`, the same effect, under `if (inboxItem.suggestItem)` —
      `setItemTags(inboxItem.suggestedTags || [])` (~7453)
- [x] `InboxCard`, the `isDirty` effect —
      `JSON.stringify(intentTags) !== JSON.stringify(inboxItem.suggestedTags || [])`
      (~7480)
- [x] `InboxCard`, the `isDirty` effect —
      `JSON.stringify(itemTags) !== JSON.stringify(inboxItem.suggestedTags || [])`
      (~7485)
- [x] `InboxCard` -> `handleReEnrich` —
      `suggestedTags: intentTags.length > 0 ? intentTags : []` (~7736)
- [x] `InboxCard` -> `handleCancel` —
      `setIntentTags(inboxItem.suggestedTags || [])` (~7843)
- [x] `InboxCard` -> `handleCancel` —
      `setItemTags(inboxItem.suggestedTags || [])` (~7860)

(That is eleven checkboxes for ten `suggestedTags` triage locations plus
`handleCapture`, which lives outside `InboxCard`.)

- [x] The two `JSON.stringify` dirty-checks above still behave correctly and
      produce no phantom unsaved-changes prompt
- [x] The triage write-through in `Alfred` -> `handleInboxSave` still needs no
      change: `tags: triageData.itemData.tags || []` (~2962) and
      `tags: triageData.intentionData.tags || []` (~3009)
- [x] Deploy `mcp`, `ai-enrich` and `email-capture` — done 2026-09-21 19:48
      UTC (v103 / v11 / v8), all ACTIVE, `verify_jwt` flags unchanged

---

## Step 6 — Update the enrichment skill

- [ ] Rewrite the tag guidance in `alfred-enrich` per spec section C1
- [ ] Reuse-first: call `get_tags` and match an existing tag before proposing one
- [ ] New tags only when they fit cuisine, protein, core carb, or dish role
- [ ] Named exclusions with reasoning: cooking method, equipment, source or
      author, season, incidental ingredients

---

## Manual prerequisites (Alex runs these, not the CLI)

- [ ] `supabase/migrations/062_inbox_suggested_tags_text_array.sql` in the
      Supabase SQL editor — **before** Step 5
      (path corrected 2026-09-20: the spec and this file both said `040_...`,
      but `040` is already `040_tags_b_collection_item_tags.sql`. The actual
      file on disk is `062_`.)
- [ ] `check_platform_conformance()` — CONFORMANT required before Step 5 is
      marked done

---

## Notes

Tag clean-up SQL completed 2026-09-20. `recipe`, `mushroom`, `cheese`, `ganache`
and `cheesecake` deleted everywhere; `book`→`books` and `test`→`testing` merged;
18 recipe items gained tags; `vegetarian` removed from the one dessert carrying
it; every `tags` array in `items` and `intents` sorted alphabetically at rest.
Recipes context now carries 22 distinct tags and no untagged items.

The deletions initially did not apply on the first run and had to be re-run as a
standalone statement. Verified clean afterwards.

### Step 0, 2026-09-20 — decisions and surprises

- **Redeploy deliberately not run.** The spec gated it on confirming the stale
  deploy theory first. The theory is disproven and the bug it was meant to fix
  does not exist, so deploying would have been a no-op over a byte-identical
  bundle. Held for Alex rather than burning a production deploy on a comment.
- **The comment fix is in the repo but not live.** The comment above
  `getIntents`' tag filter now
  states the column is `text[]`, that it no longer matches `get_items` (which
  filters in Postgres via `platform_search_items`), and carries a warning about
  the page-not-table limit trap — because that trap is what caused the
  misdiagnosis, and the next person to read those lines is the person about to
  repeat it.
- **A second stale jsonb comment exists** in `tool-handlers.ts`, inside the
  legacy `getItems`: *"items.tags is a jsonb array"*. Equally false since 039.
  Left untouched — outside the scope Alex specified. One line, zero risk, his
  call. Note `getItems` is still live: `ai-enrich/index.ts` calls it from its
  tool dispatch, `case "get_items"` (~166). Unlike
  `getIntents` it has no `.limit()`, so it does **not** have the page-not-table
  bug.
- **Spec correction needed.** The Overview's "Prerequisite — redeploy the MCP
  function" paragraph is void, and success criterion 9 is already met. Not
  edited here; the spec is Alex's document.
- **Migration path in the spec is wrong** — `040_` vs the actual `062_`. See
  Manual prerequisites above.
- Nothing was committed. Nothing was pushed. No migration was run.
