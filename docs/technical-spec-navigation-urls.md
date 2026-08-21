# Technical Spec: Real URLs for Alfred Navigation (Slice 1)

## Goal

Make middle-click and Ctrl/Cmd-click open Alfred screens in a new tab.

That gesture is browser behaviour on a real link with a real address. Alfred
currently has neither. So the actual work is: give Alfred's screens addresses,
then point links at them.

## Current state (from docs/investigation-navigation-urls.md)

- No router. No URLs. `react-router`, `useNavigate`, `<Link>`, `useParams`
  appear zero times in `src/`.
- Navigation is one state variable: `const [view, setView] = useState("home")`
  at `Alfred.jsx:652`.
- 18 destinations, 39 `setView(` call sites, all inside `Alfred.jsx` (9,059 lines).
- `App.js` is 11 lines: one hard-coded `pathname === '/oauth/consent'` check,
  everything else renders `<Alfred />` booting to home.
- Two `<a href>` tags total, both the logo, both `href="/"`, both full reloads.
- `SongLoader.jsx` calls `pushState`/`popstate` directly — a private history
  island that will collide with a router.
- Deep-link readiness is good: `loadData()` fetches everything at boot, no
  screen depends on a previous screen's fetch. Exception: `execution-detail`
  holds a whole execution object in state rather than an id.

## Confirmed not a blocker

`vercel.json` now carries an explicit catch-all rewrite. Arbitrary paths
(`/testing`, `/a/b/c`) load the app rather than returning 404. Verified in
production.

## Scope

### In scope

1. Mount a router.
2. Give all 18 view values a path, so the URL becomes the source of truth.
3. `<AppLink>` component that produces a real `<a href>` and handles modifier
   and middle clicks correctly.
4. Swap the nine top-nav buttons to `<AppLink>`.
5. Migrate SAM's history island to real routes.

### Explicitly out of scope

- Shared cards (`ItemCard`, `IntentionCard`, `EventCard`, `ContextCard`,
  `ExecutionBadge` — 22 render sites). Slice 2.
- Collection rows (markup copy-pasted three times, no `CollectionCard`
  exists). Slice 2, and extracting the component comes first.
- The three hand-rolled back-stacks (`previousView`, `intentionReturnView`,
  `itemHistoryStack`). Decide their fate in slice 1, act in slice 3. See
  "Open question" below.
- Breaking up `Alfred.jsx`. Routes create the seam for it; that's a later
  payoff, not this slice's job.

## Key architectural decision: bridge, don't rip out

Do **not** rewrite 39 `setView(` call sites. In a 9,059-line file that is where
this project dies.

Instead, invert what backs the existing API and leave every call site untouched:

- Add a two-way map between view names and paths (`home` ↔ `/`,
  `inbox` ↔ `/inbox`, and so on for all 18).
- Derive `view` from the current URL instead of from `useState`.
- Reimplement `setView` as a thin wrapper that calls the router's navigate
  function with the mapped path.

All 39 call sites keep working with no edits. The URL becomes real. The
`useState` line disappears. This is the highest-leverage change in the slice
and the one most likely to be quietly "improved" into a rewrite — it must not be.

Only after this bridge is proven do links get swapped in, and only where a real
`<a href>` earns something (new-tab, copy-link, hover preview).

## `<AppLink>` behaviour

Renders a genuine `<a href="...">` — that is the whole point; nothing else
produces browser new-tab behaviour.

On click:

- **Modifier or middle click** (`e.metaKey || e.ctrlKey || e.shiftKey ||
  e.button === 1`): do nothing at all. No `preventDefault`. Let the browser
  open its new tab. The current tab is untouched, so the unsaved-changes guard
  correctly does not run.
- **Plain left click**: `preventDefault()`, then route through the existing
  unsaved-changes guard exactly as the old button did.

The second branch is not optional. Turning a guarded button into a link without
it silently deletes the unsaved-changes warning — the feature would cost data
loss protection.

### Prerequisite: consolidate the guard

`guardedSetView` is triplicated — the Sam, Timer, and mobile-drawer handlers
each inline their own copy. `<AppLink>` needs one guard to call. Consolidate to
the single `guardedSetView` before building the link component.

## SAM history island

`SongLoader.jsx` calls `pushState`/`popstate` directly. **Corrected
2026-08-20:** the guess that this was "so back closes an open song" is wrong —
it is entirely about the `/stats` stub. Songs never touched history at all.

The island works only because nothing else in Alfred touches history either. A
router claims the same two APIs, and the browser has one history list with no
notion of ownership — the collision is immediate and non-deterministic (back
moves one screen, or two, or exits SAM, depending on listener order).

Fix by deletion, not coexistence. The open-song state becomes a real address
(`/sam/songs/:songId` vs `/sam`), after which "back closes the song" is
ordinary route navigation the router handles for free. The `pushState` and
`popstate` code is removed entirely.

This ships in slice 1 because there is no intermediate state where both work.
SAM is used daily; a regression here would not stay temporary.

## Cold-load handling

Every path must survive being pasted into a fresh tab. Boot-time `loadData()`
makes this true for most views automatically.

Views whose state cannot be reconstructed from the URL — `execution-detail`
holds an object, not an id — get a path but must redirect to their parent view
when loaded cold rather than rendering broken. Convert them to id-in-URL in a
later slice.

Unknown paths (`/testing`) currently render home. Preserve that: the catch-all
route redirects to `/`.

## Open question to answer during slice 1

Once URLs exist the browser back button becomes real, and the three in-app
back-stacks may disagree with it. Two back behaviours that disagree is worse
than one that doesn't exist. Document what each stack does and what browser
back would do instead; decide keep/replace before slice 3. No code change this
slice.

## Success criteria

1. Middle-click and Ctrl/Cmd-click on any top-nav item opens that screen in a
   new tab, correctly, from cold.
2. Plain left-click behaves exactly as before, including the unsaved-changes
   confirm on dirty forms.
3. The address bar reflects the current screen for all 18 views.
4. Browser back and forward work across top-nav navigation.
5. Inside SAM, back closes an open song and stays in SAM. **Corrected
   2026-08-20:** this criterion originally read "same felt behaviour as
   today". That was wrong — today back does *not* close an open song. The
   `pushState` island was only ever about the `/stats` stub; nothing in the
   song-open path touched history, so back exited the app. This is therefore
   new behaviour, deliberately added, not a migration. No `pushState` left in
   `SongLoader.jsx`.
6. Every path loads correctly when pasted into a fresh incognito tab.
7. Zero edits to the 39 `setView(` call sites.
