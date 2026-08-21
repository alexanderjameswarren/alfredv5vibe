# Investigation: Navigation, URLs, and new-tab readiness

**Read-only. No code changed.** Verified against the working tree on `main`
(`src/Alfred.jsx` @ 9,059 lines), 2026-08-20.

## Headline

Alfred has **no router and no URLs**. Every destination in the app is a value in a
single `useState` string called `view`, held in `Alfred.jsx`. There are exactly two
`<a href>` elements in the entire `src/` tree, both the "Alfred v5" logo pointing at
`/`, and both cause a full page reload.

Middle-click and Ctrl/Cmd-click cannot be made to work by changing the top nav
buttons. Those gestures are browser behaviour attached to a real `href`, and there is
currently no URL for any of the nine top-nav destinations to point at. **This is a
give-things-URLs job first, swap-buttons-for-links second.**

The good news is in §6: because Alfred loads its entire dataset at boot, deep links
are cheap to add. The hard part is not data — it is that back-navigation is currently
modelled as saved state rather than as browser history.

---

## 1. Routing setup

| Question | Answer |
|---|---|
| Routing library | **None.** No `react-router`, `react-router-dom`, `wouter`, `@tanstack/router`, or equivalent in `package.json`. |
| Version | n/a |
| Where routes are defined | Nowhere. There is no route table to paste. |

The full dependency list in [package.json](package.json) is Supabase, lucide-react,
ajv, jszip, react/react-dom, react-scripts, and the testing-library set. Nothing else.

`grep -rn "react-router\|BrowserRouter\|useNavigate\|<Route\|<Link\|<NavLink\|useParams\|useSearchParams" src/`
returns **one** hit, and it is a comment noting the absence:

```
src/sam/components/SongLoader.jsx:20:// react-router; App.js does one hard-coded pathname check for /oauth/consent
```

### What stands in for routing

**Level 1 — [App.js](src/App.js), the only real path dispatch (11 lines):**

```jsx
function App() {
  if (window.location.pathname === '/oauth/consent') {
    return <OAuthConsent />;
  }
  return <Alfred />;
}
```

One hard-coded pathname check. **Every other URL renders `<Alfred />`**, which always
boots to `view = "home"` ([Alfred.jsx:652](src/Alfred.jsx#L652)) regardless of what
the address bar says.

**Level 2 — the `view` state machine.** In place of a route table, the render body of
`Alfred.jsx` is a long chain of `{view === "..." && (...)}` blocks. This is the
closest thing to a route table that exists:

| `view` value | Rendered at | Extra state it needs |
|---|---|---|
| `home` | [Alfred.jsx:3220](src/Alfred.jsx#L3220) | — |
| `inbox` | [Alfred.jsx:3399](src/Alfred.jsx#L3399) | — |
| `contexts` | [Alfred.jsx:3428](src/Alfred.jsx#L3428) | — |
| `context-detail` | [Alfred.jsx:3481](src/Alfred.jsx#L3481) | `selectedContextId` |
| `intention-detail` | [Alfred.jsx:3526](src/Alfred.jsx#L3526) | `selectedIntentionId`, `intentionReturnView` |
| `item-detail` | [Alfred.jsx:3553](src/Alfred.jsx#L3553) | `selectedItemId`, `itemHistoryStack`, `previousView` |
| `execution-detail` | [Alfred.jsx:3590](src/Alfred.jsx#L3590) | `activeExecution` (**a whole object, not an id**), `previousView` |
| `schedule` | [Alfred.jsx:3615](src/Alfred.jsx#L3615) | — |
| `intentions` | [Alfred.jsx:3650](src/Alfred.jsx#L3650) | — |
| `memories` | [Alfred.jsx:3742](src/Alfred.jsx#L3742) | — |
| `collections` | [Alfred.jsx:3773](src/Alfred.jsx#L3773) | `collectionContextFilter` |
| `collection-detail` | [Alfred.jsx:3873](src/Alfred.jsx#L3873) | `selectedCollectionId`, `previousView` |
| `collection-history` | [Alfred.jsx:4155](src/Alfred.jsx#L4155) | `selectedCollectionId` |
| `collection-add-items` | [Alfred.jsx:4248](src/Alfred.jsx#L4248) | `selectedCollectionId` |
| `settings` | [Alfred.jsx:4307](src/Alfred.jsx#L4307) | — |
| `recycle` | [Alfred.jsx:4323](src/Alfred.jsx#L4323) | `recycleTab` |
| `sam` | [Alfred.jsx:2910](src/Alfred.jsx#L2910) — **early return**, full-screen | `previousView` |
| `timer` | [Alfred.jsx:2918](src/Alfred.jsx#L2918) — **early return**, full-screen | `previousView` |

18 destinations. `sam` and `timer` return before the chrome renders, so they replace
the header and nav entirely.

**Level 3 — SAM's private `pushState` island.** [SongLoader.jsx:24-27, 213-233](src/sam/components/SongLoader.jsx#L24)
manages `/stats` by hand with `pushState` + a `popstate` listener, with an explicit
comment that it does this *because* there is no router. It is the only place in the
app that writes to the History API. See §2 and §6 for why it does not survive a fresh
tab.

**Level 4 — hosting.** [vercel.json](vercel.json) rewrites exactly one path:

```json
{ "rewrites": [ { "source": "/oauth/consent", "destination": "/index.html" } ] }
```

There is no catch-all SPA fallback. **Flagged, not proven:** Vercel's CRA preset
normally adds an implicit index.html fallback, but the fact that someone had to add
`/oauth/consent` explicitly is evidence it was not firing. Before any URL work,
confirm what a cold request to an arbitrary path returns in production — if it 404s,
that is a prerequisite, not a detail.

---

## 2. URL coverage

**Short version: nothing has a URL.** For completeness, destination by destination:

| Destination | Status |
|---|---|
| Home | **state only, no URL** — `view: "home"` |
| Inbox (list) | **state only, no URL** |
| Inbox item | **not a destination at all.** `InboxCard` expands inline via a local `expanded` boolean ([Alfred.jsx:4643](src/Alfred.jsx#L4643), [:5139](src/Alfred.jsx#L5139)). There is no inbox detail view. |
| Contexts (list) | **state only, no URL** |
| Context detail | **state only, no URL** — `view: "context-detail"` + `selectedContextId` |
| Intentions (list) | **state only, no URL** |
| Intention detail | **state only, no URL** — + `selectedIntentionId` |
| Schedule / events (list) | **state only, no URL** |
| Event detail | **not a destination.** `EventCard` edits inline (`setIsEditing(true)`) or jumps to the execution. |
| Items / Memories (list) | **state only, no URL** |
| Item detail | **state only, no URL** — + `selectedItemId` + a drill-down stack |
| Collections (list) | **state only, no URL** |
| Collection detail | **state only, no URL** — + `selectedCollectionId` |
| Collection removal history | **state only, no URL** |
| Collection add-items | **state only, no URL** |
| Execution detail | **state only, no URL** — + the `activeExecution` **object** |
| Settings | **state only, no URL** |
| Recycle bin | **state only, no URL** |
| Timer | **state only, no URL** |
| SAM (landing) | **state only, no URL** |
| SAM song | **state only, no URL.** The loaded song lives in `song` state in `SamPlayer`; `SongLoader` fetches it by id via `fetchSongById(row.id)` and hands the object up through `onSongLoaded`. The id never reaches the address bar. |
| SAM stats | **has a URL: `/stats`** — but only half. See below. |
| OAuth consent | **has a URL: `/oauth/consent`** — the only genuinely working one, and it is not app navigation. |

### The `/stats` caveat

`/stats` is written to the address bar, and browser Back works *while you are already
inside SAM*, because `SongLoader` listens for `popstate`. But `readSamPath()` only
runs when `SongLoader` mounts, and `SongLoader` only mounts once `view === "sam"`,
and `view` always starts at `"home"`. So a cold load of `/stats` shows **Alfred's
home page** with `/stats` in the address bar.

There is a live oddity worth knowing about: after that cold load, clicking **Sam**
mounts `SongLoader`, `readSamPath()` sees the stale `/stats`, and you land on the
stats page instead of the SAM landing page — without having asked for it.

---

## 3. How navigation is triggered

Counts are occurrences, measured with `grep` and a small scanner over `src/`.

| Primitive | Count | Files |
|---|---|---|
| `useNavigate` | **0** | — |
| `navigate(` | **0** | — |
| `history.push` (react-router) | **0** | — |
| `window.history.pushState` | **1** | [SongLoader.jsx:225](src/sam/components/SongLoader.jsx#L225) |
| `window.history.back()` | **1** | [SongLoader.jsx:233](src/sam/components/SongLoader.jsx#L233) |
| `popstate` listener | **1** | [SongLoader.jsx:219](src/sam/components/SongLoader.jsx#L219) |
| `window.location` (nav-relevant) | **4** | [App.js:5](src/App.js#L5) (read), [OAuthConsent.jsx:65](src/OAuthConsent.jsx#L65), [:83](src/OAuthConsent.jsx#L83), [:114](src/OAuthConsent.jsx#L114) (external redirects, `href =`) |
| `<Link>` / `<NavLink>` | **0** | — |
| `<a href>` | **2** | [Alfred.jsx:2939](src/Alfred.jsx#L2939) (mobile logo), [Alfred.jsx:3051](src/Alfred.jsx#L3051) (desktop logo) — both `href="/"`, both full reloads |

### The actual mechanism: `setView`

| Call | Count | Location |
|---|---|---|
| `setView(` | **39** | all in `Alfred.jsx` (one is the definition inside `guardedSetView`) |
| `guardedSetView(` | **11 call sites** + 1 definition | all in `Alfred.jsx` ([:721](src/Alfred.jsx#L721)) |
| `setSelectedCollectionId(` | 11 total, 6 navigational | `Alfred.jsx` |
| `viewContextDetail` / `viewIntentionDetail` / `viewItemDetail` / `openExecution` | 4 helpers, defined [:2511](src/Alfred.jsx#L2511), [:2517](src/Alfred.jsx#L2517), [:2534](src/Alfred.jsx#L2534), [:2704](src/Alfred.jsx#L2704) | `Alfred.jsx` |

### `onClick` handlers that navigate

**165 `onClick` occurrences in `Alfred.jsx`; 34 of them change the view.** Full list
of the 34, by line: 2962, 2969, 3019, 3078, 3085, 3104, 3114, 3124, 3134, 3146, 3156,
3166, 3176, 3195, 3337, 3388, 3467, 3778, 3832, 3888, 3954, 4074, 4121, 4137, 4164,
6717, 6756, 6799, 6827, 7299, 7858, 8791, 9001, 9022.

Grouped:

- **9** — desktop top nav tabs ([:3104](src/Alfred.jsx#L3104) onward). Seven use
  `guardedSetView`; **Timer and Sam are hand-inlined copies** of the guard logic
  because they also need `setPreviousView(view)`.
- **1** — mobile drawer, a `.map()` over a 9-entry array
  ([:3019](src/Alfred.jsx#L3019)), a third hand-inlined copy of the guard.
- **4** — Settings and Recycle icons, duplicated across the mobile
  ([:3078](src/Alfred.jsx#L3078), [:3085](src/Alfred.jsx#L3085)) and desktop
  ([:2962](src/Alfred.jsx#L2962), [:2969](src/Alfred.jsx#L2969)) headers.
- **6** — collection entry points (home pinned, collections list, context detail,
  new-collection, add-items, history ×2).
- **~8** — back buttons (see below).
- **~6** — card and row clicks inside shared components.

`onClick` counts elsewhere: `sam/components/BrowseTabs.jsx` 13, `SnippetPanel` 10,
`SamPlayer` 9, `AudioToolbar` 7, `TimerBuilder` 6, `SongLoader` 6, `FamilySheet` 6,
`OAuthConsent` 3, and a long tail. Of these, the navigational ones are the song rows
in `BrowseTabs` ([:101](src/sam/components/BrowseTabs.jsx#L101),
[:172](src/sam/components/BrowseTabs.jsx#L172)), `ContinueSection`
([:63](src/sam/components/ContinueSection.jsx#L63)), `FamilySheet`, and the `onBack`
buttons in `SamPlayer` and `TimerPage`.

### Back navigation is state, not history

`ArrowLeft` back buttons: **9** (plus one icon import). `onBack` prop wirings: **17**
occurrences. All of them restore a saved value rather than calling `history.back()`:

- `previousView` ([:696](src/Alfred.jsx#L696)) — a one-deep return address, set by
  `viewContextDetail`, `openExecution`, `startNowFromItem`, `startNowFromIntention`,
  and the Sam/Timer tabs.
- `intentionReturnView` ([:697](src/Alfred.jsx#L697)) — a **separate** return address
  just for intention detail.
- `itemHistoryStack` ([:698](src/Alfred.jsx#L698)) — a real stack, for item → linked
  item → linked item drill-down ([:2534-2564](src/Alfred.jsx#L2534)).

That is three parallel, hand-rolled history mechanisms. All three are exactly what a
router replaces, and all three become dead weight — or active bugs — once a URL
exists.

---

## 4. Shared wrappers

Yes, and this is the most encouraging finding. Navigation is funnelled through six
components, all defined inside `Alfred.jsx`. Fixing these covers most of the app's
row-level navigation.

| Component | Defined | Rendered from | Nav mechanism |
|---|---|---|---|
| **`ItemCard`** | [:7333](src/Alfred.jsx#L7333) | **5 places** — memories list, context detail ×2, intention detail, item detail | Root `<div onClick>` → `onViewDetail(item.id)` ([:7858](src/Alfred.jsx#L7858)) |
| **`IntentionCard`** | [:8394](src/Alfred.jsx#L8394) | **7 places** — intentions list ×2, context detail ×2, intention detail, item detail ×2 | Root `<div onClick>` → `onViewDetail(intent.id)` ([:8791](src/Alfred.jsx#L8791)) |
| **`EventCard`** | [:8878](src/Alfred.jsx#L8878) | **4 places** — home, schedule, intention detail, nested inside `IntentionCard` | Inner `<div onClick>` → `onOpenExecution(execution)` ([:9001](src/Alfred.jsx#L9001)) |
| **`ContextCard`** | [:5970](src/Alfred.jsx#L5970) | **2 places** — home pinned, contexts list | Inner `<div onClick={onClick}>` ([:5974](src/Alfred.jsx#L5974)) |
| **`ExecutionBadge`** | [:7293](src/Alfred.jsx#L7293) | **4 places** — home ×2, item detail ×2 | Root `onClick` → `stopPropagation()` then `onOpen(exec)` ([:7299](src/Alfred.jsx#L7299)) |
| **`InboxCard`** | [:4633](src/Alfred.jsx#L4633) | 1 place | **Not navigation** — expands inline |

That is 22 render sites behind 5 navigational components.

**Not** funnelled, and needing individual attention:

- Collection rows. There is **no `CollectionCard`.** The markup is copy-pasted three
  times with a three-line inline handler each: home pinned
  ([:3337](src/Alfred.jsx#L3337)), collections list ([:3832](src/Alfred.jsx#L3832)),
  context detail ([:3516](src/Alfred.jsx#L3516)).
- The top nav itself: nine hand-written `<button>` blocks on desktop, a `.map()` on
  mobile, with the unsaved-changes guard written out **three separate times**.

---

## 5. Blockers

Ordered by how much they will cost.

### 5a. The unsaved-changes guard — the biggest one

`guardedSetView` ([:721-733](src/Alfred.jsx#L721)) fires `window.confirm()` before
navigating when a form is dirty, tracked in `unsavedChangesRef`. Ten
`onDirtyChange`/`setUnsavedChanges` wirings feed it (`ItemCard`, `IntentionCard`,
`ContextForm`, `InboxCard`, `CollectionAddItems`, the detail views).

This is fundamentally incompatible with a plain `<a href>` **for same-tab clicks**:
you cannot `preventDefault()` a link after an async confirm without reimplementing the
navigation, and blocking on `confirm()` inside a click handler that also has a default
action is fragile.

**But it is not a blocker for the feature actually being asked for.** Middle-click and
Ctrl/Cmd-click open a *new* tab and leave the current one untouched — the dirty form
is not going anywhere, so the guard should not run at all. The correct shape is a link
whose `onClick` checks `e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1` and
returns early, letting the browser do its thing; otherwise it `preventDefault()`s and
runs the existing guarded path. That check needs to exist in one wrapper component,
not 34 times.

Note also that the guard logic is **triplicated** ([:3019](src/Alfred.jsx#L3019),
[:3176](src/Alfred.jsx#L3176), [:3195](src/Alfred.jsx#L3195)) in the
Sam/Timer/mobile-drawer handlers rather than calling `guardedSetView`. Any fix has to
catch all four copies.

### 5b. Nested clickable areas — every card

Every shared card is a clickable container with buttons inside it. Making the container
an `<a>` puts interactive elements inside a link, which is invalid HTML and behaves
badly (middle-clicking the button region would open a tab).

- `IntentionCard` ([:8791](src/Alfred.jsx#L8791)): root `onClick` navigates; contains
  **Do Today** and **Start Now** buttons, both `stopPropagation()`; and may contain a
  nested `EventCard`, which is itself clickable ([:8856](src/Alfred.jsx#L8856)).
- `EventCard` ([:9001](src/Alfred.jsx#L9001)): clickable text region beside
  **Continue** / **Start** buttons.
- `ContextCard` ([:5974](src/Alfred.jsx#L5974)): clickable region beside a Settings
  button.
- `ItemCard` ([:7858](src/Alfred.jsx#L7858)): whole card clickable; renders
  `ExecutionBadge` children that are *also* clickable and `stopPropagation()`.
- `CollectionAddItems` rows ([:603-621](src/Alfred.jsx#L603)) have checkbox and
  quantity inputs with `stopPropagation()`.

13 `stopPropagation()` calls in `Alfred.jsx` mark exactly these overlaps. The standard
fix is the "stretched link" pattern — an absolutely-positioned `<a>` overlay with the
real buttons raised above it — applied inside the five shared components.

### 5c. Handlers that do work before navigating

These cannot become plain links; they must stay buttons (which is fine — they are
actions, not navigation).

| Handler | Side effect before navigating |
|---|---|
| `startNowFromItem` ([:2711](src/Alfred.jsx#L2711)) | creates an intention, an event **and** an execution row, then `setView("execution-detail")` |
| `startNowFromIntention` ([:2788](src/Alfred.jsx#L2788)) | creates an event + execution, flattens item elements |
| New Collection ([:3778](src/Alfred.jsx#L3778)) | `await addCollection(...)`, then navigates to the id it just got back |
| Delete Collection ([:4137](src/Alfred.jsx#L4137)) | `confirm()` → delete → navigate away |
| `handleEditContextFromDetail` ([:2565](src/Alfred.jsx#L2565)) | sets `editingContext` + `showContextForm`, **then** `setView("contexts")` — the destination renders a *modal* whose open/closed state is not in the view |
| Mobile drawer items ([:3019](src/Alfred.jsx#L3019)) | `setMenuOpen(false)` after navigating |
| Sam / Timer tabs | `setPreviousView(view)` before navigating |

Note the last two: a link that opens in a new tab will **not** run `setMenuOpen(false)`
or `setPreviousView(view)`. That is correct behaviour for the new tab, but the
*current* tab will be left with its drawer open. Worth handling explicitly.

### 5d. Destinations that depend on state not in the URL

- **`execution-detail` holds an object, not an id.** `activeExecution` is the whole
  execution record ([:658](src/Alfred.jsx#L658)), set directly by `openExecution(exec)`
  and by the three `startNow*` paths. A URL can only carry the id, so this view needs
  an id → object lookup. It is recoverable — `activeExecutions` and `pausedExecutions`
  are both loaded at boot — but it is a real change, not a rename.
- **Modal/form state** — `showContextForm`, `editingContext`, `editingQuantityItemId`,
  `addSheetOpen`, `pendingImport`, and `isEditing` inside every card.
- **Filter/tab state** — `filterTag`, `collectionContextFilter`, `executionTab`,
  `recycleTab`, `expanded`. Reasonable candidates for query params, but out of scope.
- **The three back-stacks** in §3. `itemHistoryStack` in particular exists precisely
  because item → item drill-down has no URL to lean on.

### 5e. SAM's `pushState` island will conflict

If a router is mounted at `App.js`, [SongLoader.jsx:213-233](src/sam/components/SongLoader.jsx#L213)
becomes a second, competing owner of the History API on the same page. Its `popstate`
handler runs on *every* history event, not just its own, and would flip `samView` to
`"landing"` on any unrelated navigation. This must be migrated in the same change, not
left for later.

### 5f. Hosting

Per §1, `vercel.json` has no SPA catch-all. Verify before doing anything else.

---

## 6. Deep-link readiness

**Today: no. Pasting any URL other than `/oauth/consent` gives you Alfred's home
page.** `App.js` does not read anything else, and `view` initialises to `"home"`
unconditionally. There is nothing to test.

**Once URLs exist: yes, and easily — this is the strong part of the codebase.**

`loadData()` ([:945-992](src/Alfred.jsx#L945)) runs once at boot and fetches
**everything** in a single `Promise.all`:

```js
supabase.from("contexts").select("*"),
supabase.from("items").select("*"),
supabase.from("intents").select("*"),
supabase.from("events").select("*"),
supabase.from("inbox").select("*"),
supabase.from("item_collections").select("*"),
supabase.from("executions")...eq("status","active"),
supabase.from("executions")...eq("status","paused"),
```

plus `loadCollectionMembers(...)` for every collection. The whole app renders behind
`dataLoaded` ([:2899](src/Alfred.jsx#L2899)), so **no screen depends on a fetch
performed by a previous screen**. Every detail view is a `.find()` over an
already-populated array. A URL carrying an id is sufficient in every case.

The few things loaded lazily are already keyed on `view` and would fire correctly on a
cold deep link:

- Collection removals + history — `useEffect` on `[view, selectedCollectionId]`
  ([:882-897](src/Alfred.jsx#L882)).
- Recycle bin — `useEffect` on `[view, recycleTab]` ([:1258-1265](src/Alfred.jsx#L1258)).
- SAM songs — `fetchSongById(id)` on demand, in `handleLoadFromLibrary`
  ([SongLoader.jsx](src/sam/components/SongLoader.jsx)), which is *better* placed for
  deep linking than Alfred is; SAM just never puts the id in the URL.

Two things to handle:

1. **Auth race.** A cold deep link lands on `LoginScreen` if not signed in. The
   intended destination must survive the OAuth round trip — `redirectTo` is currently
   `window.location.origin` ([:344](src/Alfred.jsx#L344)), which discards the path.
2. **Bad or unreadable ids.** `.find()` returns `undefined`, and the render guards
   (`view === "item-detail" && selectedItemId`) only check that an *id* exists, not
   that it *resolves*. A deep link to a deleted or RLS-invisible row will render an
   empty or crashed detail view. Needs a not-found path.

---

## Assessment

### It is a mix, but the ratio is lopsided: roughly 80% give-things-URLs, 20% swap-buttons-for-links.

You cannot start with the top nav buttons. Nine `<a href>`s pointing nowhere is not an
improvement — the URLs have to exist first, which means introducing a router, deriving
`view` + `selectedXId` from the path, and retiring `previousView`,
`intentionReturnView`, and `itemHistoryStack` in favour of real browser history.

The sequencing that falls out of the findings:

1. **Confirm the SPA rewrite on Vercel.** Cheap, and everything else is wasted if a
   cold URL 404s.
2. **Add a router and a route table** mirroring the 18 `view` values. Keep `setView`
   working as a thin wrapper at first so nothing breaks all at once.
3. **Put ids in the URL** for the six id-bearing views. Convert `activeExecution` from
   object-in-state to id-plus-lookup (§5d).
4. **Build one `<AppLink>`** that renders an `<a href>`, lets modified clicks through
   to the browser untouched, and routes plain clicks through the existing
   unsaved-changes guard. This is the single component that makes middle-click work.
5. **Apply it in the shared wrappers** (§4) — `ItemCard`, `IntentionCard`, `EventCard`,
   `ContextCard`, `ExecutionBadge`, plus a new `CollectionCard` to de-duplicate the
   three copy-pasted collection rows. This is where the leverage is: six components
   cover 22 existing render sites plus the 3 collection rows.
6. **Convert the nav bars** — desktop tabs and mobile drawer. Consolidate the
   triplicated guard while you are in there.
7. **Migrate SAM's `pushState` island** into the router (§5e) and give SAM songs a URL.

### Files affected: about 11, but the weight is in one

| File | Scope of change |
|---|---|
| [src/Alfred.jsx](src/Alfred.jsx) | **~90% of the work.** 9,059 lines, 18 views, 34 nav `onClick`s, 6 shared card components, 3 back-stacks, the whole state machine. |
| [src/App.js](src/App.js) | Mount the router; retire the `/oauth/consent` special case. |
| [src/sam/components/SongLoader.jsx](src/sam/components/SongLoader.jsx) | Remove the `pushState`/`popstate` island; route `/stats` properly. |
| [src/sam/components/StatsPage.jsx](src/sam/components/StatsPage.jsx) | `history.back()` → router back. |
| [src/sam/components/BrowseTabs.jsx](src/sam/components/BrowseTabs.jsx) | Song rows → links (2 row components). |
| [src/sam/components/ContinueSection.jsx](src/sam/components/ContinueSection.jsx) | `ContinueRow` → link. |
| [src/sam/components/FamilySheet.jsx](src/sam/components/FamilySheet.jsx) | Song rows → links. |
| [src/sam/SamPlayer.jsx](src/sam/SamPlayer.jsx) | `onBack`; song id in URL. |
| [src/timer/TimerPage.jsx](src/timer/TimerPage.jsx) | `onBack` only. Trivial. |
| [vercel.json](vercel.json) | SPA catch-all rewrite. |
| [package.json](package.json) | Add the router dependency. |

**Honest read on effort:** a minimal version — router + URLs for the nine top-nav
destinations + `<AppLink>` in the nav bars — is genuinely small and delivers the
middle-click behaviour where it is most wanted. Extending it through the detail views
and the shared cards is the larger and more valuable half, and it is where the
unsaved-changes guard and the nested-button problem have to be confronted properly. I
would not try to do both in one pass on a 9,000-line file.
