import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "../../supabaseClient";

// Library hook. Owns the sam_songs list-shape fetch and folds in the
// practice aggregates passed in from a single upstream `usePracticeStats`
// call. Does NOT call usePracticeStats itself — the caller (typically
// SongLoader) owns the fetch and forwards `perSongTotals`,
// `lastPracticedBySong`, and `statsLoading`. Keeps "one sam_sessions
// request per landing-page load" intact.
//
// Column selection is intentional and minimal — NEVER `measures`. That
// column is the compiled JSONB score blob and the table comment says so
// explicitly; pulling it here would multiply payload size by ~1000x.
// SamPlayer's handleLoadFromLibrary does its own targeted fetch when a
// song is actually opened.
//
// Family assembly follows spec § Data model: group by
// coalesce(parent_song_id, id). A drill with parent_song_id NULL is its
// own family root and renders as a single-row card — legitimate, not an
// error. Children whose parent isn't visible in the current library (e.g.
// the parent was archived) get promoted to roots so they aren't hidden.
//
// Params:
//   perSongTotals        Map<song_id, seconds> from usePracticeStats
//   lastPracticedBySong  Map<song_id, ISO started_at> from usePracticeStats
//   statsLoading         boolean; folds into the returned `loading`
//
// Returns:
//   families            SongFamily[] — every visible unarchived song
//                       grouped; sorted by lastPracticedAt desc, then title
//   familiesByRootId    Map<root_id, SongFamily> — O(1) lookup
//   recentFamilies      up to two SongFamily entries with the most recent
//                       lastPracticedAt (deduped by root_id; short list
//                       when the user has < 2 practiced families ever)
//   allSongsFlat        every visible unarchived song, augmented with
//                       familyRootId / familyRootTitle / lastPracticedAt /
//                       totalSeconds; sorted by lastPracticedAt desc, then
//                       title (never-practiced sort to the end)
//   drillsFlat          same shape, filtered to song_type='drill'
//   archivedFamilies    SongFamily[] — same shape as families, but derived
//                       from the archived pool (parents resolved within
//                       archived; visible-but-archived children become
//                       roots in the archived view)
//   archivedCount       number — for the "View archived songs (N)" footer
//   loading             true during either fetch
//   error               string or null; first non-null error surfaces here
//   refresh()           forces a re-fetch of sam_songs. Call after any
//                       mutation (archive / restore / edit-save) so the
//                       derived shapes rebuild instead of drifting.

const SONG_COLUMNS =
  "id, title, artist, song_type, parent_song_id, difficulty_tier, created_at, archived";

// Which children go into which bucket on a family.
function bucketFor(song) {
  if (song.song_type === "simplified") return "simplified";
  if (song.song_type === "drill") return "drill";
  return null;
}

const EMPTY_MAP = new Map();

// Family assembly. Group `pool` (a set of songs — visible OR archived,
// never mixed) by coalesce(parent_song_id, id), where parent-resolution
// is scoped to `pool` only. A child whose parent isn't in the same pool
// (archived vs not, or genuinely deleted) gets promoted to root — spec's
// "orphans render as roots" rule, applied per-pool so the archived view
// and the visible view stay independently coherent.
function assembleFamilies(pool, perSongTotals, lastPracticedBySong) {
  const augmented = pool.map((s) => ({
    ...s,
    totalSeconds: perSongTotals.get(s.id) || 0,
    lastPracticedAt: lastPracticedBySong.get(s.id) || null,
  }));
  const byId = new Map(augmented.map((s) => [s.id, s]));

  const familyMembers = new Map();
  for (const s of augmented) {
    const parentId = s.parent_song_id;
    const rootId = parentId && byId.has(parentId) ? parentId : s.id;
    const arr = familyMembers.get(rootId) || [];
    arr.push(s);
    familyMembers.set(rootId, arr);
  }

  const families = [];
  for (const [rootId, members] of familyMembers) {
    const root = byId.get(rootId);
    // Defensive: rootId came from a member's own id or a resolved parent
    // id, both of which live in byId. Skip if it's ever missing.
    if (!root) continue;

    const simplified = [];
    const drills = [];
    let lastPracticedAt = root.lastPracticedAt;
    let totalSeconds = root.totalSeconds;

    for (const m of members) {
      if (m.id === rootId) continue;
      const kind = bucketFor(m);
      if (kind === "simplified") simplified.push(m);
      else if (kind === "drill") drills.push(m);
      // If a child slipped through as song_type='original' under a
      // visible parent, that violates the lineage CHECK constraint —
      // we skip it here rather than misclassify.
      if (
        m.lastPracticedAt &&
        (!lastPracticedAt || m.lastPracticedAt > lastPracticedAt)
      ) {
        lastPracticedAt = m.lastPracticedAt;
      }
      totalSeconds += m.totalSeconds;
    }

    simplified.sort((a, b) => {
      const ta = a.difficulty_tier ?? Infinity;
      const tb = b.difficulty_tier ?? Infinity;
      if (ta !== tb) return ta - tb;
      return a.title.localeCompare(b.title);
    });

    drills.sort((a, b) => {
      const la = a.lastPracticedAt || "";
      const lb = b.lastPracticedAt || "";
      if (la !== lb) return la > lb ? -1 : 1;
      return a.title.localeCompare(b.title);
    });

    families.push({ root, simplified, drills, lastPracticedAt, totalSeconds });
  }

  families.sort((a, b) => {
    const la = a.lastPracticedAt || "";
    const lb = b.lastPracticedAt || "";
    if (la !== lb) return la > lb ? -1 : 1;
    return a.root.title.localeCompare(b.root.title);
  });

  return families;
}

export default function useSongLibrary({
  perSongTotals = EMPTY_MAP,
  lastPracticedBySong = EMPTY_MAP,
  statsLoading = false,
} = {}) {
  const [songs, setSongs] = useState([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState(null);
  // Bumping this counter re-runs the fetch effect. `refresh()` is used by
  // mutation flows (archive / restore / edit-save) that need the library
  // list to re-reflect what's now in the DB. Cheaper than optimistic local
  // patching across every derived shape (families, flat lists, archived pool).
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSongsLoading(true);
    supabase
      .from("sam_songs")
      .select(SONG_COLUMNS)
      .order("title", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[Sam] useSongLibrary fetch failed:", error);
          setSongsError(error.message);
          setSongs([]);
        } else {
          setSongsError(null);
          setSongs(data || []);
        }
        setSongsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const refresh = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  const derived = useMemo(() => {
    const visible = songs.filter((s) => !s.archived);
    const archived = songs.filter((s) => s.archived);

    // Both pools use identical family-assembly logic. `assembleFamilies`
    // is scoped to a single pool: parents resolve WITHIN that pool only,
    // so an archived child under an unarchived parent gets promoted to
    // root in the archived pool (and doesn't appear at all in the visible
    // pool). Spec §BrowseTabs: "an archived child under an unarchived
    // parent stays hidden, or the archive count will not reconcile."
    const families = assembleFamilies(
      visible,
      perSongTotals,
      lastPracticedBySong
    );
    const archivedFamilies = assembleFamilies(
      archived,
      perSongTotals,
      lastPracticedBySong
    );

    const familiesByRootId = new Map(families.map((f) => [f.root.id, f]));

    // recentFamilies: the two most recently practiced distinct families.
    // Deduplication is inherent — each family appears at most once in
    // `families`. Only families with at least one practiced session
    // (root or child) qualify; families with no practice at all don't
    // belong in the Continue section.
    const recentFamilies = families
      .filter((f) => f.lastPracticedAt)
      .slice(0, 2);

    // Flat lists (visible pool only) — augment with familyRootId /
    // familyRootTitle so the Recent tab can render "Family · Song" prefixes
    // without a second lookup.
    const visibleById = new Map(visible.map((s) => [s.id, s]));
    const flatBase = visible.map((s) => {
      const parentId = s.parent_song_id;
      const rootId = parentId && visibleById.has(parentId) ? parentId : s.id;
      const rootTitle = visibleById.get(rootId)?.title || s.title;
      return {
        ...s,
        totalSeconds: perSongTotals.get(s.id) || 0,
        lastPracticedAt: lastPracticedBySong.get(s.id) || null,
        familyRootId: rootId,
        familyRootTitle: rootTitle,
      };
    });

    const bySortedRecency = (a, b) => {
      const la = a.lastPracticedAt || "";
      const lb = b.lastPracticedAt || "";
      if (la !== lb) return la > lb ? -1 : 1;
      return a.title.localeCompare(b.title);
    };
    const allSongsFlat = [...flatBase].sort(bySortedRecency);
    const drillsFlat = flatBase
      .filter((s) => s.song_type === "drill")
      .sort(bySortedRecency);

    return {
      families,
      familiesByRootId,
      recentFamilies,
      allSongsFlat,
      drillsFlat,
      archivedFamilies,
      archivedCount: archived.length,
    };
  }, [songs, perSongTotals, lastPracticedBySong]);

  return {
    ...derived,
    loading: songsLoading || statsLoading,
    error: songsError,
    refresh,
  };
}
