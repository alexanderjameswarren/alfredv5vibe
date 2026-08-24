# Progress: Real URLs for Alfred Navigation (Slice 1)

## Status: **Slice 1 complete.** All 10 steps done and verified in the app.

Reference: `docs/technical-spec-navigation-urls.md`

Stop after each step and wait for human verification before continuing.

### Development Steps

- [x] **Step 1 — Confirm the history island.** _(done 2026-08-20 — see "Step 1 findings" below)_ Read-only. Re-grep `pushState`,
      `replaceState`, `popstate`, `window.history`, `window.location` across
      all of `src/`. Report every hit. Document exactly what `SongLoader.jsx`
      pushes, when, and what its `popstate` handler does. Flag any second
      island the original investigation missed. No code changes.

- [x] **Step 2 — Mount the router, change nothing else.** _(done 2026-08-20)_ Install
      `react-router-dom`. Wrap the app in `BrowserRouter` in `App.js`. Keep
      `/oauth/consent` working as a route. A catch-all route renders `<Alfred />`
      exactly as today. Alfred still uses its `useState` view internally — this
      step must be behaviourally invisible.

- [x] **Step 3 — Build the view↔path map.** _(done 2026-08-20)_ All 18 view values get a path.
      Document the full table in this file. No wiring yet.

- [x] **Step 4 — The bridge (highest risk step).** _(done 2026-08-20)_ Derive
      `view` from the URL; reimplement `setView` as a navigate wrapper. Delete
      the `useState` at `Alfred.jsx:652`. **Zero edits to the 39 call sites** —
      if a call site needs changing, stop and ask rather than editing it.

- [x] **Step 4b — Switch the Supabase client to `flowType: 'pkce'`.** _(done 2026-08-20)_ Added
      2026-08-20 at Alex's direction. Rationale is the Step 2 correction above:
      the implicit flow ends with `window.location.hash = ''`
      ([GoTrueClient.js:1536](node_modules/@supabase/auth-js/dist/main/GoTrueClient.js#L1536)),
      which both leaves `/#` in the address bar and **creates a history entry**.
      Now that Step 4 has made browser Back real, that entry is reachable —
      pressing Back after login can surface a URL containing
      `#access_token=…`. PKCE uses `replaceState` instead: no entry, no
      leftover fragment. Touches auth, so it gets its own step and its own
      sign-in test rather than riding along with routing work.

- [x] **Step 5 — Consolidate the unsaved-changes guard.** _(done 2026-08-20)_ Replace the three
      inlined copies (Sam, Timer, mobile drawer) with calls to the single
      `guardedSetView`. Behaviour identical.

- [x] **Step 6 — Build `<AppLink>`.** _(done 2026-08-20)_ Real `<a href>`. Modifier/middle click:
      no `preventDefault`, let the browser act. Plain click: `preventDefault`
      then route through `guardedSetView`.

- [x] **Step 7 — Swap the nine top-nav buttons to `<AppLink>`.** _(done 2026-08-20)_ Visual
      appearance must not change.

- [x] **Step 8 — Migrate the SAM history island.** _(done 2026-08-20)_ Add `/sam` and
      `/sam/songs/:songId`. Remove all `pushState`/`popstate` code from
      `SongLoader.jsx`. Back-closes-song must feel identical to today.

- [x] **Step 9 — Cold-load and redirect handling.** _(done 2026-08-20)_ Every path loads from a
      fresh tab. `execution-detail` and any other non-reconstructable view
      redirects to its parent instead of rendering broken. Unknown paths
      redirect to `/`.

- [x] **Step 10 — Back-stack audit (documentation only).** _(done 2026-08-20)_ Describe what
      `previousView`, `intentionReturnView`, and `itemHistoryStack` each do,
      and where browser back would now disagree. Recommend keep or replace.
      No code changes.

### Verification Steps

All verified in the running app by Alex.

- [x] Middle-click each of the nine top-nav items — opens correct screen in new tab
- [x] Ctrl/Cmd-click same — same result
- [x] Plain click each — unchanged behaviour
- [x] Dirty a form, plain-click away — confirm dialog still fires
- [x] Dirty a form, middle-click away — no dialog, current tab untouched, new tab correct
- [x] Browser back/forward across several top-nav moves
- [x] Open a SAM song, press back — song closes, does not exit SAM
- [x] Paste each of the 18 paths into a fresh incognito tab _(the 11 cold-loadable
      ones land directly; the 7 detail paths redirect to their parent, which is
      the specified behaviour — see Step 9)_
- [x] Visit `/testing` — redirects to home, no error
- [x] `/oauth/consent` still works end to end
- [x] Signed-out deep link survives sign-in _(added at Step 9)_

### View → Path Table

Filled in at Step 3. All 18 `view` values, verified against the render guards
in `Alfred.jsx` (line numbers current as of 2026-08-20).

**Invariant: stripping the last segment of a detail path yields its parent
path.** Step 9's cold-load redirect is then mechanical rather than a second
hand-maintained table.

| # | View value | Path | Render guard | Cold-loadable? |
|---|---|---|---|---|
| 1 | `home` | `/` | [:3220](src/Alfred.jsx#L3220) | yes |
| 2 | `inbox` | `/inbox` | [:3399](src/Alfred.jsx#L3399) | yes |
| 3 | `contexts` | `/contexts` | [:3428](src/Alfred.jsx#L3428) | yes |
| 4 | `context-detail` | `/contexts/detail` | [:3481](src/Alfred.jsx#L3481) | **no** → `/contexts` |
| 5 | `schedule` | `/schedule` | [:3615](src/Alfred.jsx#L3615) | yes |
| 6 | `execution-detail` | `/schedule/execution` | [:3590](src/Alfred.jsx#L3590) | **no** → `/schedule` |
| 7 | `intentions` | `/intentions` | [:3650](src/Alfred.jsx#L3650) | yes |
| 8 | `intention-detail` | `/intentions/detail` | [:3526](src/Alfred.jsx#L3526) | **no** → `/intentions` |
| 9 | `memories` | `/memories` | [:3742](src/Alfred.jsx#L3742) | yes |
| 10 | `item-detail` | `/memories/detail` | [:3553](src/Alfred.jsx#L3553) | **no** → `/memories` |
| 11 | `collections` | `/collections` | [:3773](src/Alfred.jsx#L3773) | yes |
| 12 | `collection-detail` | `/collections/detail` | [:3873](src/Alfred.jsx#L3873) | **no** → `/collections` |
| 13 | `collection-history` | `/collections/history` | [:4155](src/Alfred.jsx#L4155) | **no** → `/collections` |
| 14 | `collection-add-items` | `/collections/add-items` | [:4248](src/Alfred.jsx#L4248) | **no** → `/collections` |
| 15 | `settings` | `/settings` | [:4307](src/Alfred.jsx#L4307) | yes |
| 16 | `recycle` | `/recycle` | [:4323](src/Alfred.jsx#L4323) | yes |
| 17 | `timer` | `/timer` | [:2918](src/Alfred.jsx#L2918) — early return | yes |
| 18 | `sam` | `/sam` | [:2910](src/Alfred.jsx#L2910) — early return | yes |

11 cold-loadable, 7 redirect-to-parent. The nine top-nav destinations
(rows 1, 2, 3, 5, 7, 9, 11, 17, 18) are **all** cold-loadable — which is the
whole of Step 7's link surface, so nothing Step 7 makes middle-clickable can
land on a redirect.


### Notes

_Record decisions, surprises, and anything deferred to slice 2._

---

## Step 1 findings — history island audit (read-only, 2026-08-20)

**Verdict: one island, exactly where the investigation said. No second island.
But the island does something different from what the spec assumes.**

### Every hit, by API

| API | Hits | Location |
|---|---|---|
| `pushState` | **1 call** (+2 comments) | [SongLoader.jsx:225](src/sam/components/SongLoader.jsx#L225) |
| `replaceState` | **0** | — |
| `popstate` listener | **1** | [SongLoader.jsx:219](src/sam/components/SongLoader.jsx#L219) |
| `window.history.back()` | **1** | [SongLoader.jsx:233](src/sam/components/SongLoader.jsx#L233) |
| `history.forward` / `history.go` | **0** | — |
| `window.location` (read, nav-relevant) | **3** | [App.js:5](src/App.js#L5), [SongLoader.jsx:27](src/sam/components/SongLoader.jsx#L27), [SongLoader.jsx:224](src/sam/components/SongLoader.jsx#L224) |
| `window.location.href =` (external redirect) | **3** | [OAuthConsent.jsx:65](src/OAuthConsent.jsx#L65), [:83](src/OAuthConsent.jsx#L83), [:114](src/OAuthConsent.jsx#L114) |
| `window.location.origin` (auth `redirectTo`) | **1** | [Alfred.jsx:344](src/Alfred.jsx#L344) |
| `window.location.search` | **1** | [OAuthConsent.jsx:11](src/OAuthConsent.jsx#L11) |
| `<a href>` | **2** | [Alfred.jsx:2939](src/Alfred.jsx#L2939), [:3051](src/Alfred.jsx#L3051) — both the logo, both `href="/"` |
| `window.open` | **0** | — |
| `hashchange` / `unload` | **0** | — |
| service worker | **0** | none registered |

All numbers match the original investigation. Nothing new was found hiding.

### What the island actually does

```
readSamPath()            SongLoader.jsx:25   pathname === "/stats" ? "stats" : "landing"
const [samView] =        SongLoader.jsx:196  useState(readSamPath)   <- runs once, at mount
popstate listener        SongLoader.jsx:213  setSamView(readSamPath())
openStats()              SongLoader.jsx:223  if pathname !== "/stats": pushState({samView:"stats"}, "", "/stats")
                                             then setSamView("stats")
closeStats()             SongLoader.jsx:230  window.history.back()  — and NOTHING else
render branch            SongLoader.jsx:719  samView === "stats" -> <StatsPage onBack={closeStats} />
```

Two entry points into `openStats`: the week-strip tap
([:732](src/sam/components/SongLoader.jsx#L732)) and the family sheet's
"Practice history" button via `handleStatsForFamily`
([:262](src/sam/components/SongLoader.jsx#L262)).

`StatsPage.jsx` writes no history itself — its comment at
[:10](src/sam/components/StatsPage.jsx#L10) describes `history.back()`, but the
call lives in `SongLoader.closeStats`. Doc-only, no code impact.

### Surprise 1 — the island is about `/stats`, not about songs

The spec's "SAM history island" section says the `pushState` is *"presumably so
back closes an open song"*. **It is not.** There is no `pushState` anywhere in
the song-open path. `handleSongLoaded` → `setSong(...)` in `SamPlayer` writes no
history. The only way to close an open song today is the **"Change song"**
button (`handleChangeSong`, [SamPlayer.jsx:680](src/sam/SamPlayer.jsx#L680)).

Browser back with a song open does **not** close the song today — it exits the
whole app (or returns to whatever was in history before Alfred loaded).

This makes **success criterion 5** — *"Inside SAM, back closes an open song —
same felt behaviour as today"* — self-contradictory: today's felt behaviour is
that back does not close the song. Step 8 is therefore a **new feature**, not a
migration. Flagging rather than deciding; see "Question for Alex" below.

### Surprise 2 — the listener is conditionally mounted, which makes the collision worse, not better

`SongLoader` renders only when `!song` inside `SamPlayer`
([SamPlayer.jsx:757](src/sam/SamPlayer.jsx#L757)), and `SamPlayer` renders only
on the `view === "sam"` early return ([Alfred.jsx:2910](src/Alfred.jsx#L2910)).
So the `popstate` listener exists **only on the SAM landing screen** — not
across the app, and not while a song is open.

That is not a mitigation. It means the two owners disagree *asymmetrically*:

- **On SAM landing:** the listener is live and fires on *every* `popstate`,
  including ones the router caused. Any router back/forward while on SAM landing
  runs `setSamView(readSamPath())`, which returns `"landing"` for every path that
  isn't `/stats` — a spurious state write on unrelated navigation.
- **With a song open:** the listener is gone, so `samView` silently goes stale
  and no one reacts to `popstate` at all.

### Surprise 3 — `closeStats` is already a live bug on cold load

`closeStats()` calls `history.back()` and deliberately does not `setState`,
relying on the `popstate` listener to flip `samView`. That only works if
`openStats()` actually pushed an entry.

Cold-load `/stats` → `App.js` renders `<Alfred />` → `view` starts `"home"`, so
`SongLoader` is unmounted and no push ever happens. Click **Sam**: `SongLoader`
mounts, `readSamPath()` reads the stale `/stats`, and StatsPage renders
unrequested (the oddity §2 of the investigation already recorded). Press its
**Back** button and `history.back()` now pops the entry *before Alfred* — the
user leaves the app entirely instead of returning to SAM landing.

Pre-existing, reproducible today, and it disappears for free once `/stats` is a
real route. Recording it so it isn't mistaken for a regression introduced by
this slice.

### Adjacent confirmations (not history writers, but they own paths)

- **`App.js:5`** is a read-once `pathname` check with no listener — a third
  quasi-dispatch. It must become a real route in Step 2, not stay alongside one.
- **`vercel.json`** is now catch-all only: `{ "source": "/(.*)" }`. The explicit
  `/oauth/consent` rewrite was **replaced**, not added to. The catch-all covers
  it, so nothing is broken — but the change is **uncommitted** in the working
  tree. Worth committing before Step 2 so the router work isn't sitting on top
  of unversioned hosting config.
- **`beforeunload`** ([Alfred.jsx:734](src/Alfred.jsx#L734)) guards the same
  `unsavedChangesRef` as `guardedSetView`. It is not a history writer and does
  not fire on client-side routing — so mounting a router does not change it, but
  it also will not cover router navigation. `<AppLink>`'s plain-click branch
  (Step 6) remains the only thing that protects a dirty form on in-app nav.
- **`Alfred.jsx:344`** — `redirectTo: window.location.origin` discards the path.
  Every deep link survives a signed-in cold load but loses its destination
  through the OAuth round trip. Deferred to Step 9; noting it here so it isn't
  re-discovered as a Step 9 surprise.

### Question for Alex (blocking Step 8, not Steps 2–7)

Success criterion 5 assumes back-closes-song is existing behaviour. It isn't.
Which is intended?

- **(a)** Add it — `/sam` vs `/sam/songs/:songId`, back closes the song. New
  behaviour, matches the spec's stated route shape, changes a daily-use flow.
- **(b)** Preserve today's behaviour exactly — song id in the URL for deep
  linking and new-tab, but back keeps exiting SAM as it does now.

Not needed until Step 8. Steps 2–7 are unaffected.

### Verified in the running app by Alex, 2026-08-20

All three predicted behaviours reproduced exactly:

- **A — back with a song open:** leaves Alfred entirely. Confirms there is no
  `pushState` on the song-open path, and that "back closes the song" does not
  exist today. Success criterion 5 is a new feature.
- **B — cold-load `/stats`:** home page renders with `/stats` in the address
  bar; clicking **Sam** then lands on the stats stub unrequested; its **Back**
  button leaves Alfred entirely. Confirms the `closeStats` cold-load dead end.
- **C — normal `/stats` round trip:** week-strip tap → `/stats`, page Back and
  browser back both return to SAM landing. This is the one path that works, and
  it is the behaviour Step 8 must preserve.

Step 1 closed. No open items blocking Step 2.

---

## Step 2 findings — router mounted (2026-08-20)

### What changed

| File | Change |
|---|---|
| `package.json` / `package-lock.json` | `react-router-dom@^6.30.1` added (resolved 6.30.6, +3 packages) |
| [src/App.js](src/App.js) | Hard-coded pathname check → `BrowserRouter` + two routes |

**Nothing else.** `Alfred.jsx` is byte-identical to how this session found it,
`setView(` still counts **39**, and Alfred still owns its `view` `useState`. It
does not read the URL yet — that is Step 4.

### Decision: react-router v6, not v7

v7.18 is current, but v6.30 is the proven pairing with `react-scripts` 5.0.1 /
React 18.3.1. Every API this slice needs (`BrowserRouter`, `Routes`, `Route`,
`useNavigate`, `useLocation`, `useParams`, `Navigate`) is identical across the
two majors, so a later bump is a drop-in with no call-site churn. Absorbing a
major-version surface in the same slice as the bridge is risk with no payoff.

### Why the catch-all keeps this invisible

```jsx
<Route path="/oauth/consent" element={<OAuthConsent />} />
<Route path="*"              element={<Alfred />} />
```

`path="*"` matches every non-consent path, so navigating between any two of
them resolves to the *same* route with the *same* `<Alfred />` element in the
same tree position. React reconciles rather than remounts: Alfred keeps `view`,
`dataLoaded`, and every other piece of state. No refetch, no flash to home.

`/oauth/consent` matched exactly before and matches exactly now. The one
difference is that v6 also matches the trailing-slash form `/oauth/consent/`,
which previously fell through to Alfred. Wider, harmless, arguably a fix.

### The SAM island still works, and it is worth knowing why

The island from Step 1 now shares the page with the router, and this step does
not touch it. It survives because the two owners happen not to collide *yet*:

- `openStats()`'s raw `pushState` writes the URL without notifying the router.
  The router's location goes stale, but `path="*"` matched before and after, so
  there is nothing for it to re-render differently. Alfred does not remount.
- `closeStats()`'s `history.back()` fires one `popstate`, which **both** owners
  hear. The router moves `/stats` → `/` (still `path="*"`, still no remount);
  SongLoader's listener flips `samView` to `"landing"`. Same outcome as before.

This is coexistence by luck of the catch-all, not by design, and it stops
holding at Step 4 when the router's location starts driving `view`. The island
is still scheduled for deletion in Step 8 — nothing here changes that.

### Checks run

- `react-scripts test --watchAll=false` — **11 suites, 188 tests, all pass**
- `npm run build` — **compiled successfully**, bundle 260.56 kB gzip
  (**+5.62 kB** for the router)

### Verified in the running app by Alex, 2026-08-20

- **A — normal navigation:** unchanged. No reloads, no flash to Home.
- **B — Alfred does not remount:** *the back button is **disabled***. Stronger
  confirmation than predicted: with only one history entry in the tab, Alfred's
  entire nav is invisible to the History API, which is exactly the Step 2
  contract. (The prediction was worded assuming an enabled back button — the
  observation is the same conclusion, reached more directly.)
- **C — `/oauth/consent`:** works.
- **D — SAM island:** identical to Step 1. **But the address bar reads `/#`.**
- **E — unknown paths:** `/testing` renders home, path preserved.

---

## Correction to Step 1 — a history writer outside `src/`

Step 1 was scoped to `src/`, as the step text specified, and its conclusion
("one island, no second island") is correct **within that scope**. Alex's `/#`
observation exposes the scope itself as too narrow: a **dependency** writes to
the History API too.

`@supabase/auth-js` (`GoTrueClient.js`) does both:

| Line | Call | When |
|---|---|---|
| [:1536](node_modules/@supabase/auth-js/dist/main/GoTrueClient.js#L1536) | `window.location.hash = ''` | implicit-flow login, after parsing tokens out of the URL |
| [:1498](node_modules/@supabase/auth-js/dist/main/GoTrueClient.js#L1498) | `window.history.replaceState(...)` | PKCE flow, stripping `?code=` |

This app is on the **implicit** path: `createClient` is called with no options
([supabaseClient.js:6](src/supabaseClient.js#L6)), so `flowType` defaults to
`implicit` and `detectSessionInUrl` defaults to `true`. Google OAuth
([Alfred.jsx:340](src/Alfred.jsx#L340)) returns to
`window.location.origin` + `#access_token=…`, auth-js clears the fragment, and
the URL is left as `/#` for the rest of the session. That is the `/#`.

### Does it matter?

**Not today, and not for Step 3.** `BrowserRouter` matches on `pathname`; `/#`
has pathname `/`, so `path="*"` matches and nothing misbehaves. `readSamPath()`
reads `pathname` too, so the island is unaffected.

**It matters from Step 4 onward,** for three reasons:

1. `location.hash = ''` is a navigation the router never hears about, so the
   router's location can go stale at login — the same failure class as
   `SongLoader`'s `pushState`, but in code we do not own and cannot delete.
2. Assigning `location.hash` **creates a history entry**. Once Step 4 makes back
   meaningful, an entry containing `#access_token=…` may become reachable by
   pressing back after login. Harmless today because back is inert.
3. It compounds the known auth race: `redirectTo: window.location.origin`
   discards the path, so every deep link loses its destination through the OAuth
   round trip and lands on `/#`.

Switching the client to `flowType: 'pkce'` moves this from a hash assignment to
a `replaceState` — no history entry, no leftover `#`, and a cleaner URL for
Step 9's cold-load work. Recorded as a **candidate for Step 9**, not actioned:
it changes the auth flow and is outside this step.

### One open detail

A hash assignment should leave ≥2 history entries, yet Alex observed back
**disabled**. Either the `/#` predates this tab (session restored from
localStorage, URL carried over) or the browser collapsed the entry. Cosmetic
either way — it does not change any conclusion above — but worth settling
before Step 9 relies on history depth.

---

## Step 3 findings — the view↔path map (2026-08-20)

**Documentation only. No files created, no code changed.** The table above is
the deliverable; the module that encodes it lands in Step 4, where it is
actually consumed. Creating it now would add an unimported file whose shape
Step 4 might change.

### Re-derived from source, not copied from the investigation

18 `view === "..."` render guards, matching the investigation exactly. Also
re-counted: **39** `setView(` — unchanged.

Worth knowing before Step 4: **11 of the 39 `setView(` calls pass a non-literal
value**, so the bridge cannot special-case a fixed list of strings — it has to
map whatever it is handed:

| Call | Line |
|---|---|
| `setView(newView)` (inside `guardedSetView`) | [:730](src/Alfred.jsx#L730) |
| `setView(previousView)` ×5 | [:1805](src/Alfred.jsx#L1805), [:2034](src/Alfred.jsx#L2034), [:2091](src/Alfred.jsx#L2091), [:2561](src/Alfred.jsx#L2561), [:3609](src/Alfred.jsx#L3609) |
| `setView(intentionReturnView)` | [:2531](src/Alfred.jsx#L2531) |
| `setView(item.key)` — mobile drawer `.map()` | [:3027](src/Alfred.jsx#L3027) |
| `setView(previousView \|\| "home")` ×2 | [:2913](src/Alfred.jsx#L2913), [:2921](src/Alfred.jsx#L2921) |
| `setView(previousView \|\| "collections")` | [:3890](src/Alfred.jsx#L3890) |

All three return-address states default to `"home"`
([:696-698](src/Alfred.jsx#L696)), so the bare `setView(previousView)` at
[:3609](src/Alfred.jsx#L3609) — the only one with no `||` fallback — is safe
even on a cold load. No null can reach the map.

### Decision: no ids in URLs this slice

The seven detail views keep their ids in React state and get **id-less** paths.
This is forced, not preferred. Every id-bearing navigation looks like:

```js
function viewContextDetail(contextId) {
  setPreviousView(view);
  setSelectedContextId(contextId);   // React state — not flushed yet
  setView("context-detail");         // the bridge sees only this string
}
```

A `setView` reimplemented as `navigate(path)` runs synchronously inside the
handler, before `selectedContextId` has updated. There is no way for the id to
reach the URL without threading it through `setView` — which means editing the
call sites, which is the one thing this slice forbids. Same shape at
`viewIntentionDetail` ([:2517](src/Alfred.jsx#L2517)), `viewItemDetail`
([:2534](src/Alfred.jsx#L2534)), and `openExecution`.

This matches the spec's cold-load section: detail views "get a path but must
redirect to their parent view when loaded cold". Ids arrive in a later slice,
and the parent segment survives that change — `/contexts/detail` becomes
`/contexts/:contextId`, so the work is not thrown away.

### Naming choices worth a second opinion

- **`/memories/detail` for `item-detail`.** The entity is an *item*; the list
  view is *memories*. `/items/detail` reads better in isolation but breaks the
  parent-stripping invariant, since its parent is `/memories`. I kept the
  invariant. Slice 2 would become `/memories/:itemId`.
- **`/schedule/execution` for `execution-detail`.** Reached from three places
  (home, item detail, event cards) with a varying `previousView`, so its
  "parent" is a judgement call. Schedule is where events live, so cold loads
  land there. Nesting also preserves the invariant.
- **`/collections/add-items`** is an action, not a resource, and reads oddly as
  a URL. Left as-is: it is a real destination in the state machine and needs an
  address like the rest.

### Deferred, flagged now so Step 8 does not rediscover it

`/stats` is a live URL today and is **not** in this table — it is SAM-internal,
owned by the island, not a `view` value. Step 8 should move it to `/sam/stats`
so all SAM addresses sit under one prefix. Nothing links to `/stats`
externally, so the rename is free.

### Collision check

None of the 18 paths collide with each other or with `/oauth/consent`. All are
lowercase; react-router v6 also matches the trailing-slash form of each.

---

## Step 4 findings — the bridge (2026-08-20)

### Adjustment 1 (from Alex's review): parent-stripping is a tiebreaker

Recorded and implemented. `parentPath()` in [src/viewPaths.js](src/viewPaths.js)
strips the last segment *by default*, but consults a `PARENT_OVERRIDES` table
first. It is empty today. If a future path needs a name the pattern would
mangle, add the redirect by hand rather than bending the name to fit.

### Adjustment 2 (from Alex's review): Step 4b added

Added to the step list above. **Not done in this step.**

### What changed

| File | Change |
|---|---|
| [src/viewPaths.js](src/viewPaths.js) | **New.** 87 lines. Pure data + 4 lookups, no React, no router import. |
| [src/viewPaths.test.js](src/viewPaths.test.js) | **New.** 20 tests pinning the fallback contract. |
| [src/Alfred.jsx](src/Alfred.jsx) | **Two edits.** Import line; the 15-line bridge replacing the `useState`. |

`setView(` still counts **exactly 39**. No call site was touched.

> Counting note: the bridge comment deliberately contains no literal
> `setView(` syntax. An earlier draft mentioned it in prose and pushed the
> grep count to 40 — a false positive that would have looked like a violated
> constraint at every future step.

### The bridge

```js
const location = useLocation();
const navigate = useNavigate();
const currentPath = normalizePath(location.pathname);
const view = pathToView(location.pathname);
const setView = useCallback((nextView) => {
  const path = viewToPath(nextView);
  navigate(path, { replace: path === currentPath });
}, [navigate, currentPath]);
```

`view` is a derived `const`, so every `view === "..."` render guard and every
`[view]` effect dependency keeps working unchanged — they read a string that
now happens to come from the URL.

### Decision: same-path navigations replace rather than push

Not in the spec, but the bridge is wrong without it. `setView("memories")`
while already on `/memories` used to be an inert re-render. A naive
`navigate()` would push a duplicate history entry, so the next Back press
would appear to do nothing — a visible regression from simply clicking the tab
you are already on. Same-path navigations therefore use `{ replace: true }`.

This also absorbs item→item drill-down, where the path is identical for every
item in the chain. Browser Back consequently leaves `/memories/detail` in one
press rather than walking the chain, while the in-app Back button still walks
`itemHistoryStack`. **That is a genuine disagreement between the two Backs** —
exactly the question Step 10 exists to answer. Noted, not fixed.

### Verified constraints

- **Non-literal values.** `viewToPath` is a lookup with a fallback, not a
  fixed list, so `setView(previousView)`, `setView(item.key)` and the other
  nine runtime call sites map like any other.
- **Unknown values fall back to home, never crash.** Covered by test for
  `undefined`, `null`, `""`, unknown strings, numbers and objects. Nothing
  produces `/undefined`.
- **Unknown *paths* render home without rewriting the URL** — `/testing`
  behaves exactly as it did before. Redirecting is Step 9, not this step.
- **No ESLint fallout.** `setView` changing from a `useState` setter to a
  `useCallback` would break `exhaustive-deps` for any hook that calls it.
  Checked first: no `setView` call sits inside a `useEffect`/`useCallback`/
  `useMemo`. Confirmed by a `CI=true` build — the setting Vercel uses, where
  warnings are errors — which compiled clean.
- **SAM island untouched, guard untouched, no links added.**

### The SAM island under a live bridge — still fine, still on borrowed time

`openStats()`'s raw `pushState` writes `/stats` without telling the router, so
the router's location stays `/sam` and `view` stays `"sam"`. SAM keeps
rendering; no visible change. `closeStats()`'s `history.back()` fires a
`popstate` that both owners hear, and both land on `/sam`.

One new wrinkle worth knowing before Step 8: if you open stats and then use
SAM's own Back arrow, the router pushes from its stale location and the
`/stats` entry is left behind in history. Pressing Back later lands on
`/stats`, which `pathToView` does not recognise, so it falls back to home —
home rendered under a `/stats` URL. No crash, and Step 8 deletes the cause.

### Checks run

- `viewPaths` suite — **20 tests pass**
- Full suite — **12 suites, 208 tests, all pass**
- `CI=true npm run build` — **compiled successfully**, 261.89 kB gzip
  (**+1.32 kB**)

---

## Step 5 findings — the unsaved-changes guard (2026-08-20)

### Surprise: the guard was quintuplicated, not triplicated

The investigation and the spec both say three inline copies (Sam, Timer,
mobile drawer). There were **five**, plus the canonical one in
`guardedSetView` — six occurrences of the confirm block in total. The two the
investigation missed:

| Copy | Function | Back-stack state it drives |
|---|---|---|
| [:2562](src/Alfred.jsx#L2562) | `handleBackFromIntentionDetail` | `intentionReturnView` |
| [:2585](src/Alfred.jsx#L2585) | `handleBackFromItemDetail` | `itemHistoryStack`, `previousView` |

**Both left untouched.** They sit inside the hand-rolled back-stack handlers,
which are explicitly out of scope ("do not opportunistically fix … the
back-stacks", slice 3). De-duplicating them would be a two-line change with no
behaviour risk, but it is not this step's call to make. Flagged for Step 10,
which is already auditing those handlers.

This does not block Step 6: neither is a link surface, so `<AppLink>` never
needs to call them.

### The consolidation is a predicate, not a shared navigator

The step says "replace the three inlined copies with calls to the single
`guardedSetView`". Taken literally that is impossible without violating the
slice's hard constraint, and the reason is structural rather than stylistic:

| Copy | Work it does *after* the confirm passes |
|---|---|
| Mobile drawer | `setPreviousView` (sam/timer only) → `setView(item.key)` → `setMenuOpen(false)` |
| Timer tab | `setPreviousView(view)` → `setView("timer")` |
| Sam tab | `setPreviousView(view)` → `setView("sam")` |

Each interleaves its own side effects between the guard and the navigation, so
a function that guards *and* navigates cannot serve them. Routing all three
through `guardedSetView` would have deleted their `setView` calls and dropped
the count from 39 to 36 — the tripwire.

So the reusable part extracted is the **question**, not the navigation:

```js
function confirmDiscardIfDirty() { ... returns true if safe to navigate ... }

function guardedSetView(newView) {
  if (!confirmDiscardIfDirty()) return;
  setView(newView);
}
```

Each of the three copies became a single line — `if (!confirmDiscardIfDirty())
return;` — with its side effects and its `setView` call left byte-for-byte
intact. One guard implementation, four call sites, **39 preserved**.

`<AppLink>` (Step 6) gets `confirmDiscardIfDirty()` to call, which is what the
spec's prerequisite actually needs.

### Flag for Step 7, decide before starting it

Step 7 swaps the nine top-nav buttons for `<AppLink>`. Those buttons contain
seven `guardedSetView(...)` calls and the two inline `setView(...)` calls just
touched — so **Step 7 will unavoidably remove `setView` call sites**, and the
count will fall below 39 no matter how it is written. The constraint as
written cannot survive the slice's own deliverable.

Worth settling explicitly before Step 7 starts: the intent is presumably "do
not bulk-rewrite the 39 call sites to accommodate routing", not "the number 39
must never change". Confirming which is meant is cheaper now than mid-step.

### Verified

- `setView(` — **39**, unchanged.
- `guardedSetView(` — **12** (11 calls + 1 definition), unchanged.
- Confirm-block occurrences — **6 → 3** (one canonical, two deferred
  back-stack copies).
- Full suite — **12 suites, 208 tests, pass**.
- `CI=true npm run build` — **compiled successfully**, 261.97 kB gzip
  (**−1 byte**; the consolidation is behaviour-neutral and near size-neutral).

---

## Ruling: what "zero edits to the 39 call sites" means

Given by Alex, 2026-08-20, recorded verbatim:

> The constraint is about method, not the number. No call site may change shape
> to accommodate routing. Call sites MAY disappear when the button containing
> them is replaced by a link.

Consequence for Step 7: before editing anything, **predict** the resulting
`setView(` and `guardedSetView(` counts, then report actual against predicted.

---

## Step 6 findings — `<AppLink>` (2026-08-20)

### What changed

| File | Change |
|---|---|
| [src/AppLink.jsx](src/AppLink.jsx) | **New.** 62 lines. |
| [src/AppLink.test.jsx](src/AppLink.test.jsx) | **New.** 24 tests. |

**`Alfred.jsx` was not touched.** Zero references to `AppLink` in it;
`setView(` still 39, `guardedSetView(` still 12. The component exists and is
tested but is wired to nothing — that is Step 7.

### The component

```jsx
function handleClick(e) {
  if (isBrowserHandledClick(e)) return;   // metaKey/ctrlKey/shiftKey/altKey/button===1
  e.preventDefault();
  if (guard && !guard()) return;
  if (onNavigate) onNavigate();
}
return <a href={viewToPath(view)} onClick={handleClick} {...rest}>{children}</a>;
```

Props: `view` (→ `href` via the Step 3 map), `onNavigate` (what the old button
did), `guard` (optional predicate, i.e. `confirmDiscardIfDirty`), plus
pass-through for `className`, `title`, `aria-*`.

### Deliberate details

- **`altKey` added** to the modifier list alongside the four specified. Alt/Option-click
  is "download this link" on several platforms; hijacking it would be the same
  bug as hijacking Ctrl-click.
- **A refused guard still calls `preventDefault()`.** Returning early *before*
  cancelling would let the browser follow the href and navigate anyway — the
  exact data loss the guard exists to prevent. Pinned by a test.
- **The guard never runs on a modified click.** Nothing is navigating away in
  this tab, so the dirty form is not at risk; prompting would be both wrong
  and infuriating. Pinned by five tests.
- **Keyboard Enter takes the plain-click branch.** Browsers translate Enter on
  an anchor into an unmodified click, so it navigates in place. Pinned.
- **`button === 1` is near-vestigial.** Since Chrome 55 middle click dispatches
  `auxclick`, not `click`, so this branch rarely executes — the browser simply
  never calls the handler and opens its tab unimpeded. Kept anyway: it costs
  nothing and covers older browsers and synthetic events.

### Open shape question for Step 7 — worth 30 seconds before it starts

The `guard` prop means there are two legitimate ways to wire a tab, and they
differ in how they land against the ruling above:

| Wiring | Effect on counts |
|---|---|
| `<AppLink view="home" onNavigate={() => guardedSetView("home")}>` | `guardedSetView` call **preserved verbatim**, moved into a prop. `guard` prop unused. |
| `<AppLink view="home" guard={confirmDiscardIfDirty} onNavigate={() => setView("home")}>` | `guardedSetView("home")` **replaced** by `setView("home")` — a call site changing shape. |

The first preserves every call site verbatim and leaves `guard` unused by the
seven simple tabs. The second matches the literal Step 6 contract
("preventDefault, then `confirmDiscardIfDirty()`, then navigate") but rewrites
call sites, which the ruling forbids.

Recommendation: **the first**, with `guard` reserved for callers that have no
guarded wrapper to delegate to. The component supports both; the count
prediction at the top of Step 7 will assume the first.

### Checks run

- `AppLink` suite — **24 tests pass**
- Full suite — **13 suites, 232 tests, pass**
- `CI=true npm run build` — **compiled successfully**

---

## Wiring convention (ruling, 2026-08-20)

**Delegation is the default; `guard` is the exception.**

`onNavigate` preserves the caller's existing guarded call verbatim — e.g.
`onNavigate={() => guardedSetView("home")}`. The `guard` prop is reserved for
callers that have no guarded wrapper to delegate to. All nine top-nav tabs use
delegation; `guard` is currently unused in the app.

---

## Captured for slice 2 — `<AppLink>` on detail cards is not yet safe

Not a slice 1 decision. Recorded so it is not discovered by shipping it.

`AppLink` derives `href` from `viewToPath(view)`. The seven detail views map to
paths that **cannot** be cold-loaded (`/collections/detail`, `/memories/detail`,
…) because their id lives in React state, not the URL. Step 9 makes those paths
redirect to their parent.

So an `<AppLink>` on a detail card would render a real, middle-clickable anchor
whose new tab lands on **the wrong screen** — the parent list, or home. The
gesture would appear to work and quietly do the wrong thing, which is worse
than not offering it.

Two ways out, to be chosen in slice 2:

1. **`AppLink` refuses to render an anchor for a non-cold-loadable view** —
   falls back to a `<button>`, so no middle-click affordance is advertised
   where it cannot be honoured.
2. **Ids land in URLs before the cards are touched** — `/collections/:id` etc.,
   after which detail views are cold-loadable and the problem dissolves.

(2) is the real fix; (1) is a cheap guardrail if the cards are wanted first.
Either way, **the shared cards must not be converted before one of them is
done.**

---

## Step 7 findings — nine top-nav tabs are links (2026-08-20)

### Count prediction vs actual

Predicted before editing, per the ruling:

| Symbol | Baseline | Predicted | Actual | |
|---|---|---|---|---|
| `setView(` | 39 | 39 | **39** | ✓ |
| `guardedSetView(` | 12 | 12 | **12** | ✓ |

Nothing disappeared. **This corrects the flag raised at Step 5**, which
predicted the counts must fall. That assumed the button handlers would be
rewritten; under delegation each handler body moves into `onNavigate`
unchanged, so every call site survives — including Timer's and Sam's
multi-line bodies, which moved verbatim:

```jsx
<AppLink
  view="sam"
  onNavigate={() => {
    if (!confirmDiscardIfDirty()) return;
    setPreviousView(view);
    setView("sam");
  }}
```

### The one appearance-preserving addition

`inline-flex items-center` was added to each tab's class list. This is not a
restyle — it prevents a change.

A `<button>` vertically centres its own content via the UA stylesheet; an `<a>`
does not. These tabs are `min-h-[44px]` with `py-2` around a ~24px line box, so
the anchor's text would have sat ~2px high with the slack falling below it.
Nine tabs shifting 2px is exactly the sort of thing "visual appearance must not
change" is meant to catch. `items-center` reproduces the button's centring.

Everything else — padding, radius, active/inactive colours, `whitespace-nowrap`,
the conditional `view === "..."` class — is byte-identical. Tailwind's preflight
already resets anchor `color` and `text-decoration` to `inherit`, so there is no
blue-and-underlined flash to suppress. The CSS bundle hash did not change.

> Note on the `view` prop: `<AppLink view="home">` sits next to
> `` className={`... ${view === "home" ? ... }`} ``. The prop and Alfred's
> derived `view` const are different things that happen to share a name. No
> shadowing occurs — the className expression is evaluated in Alfred's scope —
> but it reads confusingly and is worth remembering.

### Explicitly not converted

- **The mobile drawer** (nine entries, `.map()` over `item.key`) — still
  `<button>`. "Nine top-nav buttons only." Its handler is unchanged and still
  calls `setView(item.key)` and `setMenuOpen(false)`.
- **Settings and Recycle header icons** (four sites, mobile + desktop).
- Everything in slice 2's list.

A consequence worth stating: **middle-click works on desktop only.** The mobile
drawer offers no new-tab gesture, which is fine — the gesture barely exists on
touch — but the two nav surfaces now differ in kind, not just layout.

### Checks run

- Full suite — **13 suites, 232 tests, pass**
- `CI=true npm run build` — **compiled successfully**, 262.2 kB gzip
  (**+229 B**), CSS unchanged

---

## Step 4b findings — PKCE (2026-08-20)

**Status check first: Step 4b had been recorded only, never executed.** No
`flowType` appeared anywhere in `src/`. Now done.

[src/supabaseClient.js](src/supabaseClient.js) — `createClient` gains
`{ auth: { flowType: 'pkce' } }`. One config change, no call-site impact.

What it changes: the OAuth callback returns `?code=…` instead of
`#access_token=…`, and auth-js clears it with `history.replaceState` rather
than `window.location.hash = ''`. So no spurious history entry, no leftover
`/#`, and the access token never touches the URL.

`OAuthConsent.jsx` was checked before changing this: it signs in with
`redirectTo: window.location.href` and later reads `authorization_id` from the
query string. PKCE deletes only the `code` parameter, so `authorization_id`
survives the round trip.

---

## Step 8 findings — SAM's history island is gone (2026-08-20)

### Ruling applied: this is new behaviour, and the spec was wrong

Per Alex's ruling, [the spec](docs/technical-spec-navigation-urls.md) has been
**corrected in place**, not worked around:

- **Success criterion 5** no longer claims back-closes-song is "the same felt
  behaviour as today". It now states plainly that today back does *not* close a
  song, and that this is new behaviour deliberately added.
- The **SAM history island** section no longer guesses that the `pushState` was
  about songs. It was only ever about the `/stats` stub.

### Exception to the no-ids-in-URLs rule, recorded explicitly

Step 3 established that detail views get id-less paths, because their ids are
set by a separate React state call that has not flushed when `setView` runs —
putting an id in the URL would mean editing the 39 call sites.

**SAM is exempt, and the reason is specific:** SAM's song loading does not go
through `setView` at all. `view` is `"sam"` for every SAM address; which song
is open is decided inside `SamPlayer`, which owns its own `navigate`. No
Alfred call site is involved, so the constraint that forces id-less paths
elsewhere simply does not apply here. `/sam/songs/:songId` is safe.

This is the one place in slice 1 where an id reaches the URL.

### The addresses

| Path | Shows |
|---|---|
| `/sam` | SAM landing (song library) |
| `/sam/songs/:songId` | that song open in the player |
| `/sam/stats` | practice history (renamed from `/stats`) |

`pathToView` treats **anything** under `/sam` as the `sam` view, so Alfred keeps
rendering `SamPlayer` and SAM decides internally which of the three to show.
`viewToPath("sam")` is still `/sam`, so the 18-entry map stays a bijection and
`setView("sam")` is unaffected.

### How back-closes-song works

`SamPlayer` now syncs the URL and the open song in two directions:

1. **URL → state.** One effect keyed on the id in the URL. Id set and nothing
   loaded → fetch it (this is also what makes a cold load work). Id gone →
   tear the song down. Back closes the song because `/sam/songs/x` → `/sam` is
   just an id going from set to null.
2. **State → URL.** A song that finishes loading and has a database id gets its
   address pushed, so Back has something to pop.

Both effects deliberately depend on **only** the value they watch. This is not
laziness — it is load-bearing, and there is an `eslint-disable` on each saying
so. An imported song is open for a moment *before* its insert returns an id, so
the URL is legitimately `/sam` with a song loaded. An effect that also watched
`song` would re-run in that window, read "no id in the URL", and close the song
the user just imported.

`handleChangeSong` no longer tears down directly — it navigates to `/sam` and
lets the same effect do it, so the button and the Back key cannot drift apart.

### The Step 1 cold-load dead end is fixed by construction

`closeStats()` was `window.history.back()`, which walked off the end of the
stack for anyone who arrived on `/stats` directly and dropped them out of the
app. It is now an explicit `navigate("/sam")`, which behaves the same whether
the user arrived by clicking or by pasting the URL.

The stale-path oddity is gone too: `samView` is derived from the router on
every render rather than read once at mount, so there is no stale
`window.location.pathname` to trip over.

### Deleted

Every History API call in `src/` is gone. `grep` for
`pushState|popstate|history.back|window.history` across `src/` now returns
**only comments** — three explaining what used to be there, none executing.

- `readSamPath()` — deleted
- the `popstate` listener and its `useEffect` — deleted
- `pushState` in `openStats` — replaced by `navigate("/sam/stats")`
- `history.back()` in `closeStats` — replaced by `navigate("/sam")`
- `samView` state — now derived from `useLocation()`

### Left alone, on purpose

`/stats` (the old address) is **not** redirected. Nothing links to it and it
was never shared externally, so it falls back to home like any other unknown
path. If you have it bookmarked, say so and it becomes a one-line
`PARENT_OVERRIDES`-style redirect in Step 9.

### Checks run

- Full suite — **13 suites, 240 tests, pass** (8 new for the SAM routes)
- `CI=true npm run build` — **compiled successfully**

---

## Step 9 findings — cold loads and redirects (2026-08-20)

### The contradiction, settled: the Step 2 correction was right

Both observations were real; they were testing different things.

`window.location.origin` is scheme + host + port **by definition** — it cannot
carry a path. Nothing else in the codebase restored one. So signing in *from* a
deep link discarded the destination and landed the user on `/`.

Step 8's incognito test passed because the session was established before the
deep link was followed. Once signed in, `App.js` → Alfred reads the URL and
routes correctly; the broken `redirectTo` is never consulted. The bug only
fires on the **signed-out** deep link — the sharing case.

**Fixed** at [Alfred.jsx:347](src/Alfred.jsx#L347): `redirectTo:
window.location.href`. Safe by existing evidence — `OAuthConsent.jsx` has always
passed `window.location.href` complete with a query string, and that flow works
in production, so the project's redirect allow-list accepts paths. Under PKCE
(Step 4b) the callback appends `?code=`, which auth-js strips after the
exchange, leaving the original address intact.

This is what makes an Alfred URL shareable rather than merely bookmarkable by
someone already signed in.

### The two redirects

One effect in Alfred, running before the auth and `dataLoaded` early returns so
it also corrects the address while the login screen is showing.

| Situation | Action |
|---|---|
| Path is not one the app serves (`/testing`, `/a/b/c`, `/stats`) | `navigate("/", { replace: true })` |
| A detail view whose id is absent (cold load of `/collections/detail`) | `navigate(parentPath(...), { replace: true })` |

`replace` in both cases: a path the app cannot render should not become a
history entry that Back can return the user to.

Redirect targets are proven servable by test — a redirect to another unknown
path would loop.

### Why it cannot fire during ordinary navigation

The effect keys on `detailStateMissing`, which is only true when the view is a
detail view *and* its id is falsy. In normal navigation the id and the view are
set in the same synchronous block, so React 18 batches them and the id is
already present in the first render where `view` is a detail view.

Checked rather than assumed. Every clear-then-navigate pair —
`closeExecution` ([:2133](src/Alfred.jsx#L2133)), `pauseExecution`
([:2190](src/Alfred.jsx#L2190)), `archiveIntention`
([:1904](src/Alfred.jsx#L1904)), `handleBackFromIntentionDetail`,
`handleBackFromItemDetail` — has its two calls adjacent. The background
refresh at [:1083](src/Alfred.jsx#L1083) returns `refreshed || prev`, so a poll
can never null `activeExecution` out from under a viewer.

### Parent-stripping stayed a tiebreaker

The redirect calls `parentPath()`, which consults `PARENT_OVERRIDES` before
falling back to the last-segment rule. The override table is still empty — no
name needed bending — but the escape hatch is on the path the redirect actually
takes, not bolted on beside it.

### `/stats` deliberately not redirected

Confirmed not bookmarked. It falls back to `/` like any other unknown path, and
a test asserts it stays unmapped so a future edit does not quietly revive it.

### Checks run

- Full suite — **13 suites, 245 tests, pass** (5 new for `isKnownPath`)
- `CI=true npm run build` — **compiled successfully**, 262.58 kB gzip

---

## Step 10 — Back-stack audit (documentation only, 2026-08-20)

**No code changed.** This answers the spec's "Open question to answer during
slice 1".

### What each one actually does

#### 1. `previousView` — a single global return slot

`useState("home")` at [:738](src/Alfred.jsx#L738). **15 writers, 8 readers.**

Writers fall into two groups:

| Group | Sites | Writes |
|---|---|---|
| "Remember where I am" | `viewContextDetail` [:2612](src/Alfred.jsx#L2612), `viewItemDetail` [:2639](src/Alfred.jsx#L2639), `openExecution` [:2805](src/Alfred.jsx#L2805), `startNowFromItem` [:2882](src/Alfred.jsx#L2882), `startNowFromIntention` [:2931](src/Alfred.jsx#L2931), [:2973](src/Alfred.jsx#L2973), Sam/Timer tabs [:3281](src/Alfred.jsx#L3281), [:3296](src/Alfred.jsx#L3296), drawer [:3121](src/Alfred.jsx#L3121) | `setPreviousView(view)` |
| Hard-coded guesses | home pinned collection [:3432](src/Alfred.jsx#L3432), context detail [:3611](src/Alfred.jsx#L3611), new collection [:3875](src/Alfred.jsx#L3875), collections list [:3927](src/Alfred.jsx#L3927) | a literal string |

That second group is the tell. Four sites hard-code where "back" will go
because the writer knows the reader has no other way to find out.

**It is one slot, globally shared.** Any navigation that writes it destroys the
previous occupant.

#### 2. `intentionReturnView` — a second slot, because one was not enough

`useState("home")` at [:739](src/Alfred.jsx#L739). **One writer**
(`viewIntentionDetail` [:2619](src/Alfred.jsx#L2619)), **one reader**
(`handleBackFromIntentionDetail` [:2631](src/Alfred.jsx#L2631)).

This exists *only* because `previousView` is a single slot. Opening an
intention from an item detail must not clobber the item's return address, so
intentions were given a private one. It is not a different concept — it is the
same concept, duplicated to dodge a collision.

#### 3. `itemHistoryStack` — the only real stack

`useState([])` at [:740](src/Alfred.jsx#L740). A LIFO of item ids for
item to linked-item to linked-item drill-down.

`viewItemDetail` [:2634](src/Alfred.jsx#L2634) pushes the current item when
already on item detail, and resets to `[]` when arriving from elsewhere.
`handleBackFromItemDetail` [:2653](src/Alfred.jsx#L2653) pops one, and falls
through to `previousView` when empty.

This is the one that genuinely models something history cannot currently
express — because every item shares the address `/memories/detail`.

### Where browser back now disagrees

#### Disagreement 1 — drill-down collapses to a single Back press

The sharpest one. Items A, B, C are all `/memories/detail`, and Step 4's
same-path rule replaces rather than pushes, so the whole chain is **one**
history entry.

| Action | In-app back arrow | Browser Back |
|---|---|---|
| From item C, one press | item B | the Memories list |
| Presses to leave the chain | 3 | 1 |

Both are defensible; they are simply different. Nothing is corrupted — after a
browser Back the next `viewItemDetail` takes its else-branch and resets the
stack — but a user who mixes the two gestures gets inconsistent depth.

#### Disagreement 2 — `previousView` can point at the screen you are on

Derived from the code, not observed. Trace:

1. Memories, then item A. `previousView = "memories"`.
2. From item A, click an `ExecutionBadge`. `openExecution` sets
   `previousView = "item-detail"`.
3. Close the execution, returning to item A. Correct so far.
4. Press item detail's back arrow. The stack is empty, so it runs
   `setView(previousView)` — and `previousView` is now **`"item-detail"`**.

Pre-slice this left a blank detail pane: `setSelectedItemId(null)` with the
render guard `view === "item-detail" && selectedItemId` failing. **Step 9
incidentally fixes it** — the same-path navigation replaces, `detailStateMissing`
goes true, and the cold-load redirect sends the user to `/memories`. The right
destination, reached by accident.

A one-slot return address cannot survive a round trip through a third screen.
This is the structural failure, not a typo.

#### Disagreement 3 — new tabs start with empty stacks

A middle-clicked Sam or Timer tab has `previousView = "home"`, because
`setPreviousView` ran in the *other* tab. The in-app back arrow goes Home while
browser Back does nothing. Correct in both cases, but the two disagree, and
this is now reachable by an ordinary gesture. Noted at Step 7.

#### Non-disagreement worth recording

`handleEditContextFromDetail` [:2665](src/Alfred.jsx#L2665) sets
`editingContext` and `showContextForm`, and *then* `setView("contexts")`. The
destination renders a modal whose open/closed state is not in the URL, so
browser Back leaves the modal up. A modal-state problem, not a back-stack one —
listed so it is not mistaken for one in slice 3.

### Recommendation: replace all three — but not yet, and not in this order

**Replace, not keep.** All three are hand-rolled history, and the app now has
real history. Two competing back mechanisms is exactly the situation the spec
called worse than having none.

But **sequencing is the whole recommendation**, because removing them today
would break things that currently work:

| Stack | Verdict | Blocked on |
|---|---|---|
| `itemHistoryStack` | Replace with browser history | **Ids in URLs.** While every item is `/memories/detail`, history physically cannot represent the chain. Delete it the moment `/memories/:itemId` exists — then Back walks the chain natively and the stack is pure dead weight. |
| `intentionReturnView` | Delete outright | Nothing structural. It only exists to dodge a `previousView` collision; with real history there is nothing to dodge. Cheapest of the three — one writer, one reader. |
| `previousView` | Replace with `navigate(-1)` | The 4 hard-coded writers need a decision each: is that literal a *return* address (use history) or a genuine *destination* (keep an explicit navigate)? 15 writers make it the largest job. |

**Recommended order for slice 3:** ids into URLs first (slice 2), then
`intentionReturnView`, then `itemHistoryStack`, then `previousView` last.

**Until then, keep all three, and add no new writers.** Every new
`setPreviousView` call is another site to unpick later. If a new screen needs a
return address after slice 2 lands, it should use `navigate(-1)`.

### One caveat on `navigate(-1)`

It steps outside the app if there is nothing to go back to — a cold-loaded deep
link, or a middle-clicked new tab, both now ordinary. Whatever replaces these
stacks needs a "no history here" fallback to a sensible parent, exactly as
`previousView`'s `|| "home"` does today. Do not drop that when dropping the
state.

---

## Slice 1 summary

| Step | Outcome |
|---|---|
| 1 | History island confirmed; three surprises recorded |
| 2 | `BrowserRouter` mounted, behaviourally invisible |
| 3 | 18 view-to-path map documented |
| 4 | The bridge — `view` derived from URL, 39 call sites untouched |
| 4b | Supabase switched to PKCE |
| 5 | Guard consolidated (found quintuplicated, not triplicated) |
| 6 | `<AppLink>` built and tested |
| 7 | Nine top-nav tabs are real links; counts held at 39/12 |
| 8 | SAM history island deleted; `/sam/songs/:songId`, `/sam/stats` |
| 9 | Cold-load redirects; signed-out deep links now survive sign-in |
| 10 | Back-stack audit (this section) |

**All seven success criteria met.** Criterion 5 was corrected in the spec
during Step 8 — back-closing-a-song is new behaviour, not a migration.

Test suite: **13 suites, 245 tests.** New files: `viewPaths.js`,
`viewPaths.test.js`, `AppLink.jsx`, `AppLink.test.jsx`.

### Carried into slice 2

1. **`<AppLink>` on detail cards is not yet safe** — its `href` would open a new
   tab on the wrong screen. Ids in URLs, or `AppLink` refusing to render an
   anchor for a non-cold-loadable view. See the capture above.
2. **Extract `CollectionCard`** — the row markup is still copy-pasted three
   times.
3. **`execution-detail` holds an object, not an id** — convert to id-plus-lookup.
4. **Two guard copies remain** in the back-stack handlers, left alone as
   out-of-scope.
5. **Middle-click is desktop-only** — the mobile drawer is still buttons.
