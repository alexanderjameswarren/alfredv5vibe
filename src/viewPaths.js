// Two-way map between Alfred's `view` state-machine values and real URL paths.
//
// Step 3/4 of docs/technical-spec-navigation-urls.md. Alfred has 19
// destinations that used to live in a single `useState` string. This module
// is the whole vocabulary of that machine expressed as addresses, so `view`
// can be derived from the URL instead of stored.
//
// Deliberately dependency-free and side-effect-free: it is pure data plus two
// lookups, so it can be reasoned about (and unit-tested) without React or the
// router in the picture.

// The 20 view values, in the order they appear in the progress doc's table.
// Detail views carry no id this slice — the id-bearing navigations set their
// id via a separate React state call that has not flushed by the time
// `setView` runs, so threading an id into the URL would mean editing the
// call sites. Ids arrive in a later slice; the parent segment survives that
// change (`/contexts/detail` -> `/contexts/:contextId`).
export const VIEW_TO_PATH = {
  home: "/",
  inbox: "/inbox",
  contexts: "/contexts",
  "context-detail": "/contexts/detail",
  schedule: "/schedule",
  "execution-detail": "/schedule/execution",
  intentions: "/intentions",
  "intention-detail": "/intentions/detail",
  // Step 12.6. Add forms became real pages. Both this and "item-add" below carry
  // an optional TARGET in a later segment — see the add sub-routes at the bottom —
  // and the bare form is a legitimate address in its own right: an add page with
  // nothing preselected.
  "intention-add": "/intentions/new",
  memories: "/memories",
  "item-detail": "/memories/detail",
  "item-add": "/memories/new",
  "item-add-to-collection": "/memories/add-to-collection",
  collections: "/collections",
  "collection-detail": "/collections/detail",
  "collection-history": "/collections/history",
  "collection-add-items": "/collections/add-items",
  settings: "/settings",
  recycle: "/recycle",
  timer: "/timer",
  sam: "/sam",
  games: "/games",
};

export const DEFAULT_VIEW = "home";
export const DEFAULT_PATH = VIEW_TO_PATH[DEFAULT_VIEW];

// Reversed once at module load rather than searched per call.
const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_TO_PATH).map(([view, path]) => [path, view])
);

// Trailing slashes are equivalent to their bare form ("/inbox/" === "/inbox").
// react-router matches both, so the map has to as well or a trailing slash
// would silently fall back to home. Root is left alone.
export function normalizePath(pathname) {
  if (typeof pathname !== "string" || pathname === "") return DEFAULT_PATH;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "") || DEFAULT_PATH;
  }
  return pathname;
}

// URL -> view. Anything unmapped resolves to home, which preserves today's
// behaviour: an arbitrary path such as /testing renders the home screen.
// Note this only *renders* home; it does not rewrite the URL. Redirecting
// unknown paths is Step 9.
export function pathToView(pathname) {
  // Everything under /sam is the SAM view; see the SAM section below.
  if (isSamPath(pathname)) return "sam";
  // /schedule/execution/:id is the same view as the bare /schedule/execution.
  if (executionIdFromPath(pathname)) return "execution-detail";
  // /memories/new/context/:id is the same view as the bare /memories/new.
  const add = addRouteFromPath(pathname);
  if (add) return add.view;
  return PATH_TO_VIEW[normalizePath(pathname)] || DEFAULT_VIEW;
}

// view -> URL. Must tolerate anything, because 11 of the 39 `setView(` call
// sites pass a runtime value rather than a literal — `setView(previousView)`,
// `setView(item.key)`, and so on. An unrecognised or nullish value falls back
// to home rather than producing `/undefined`.
export function viewToPath(view) {
  if (typeof view !== "string") return DEFAULT_PATH;
  return VIEW_TO_PATH[view] || DEFAULT_PATH;
}

// Is this a path the app actually serves? Unknown paths render home today;
// Step 9 uses this to redirect them to "/" so the address bar stops lying.
export function isKnownPath(pathname) {
  if (isSamPath(pathname)) return true;
  // Deliberately executionIdFromPath, not isExecutionPath: a malformed
  // /schedule/execution/a/b has no extractable id and stays unknown, so it is
  // redirected to home like any other nonsense path rather than half-served.
  if (executionIdFromPath(pathname)) return true;
  // A malformed add path — a bad kind, a missing id, an extra segment — returns
  // null here and is redirected to home like any other nonsense path, rather
  // than half-serving an add form with no target.
  if (addRouteFromPath(pathname)) return true;
  return Boolean(PATH_TO_VIEW[normalizePath(pathname)]);
}

// Parent path for a detail view, used by Step 9's cold-load redirect.
// Detail paths are named so that stripping the last segment yields the parent
// — a tiebreaker for naming, not a law. If a future path needs a name that
// breaks the pattern, add it to PARENT_OVERRIDES rather than bending the name.
const PARENT_OVERRIDES = {};

export function parentPath(pathname) {
  const path = normalizePath(pathname);
  if (PARENT_OVERRIDES[path]) return PARENT_OVERRIDES[path];
  // Both add forms fall back to the LIST, not to their own bare form: stripping
  // one segment off /memories/new/context/:id lands on /memories/new/context,
  // which is not an address at all. Same one-correction-not-two reasoning as the
  // execution branch below.
  const add = addRouteFromPath(path);
  if (add) {
    const base = VIEW_TO_PATH[add.view];
    const cut = base.lastIndexOf("/");
    return cut > 0 ? base.slice(0, cut) : DEFAULT_PATH;
  }
  // An id-bearing execution path falls back to the schedule list, not to the
  // bare /schedule/execution. Stripping one segment would land on a path that
  // is itself unrenderable cold and would redirect again — one visible
  // correction instead of two.
  if (executionIdFromPath(path)) return VIEW_TO_PATH.schedule;
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return DEFAULT_PATH;
  return path.slice(0, cut);
}

// --- Execution sub-route (notification chains, Phase 1) ----------------------
//
// The first id-bearing address in Alfred, following the SAM precedent below.
//
// Every other detail view still carries its id in React state only, which is
// why a pasted /collections/detail redirects to its parent. An execution
// cannot afford that: a chained notification links back to the execution it
// belongs to, and a tap that lands on the schedule list gives no indication of
// which step fired. So this one view gets a real address, and Alfred fetches
// the execution by id when the URL arrives with no state behind it.
//
// The view map above stays a bijection — `viewToPath("execution-detail")` is
// always the bare "/schedule/execution" — while `pathToView` resolves both
// forms to the same view. The bare form therefore keeps working exactly as it
// did, which is what lets the id-bearing form be added without touching every
// navigation at once.

const EXECUTION_PREFIX = `${VIEW_TO_PATH["execution-detail"]}/`;

export function executionPath(executionId) {
  return `${EXECUTION_PREFIX}${encodeURIComponent(executionId)}`;
}

// The execution id from /schedule/execution/:id, or null for any other path —
// including the bare /schedule/execution, which is the id-less form and is not
// a cold-loadable address. Mirrors samSongIdFromPath: a malformed or empty id
// degrades to null rather than throwing.
export function executionIdFromPath(pathname) {
  const path = normalizePath(pathname);
  if (!path.startsWith(EXECUTION_PREFIX)) return null;
  const id = path.slice(EXECUTION_PREFIX.length);
  if (!id || id.includes("/")) return null;
  return decodeURIComponent(id);
}

// --- Add sub-routes (Step 12.6) ----------------------------------------------
//
// The add forms used to render inline, wedged between a section header and the
// list below it. They are now real pages with real addresses, following the
// execution precedent above rather than inventing a second pattern.
//
// TWO pages, not four, across four entry points. The entry point is expressed as
// a TARGET in the path — `/memories/new/context/:contextId`,
// `/intentions/new/item/:itemId` — so one page serves every caller and the
// difference between callers is data, not code. Four near-identical routes is
// the copy-paste drift that produced the three collection rows in Step 4a.
//
// The bare form is a legitimate address: an add page with nothing preselected,
// which is exactly what the Intentions page needs. So the view map stays a
// bijection — `viewToPath("item-add")` is always "/memories/new" — while
// `pathToView` resolves both forms, the same arrangement the execution route
// uses.
//
// Two target kinds, and no more without a reason: `context` (add into this
// context) and `item` (add an intention against this item). An unrecognised
// kind is not a target with a bad value — it is not an address, and
// `isKnownPath` says so.

const ADD_VIEWS = ["item-add", "intention-add"];
const ADD_TARGET_KINDS = ["context", "item"];

/**
 * Build an add-page address.
 *
 * @param {string} view - "item-add" or "intention-add".
 * @param {{kind: string, id: string}|null} [target] - omit for the bare form.
 */
export function addPath(view, target = null) {
  if (!ADD_VIEWS.includes(view)) return DEFAULT_PATH;
  const base = VIEW_TO_PATH[view];
  if (!target || !target.id || !ADD_TARGET_KINDS.includes(target.kind)) {
    return base;
  }
  return `${base}/${target.kind}/${encodeURIComponent(target.id)}`;
}

/**
 * Resolve an add address.
 *
 * @returns {{view: string, target: {kind: string, id: string}|null}|null}
 *   null for any path that is not an add address, INCLUDING a malformed one.
 */
export function addRouteFromPath(pathname) {
  const path = normalizePath(pathname);
  for (const view of ADD_VIEWS) {
    const base = VIEW_TO_PATH[view];
    if (path === base) return { view, target: null };
    if (!path.startsWith(`${base}/`)) continue;

    const parts = path.slice(base.length + 1).split("/");
    // Exactly kind + id. Anything else is malformed rather than partial: a
    // half-read target would open an add form pointing somewhere unintended,
    // which is worse than not opening at all.
    if (parts.length !== 2) return null;
    const [kind, rawId] = parts;
    if (!ADD_TARGET_KINDS.includes(kind) || !rawId) return null;
    return { view, target: { kind, id: decodeURIComponent(rawId) } };
  }
  return null;
}

// --- SAM sub-routes (Step 8) -------------------------------------------------
//
// SAM used to own a private stretch of the History API: SongLoader called
// pushState("/stats") and listened for popstate, because there was no router
// to ask. That island is deleted; these are its replacements.
//
// SAM is one `view` value ("sam") with three addresses beneath it. The view
// map above stays a bijection — `viewToPath("sam")` is always "/sam" — while
// `pathToView` treats anything under /sam as the SAM view, so Alfred keeps
// rendering SamPlayer and SAM decides internally which of the three to show.
//
// The open song is a real address rather than component state, which is what
// makes browser Back close a song: closing it is now ordinary route
// navigation, and the router handles it for free.

export const SAM_PATH = "/sam";
export const SAM_STATS_PATH = "/sam/stats";
const SAM_SONGS_PREFIX = "/sam/songs/";

export function samSongPath(songId) {
  return `${SAM_SONGS_PREFIX}${songId}`;
}

// The song id from /sam/songs/:songId, or null for any other path.
// Returns null rather than throwing for a trailing-slash-only or empty id, so
// a malformed URL degrades to the SAM landing page.
export function samSongIdFromPath(pathname) {
  const path = normalizePath(pathname);
  if (!path.startsWith(SAM_SONGS_PREFIX)) return null;
  const id = path.slice(SAM_SONGS_PREFIX.length);
  if (!id || id.includes("/")) return null;
  return decodeURIComponent(id);
}

export function isSamStatsPath(pathname) {
  return normalizePath(pathname) === SAM_STATS_PATH;
}

export function isSamPath(pathname) {
  const path = normalizePath(pathname);
  return path === SAM_PATH || path.startsWith(`${SAM_PATH}/`);
}
