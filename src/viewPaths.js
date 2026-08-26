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
  memories: "/memories",
  "item-detail": "/memories/detail",
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
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return DEFAULT_PATH;
  return path.slice(0, cut);
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
