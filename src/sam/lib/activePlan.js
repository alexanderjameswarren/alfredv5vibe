// The active practice plan, as the app reads it (practice plans spec §7.2,
// §7.3). Pure helpers plus the two loaders; `useActivePlan` owns the state.
//
// Progress is NEVER counted here. It comes only from the database function
// `sam_plan_item_progress`, the same one Claude's get_sam_plan_progress calls,
// so the checklist and Claude always agree.

import { ptDateKey } from "./practiceTimeFormat";

const PLAN_COLS = "id, status, starts_on, day_note, review_note, created_at";
const PLAN_SONG_COLS = "id, song_id, position, song_note";
const ITEM_COLS =
  "id, plan_song_id, song_id, snippet_id, position, is_free_play, target_bpm, " +
  "target_playback_speed, target_effective_bpm, target_passes, accuracy_target, instruction, " +
  // Warm-up ladder (warm-up spec §5). An item's ladder overrides the snippet's
  // and the song's while the plan is active; goal_is_warmup makes the ladder the
  // item's goal; consecutive changes how target_passes is counted.
  "warmup_ladder, goal_is_warmup, consecutive";
const SONG_COLS = "id, title, audio_file_path, default_bpm";
const SNIPPET_COLS =
  "id, song_id, title, start_measure, end_measure, rest_measures, settings, archived, warmup_ladder";

/** Today's Pacific date, "YYYY-MM-DD". */
export function todayKey(now = new Date()) {
  return ptDateKey(now);
}

function byId(rows) {
  return new Map((rows || []).map((r) => [r.id, r]));
}

/**
 * Load the active plan with its songs and items, or null when there is none.
 * Throws on a database error (the hook keeps the last good value).
 */
export async function loadActivePlan(supabase) {
  const { data: plan, error } = await supabase
    .from("sam_practice_plans")
    .select(PLAN_COLS)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!plan) return null;

  const [songsRes, itemsRes] = await Promise.all([
    supabase.from("sam_practice_plan_songs").select(PLAN_SONG_COLS).eq("plan_id", plan.id).order("position"),
    supabase.from("sam_practice_plan_items").select(ITEM_COLS).eq("plan_id", plan.id).order("position"),
  ]);
  if (songsRes.error) throw songsRes.error;
  if (itemsRes.error) throw itemsRes.error;
  const planSongs = songsRes.data || [];
  const items = itemsRes.data || [];

  const songIds = [...new Set(planSongs.map((s) => s.song_id))];
  const snippetIds = [...new Set(items.map((i) => i.snippet_id).filter(Boolean))];
  const [songRes, snipRes] = await Promise.all([
    songIds.length
      ? supabase.from("sam_songs").select(SONG_COLS).in("id", songIds)
      : Promise.resolve({ data: [], error: null }),
    snippetIds.length
      ? supabase.from("sam_snippets").select(SNIPPET_COLS).in("id", snippetIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (songRes.error) throw songRes.error;
  if (snipRes.error) throw snipRes.error;
  const songs = byId(songRes.data);
  const snippets = byId(snipRes.data);

  return {
    ...plan,
    songs: planSongs.map((ps) => {
      const s = songs.get(ps.song_id);
      return {
        ...ps,
        title: s?.title ?? null,
        audio_file_path: s?.audio_file_path ?? null,
        default_bpm: s?.default_bpm ?? null,
      };
    }),
    items: items.map((it) => {
      const sn = it.snippet_id ? snippets.get(it.snippet_id) : null;
      return {
        ...it,
        song_title: songs.get(it.song_id)?.title ?? null,
        // A planned snippet that is archived, or no longer visible, cannot be
        // loaded: the item opens its song without a snippet instead.
        snippet: sn
          ? {
              id: sn.id,
              title: sn.title,
              start_measure: sn.start_measure,
              end_measure: sn.end_measure,
              rest_measures: sn.rest_measures ?? 0,
              hand_mode: sn.settings?.handMode || "both",
              settings: sn.settings,
              archived: !!sn.archived,
              // Carried because opening a plan item builds the loaded snippet
              // from THIS object via snippetFromRow, and a snippet that lost its
              // ladder on the way in would silently fall through to the song's.
              warmup_ladder: sn.warmup_ladder ?? null,
            }
          : null,
        snippet_unavailable: !!it.snippet_id && (!sn || !!sn.archived),
      };
    }),
  };
}

/**
 * Today's progress for a plan: Map of plan_item_id -> { attempts, qualifying }.
 * Items with no attempts today have no entry.
 */
export async function loadTodayProgress(supabase, planId, today = todayKey()) {
  const { data, error } = await supabase.rpc("sam_plan_item_progress", {
    p_plan_id: planId,
    p_from: today,
    p_to: today,
  });
  if (error) throw error;
  const map = new Map();
  for (const r of data || []) {
    map.set(r.plan_item_id, {
      attempts: r.attempts ?? 0,
      qualifying: r.qualifying ?? 0,
      // Added by migration 078. The function returns all three numbers and
      // decides between none of them; `itemState` picks per the item's own flags.
      streak: r.longest_qualifying_streak ?? 0,
      completions: r.ladder_completions ?? 0,
    });
  }
  return map;
}

/**
 * The plan item a pass or session on (songId, snippetId) belongs to: same song,
 * and the same snippet (a null snippet is the whole song). Null when none.
 */
export function matchPlanItem(plan, songId, snippetId) {
  if (!plan || !songId) return null;
  const snip = snippetId || null;
  return (plan.items || []).find((i) => i.song_id === songId && (i.snippet_id || null) === snip) || null;
}

/**
 * The two link columns written on sam_passes and sam_sessions. Both null when
 * there is no active plan, or it has not loaded yet. Never throws.
 */
export function planLinkFor(plan, songId, snippetId) {
  try {
    if (!plan?.id) return { plan_id: null, plan_item_id: null };
    return { plan_id: plan.id, plan_item_id: matchPlanItem(plan, songId, snippetId)?.id ?? null };
  } catch {
    return { plan_id: null, plan_item_id: null };
  }
}

/**
 * Display state of one item for today.
 *
 * WHICH NUMBER DECIDES "DONE" IS THE ITEM'S OWN DECLARATION (warm-up spec §5.2,
 * §5.3). sam_plan_item_progress returns all three and chooses between none of
 * them, so the choice lives here, once:
 *
 *   goal_is_warmup  → one completed ladder that Pacific day is the whole target
 *   consecutive     → the longest qualifying streak WITHIN ONE SESSION
 *   neither         → the cumulative qualifying count across the day
 *
 * Both flags default false, so an item written before the warm-up ladder existed
 * takes the third branch and reads exactly as it always did.
 */
export function itemState(item, progress) {
  const p = progress?.get?.(item.id) || { attempts: 0, qualifying: 0, streak: 0, completions: 0 };
  const streak = p.streak ?? 0;
  const completions = p.completions ?? 0;
  const base = { attempts: p.attempts, qualifying: p.qualifying, streak, completions };

  if (item.goal_is_warmup) {
    const done = completions >= 1;
    return { ...base, warmup: true, shown: Math.min(completions, 1), target: 1, done,
             amber: !done && p.attempts > 0 };
  }

  const target = item.target_passes || 0;
  const counted = item.consecutive ? streak : p.qualifying;
  const done = counted >= target && target > 0;
  return { ...base, consecutive: !!item.consecutive, shown: Math.min(counted, target), target, done,
           amber: !done && p.attempts > 0 && counted < target };
}

/**
 * Whether one completed pass counts towards its item, by the SAME rule
 * sam_plan_item_progress uses (migration 078):
 *
 *   notes_played > 0
 *   and effective_bpm >= the item's target
 *   and (free play, or accuracy_percent >= the item's accuracy_target)
 *
 * It lives here, beside `itemState`, because the player's LIVE streak has to
 * agree with the count the database gives back for the same passes. A second,
 * looser rule would fill circles for passes the checklist then refuses — and
 * the tempo half is the half that is easy to forget: a warm-up rung below the
 * item's target cannot qualify, however clean it was.
 *
 * A null accuracy is unmeasured, which is not "good enough"; the SQL's
 * coalesce(..., false) says the same.
 */
export function passQualifies(pass, item) {
  if (!item || !pass) return false;
  if (!(pass.notesPlayed > 0)) return false;
  if (!Number.isFinite(pass.effectiveBpm) || !Number.isFinite(item.target_effective_bpm)) return false;
  if (pass.effectiveBpm < item.target_effective_bpm) return false;
  if (item.is_free_play) return true;
  return Number.isFinite(pass.accuracyPercent) && pass.accuracyPercent >= item.accuracy_target;
}

// --- Working order: what to do next (2026-09-19) -----------------------------
//
// The checklist shows the main work first and Free Play under its own label,
// and that display order IS the working order: Free Play is optional, so
// nothing should send him there while main work is left. Both the home page's
// auto-scroll and the "Next" control read the plan through these three
// helpers, so they can never disagree about which item is next.

/** The plan's items in working order: main work in plan order, then Free Play. */
export function planItemsInOrder(plan) {
  const items = plan?.items || [];
  return [...items.filter((i) => !i.is_free_play), ...items.filter((i) => i.is_free_play)];
}

/**
 * The first item still short of its target passes, main work before Free Play.
 * Null when every item is done, or the plan has no items.
 *
 * The precedence is load-bearing, not incidental: because `planItemsInOrder`
 * puts every main item ahead of every Free Play one, a plain forward scan
 * cannot reach Free Play while main work is outstanding. Anything that
 * reorders this — searching raw plan order, say — silently reintroduces the
 * bug `nextIncompleteItem` documents below.
 */
export function firstIncompleteItem(plan, progress) {
  return planItemsInOrder(plan).find((i) => !itemState(i, progress).done) || null;
}

/**
 * What to practise after `item`.
 *
 * ⚠️ FREE PLAY IS NEVER OFFERED WHILE ANY MAIN-WORK ITEM IS INCOMPLETE. That
 * is the whole point of the rule, and scanning forward through working order
 * broke it (2026-09-22): from a completed main item near the bottom of the
 * plan, the first incomplete thing AFTER it can be a Free Play item, and the
 * scan stopped there — sending him to Free Play with real work outstanding.
 * Live case: Pastorale m24–26 (position 7, main) incomplete, its whole song
 * (position 8, main) complete and loaded, Arabesque m53–55 (position 9, Free
 * Play) incomplete — and Next offered the Arabesque.
 *
 * So the search is confined to ONE TIER: main work while any of it is left,
 * Free Play only once all main work is done. Inside that tier it looks
 * forward from the current position first, then wraps to the tier's first
 * incomplete item — so a finished item at the bottom still points back up at
 * the one bar he skipped, which is how a plan saved mid-practice behaves
 * (later items already complete from earlier passes, an earlier one not).
 *
 * The tier comes from `planItemsInOrder`, the same definition the home page's
 * auto-scroll and `firstIncompleteItem` use, so the three cannot disagree.
 *
 * Never returns `item` itself: a row must not offer itself as its own Next.
 * Null when the tier has nothing else to offer.
 */
export function nextIncompleteItem(plan, progress, item) {
  const order = planItemsInOrder(plan);
  const open = (i) => !itemState(i, progress).done && i.id !== item?.id;
  // Counts `item` itself: loaded on the last incomplete main item, main work
  // is still unfinished, so Free Play stays off the table.
  const mainWorkLeft = order.some((i) => !i.is_free_play && !itemState(i, progress).done);
  const tier = order.filter((i) => !!i.is_free_play === !mainWorkLeft);
  // -1 when `item` is in the other tier — a completed Free Play item while
  // main work is outstanding — which correctly scans the main tier from its
  // start rather than from nowhere.
  const at = item ? tier.findIndex((i) => i.id === item.id) : -1;
  return tier.slice(at + 1).find(open) || tier.find(open) || null;
}

/** True when every item, Free Play included, has reached its target today. */
export function planIsComplete(plan, progress) {
  const order = planItemsInOrder(plan);
  return order.length > 0 && order.every((i) => itemState(i, progress).done);
}

/**
 * The compact range for a "Next" label: "m.1–16", "m.1–16 · RH" or
 * "Whole song". Shorter than `itemRangeText` on purpose — the Next button
 * truncates the song title and must never truncate this.
 */
export function itemShortRange(item) {
  if (!item?.snippet_id) return "Whole song";
  const sn = item.snippet;
  if (!sn) return "";
  const hand = sn.hand_mode && sn.hand_mode !== "both" ? ` · ${sn.hand_mode.toUpperCase()}` : "";
  return `m.${sn.start_measure}–${sn.end_measure}${hand}`;
}

/** "Next: Autumn Leaves m.1–16" — the Next button's label and accessible name. */
export function nextItemLabel(item) {
  return `Next: ${[item?.song_title || "Untitled", itemShortRange(item)].filter(Boolean).join(" ")}`;
}

/** "Today's plan · 3 of 6 done" plus " · Free play 1 of 2" when there is free play. */
export function planSummary(plan, progress) {
  const items = plan?.items || [];
  const main = items.filter((i) => !i.is_free_play);
  const free = items.filter((i) => i.is_free_play);
  const doneCount = (list) => list.filter((i) => itemState(i, progress).done).length;
  let text = `Today's plan · ${doneCount(main)} of ${main.length} done`;
  if (free.length) text += ` · Free play ${doneCount(free)} of ${free.length}`;
  return text;
}

// A snippet title the app generated from the range itself ("Measures 1-2 RH
// No Rest", formatSnippetTitle) says nothing the range line does not.
const GENERATED_TITLE = /^Measures\s+\d+\s*-\s*\d+(\s+(LH|RH|Both))?(\s+(No Rest|Rest:\s*\d+))?$/i;

function titleAddsInformation(title) {
  return !!title && title.trim() !== "" && !GENERATED_TITLE.test(title.trim());
}

/**
 * The item's range line: "m.1–2 · RH", plus " · <title>" when the snippet's
 * title says more than the range. "Whole song" for whole-song items. An
 * archived or missing snippet ends with "(snippet archived)" — after its range
 * when the snippet row is still readable.
 */
export function itemRangeText(item) {
  if (!item.snippet_id) return "Whole song";
  const sn = item.snippet;
  const parts = [];
  if (sn) {
    parts.push(`m.${sn.start_measure}–${sn.end_measure}`);
    if (sn.hand_mode && sn.hand_mode !== "both") parts.push(sn.hand_mode.toUpperCase());
    if (titleAddsInformation(sn.title)) parts.push(sn.title);
  }
  if (item.snippet_unavailable) parts.push("(snippet archived)");
  return parts.join(" · ");
}

/**
 * " in a row" for a consecutive item (§5.3), used everywhere the target is
 * named. Without it "3 passes" reads identically whether he may collect them
 * across the day or must land three clean ones back to back — and those are
 * very different afternoons.
 *
 * Not for a target of one: one in a row and one are the same pass, so the words
 * would only add noise.
 */
export function inARowSuffix(item) {
  return item?.consecutive && (item?.target_passes || 0) > 1 ? " in a row" : "";
}

/** "60 BPM · 90% · 4 passes in a row", or "78 BPM · 2 passes" for free play. */
export function itemTargetText(item) {
  const passes = `${item.target_passes} pass${item.target_passes === 1 ? "" : "es"}${inARowSuffix(item)}`;
  return item.is_free_play
    ? `${item.target_effective_bpm} BPM · ${passes}`
    : `${item.target_effective_bpm} BPM · ${item.accuracy_target}% · ${passes}`;
}

// --- Player display (practice plans spec §7.4) -------------------------------

/** The tempo actually heard: round(bpm × speed / 100). */
export function heardTempo(bpm, playbackSpeed) {
  if (!Number.isFinite(bpm) || !Number.isFinite(playbackSpeed)) return null;
  return Math.round((bpm * playbackSpeed) / 100);
}

/**
 * The item for what is loaded in the player. A range typed but never saved has
 * no snippet id and matches nothing — it is not the whole song.
 */
export function itemForLoadedRange(plan, songId, snippet) {
  if (snippet && !snippet.dbId) return null;
  return matchPlanItem(plan, songId, snippet?.dbId ?? null);
}

/** The plan's row for a song (its song_note), or null. */
export function planSongFor(plan, songId) {
  if (!plan || !songId) return null;
  return (plan.songs || []).find((s) => s.song_id === songId) || null;
}

/**
 * "Plan · m.15–16 · 60 BPM · 90% · 2/4 today · Count out loud"
 * "Free play · Whole song · 78 BPM · 0/1 today"
 * Done reads "Done 4/4 today" in place of the count.
 *
 * The range sits second, right after the label: two items on one song differ
 * only by their bars, and at the keyboard that is the first thing he needs to
 * know he has the right one loaded.
 */
export function planLineText(item, state) {
  const parts = [item.is_free_play ? "Free play" : "Plan"];
  const range = itemShortRange(item);
  if (range) parts.push(range);
  parts.push(`${item.target_effective_bpm} BPM`);
  if (!item.is_free_play) parts.push(`${item.accuracy_target}%`);
  if (item.goal_is_warmup) {
    // §7.3: a warm-up item reports the ladder, not a pass count. The live rung
    // belongs to the mid-play badge (planBadgeText) and to the warm-up strip;
    // this line is only ever on screen stopped or paused, where the honest
    // answer is whether today's ladder has been completed — from the database.
    parts.push("warm-up");
    parts.push(state.done ? "done today" : "not yet today");
  } else {
    // §5.3: "in a row" is worth saying, because it changes what he has to do —
    // the same words the home checklist uses for the same item.
    parts.push(`${state.done ? "Done " : ""}${state.shown}/${state.target}${inARowSuffix(item)} today`);
  }
  if (item.instruction) parts.push(item.instruction);
  return parts.join(" · ");
}

/** The compact playing badge: "Plan 2/4", or "Plan ✓" when done. */
export function planBadgeText(state, warmupRungText = null) {
  // A warm-up item is not measured in passes, so a pass count would be a lie
  // (warm-up spec §5.2). While a ladder is running the live rung is the useful
  // number, and this badge is the only plan readout on screen mid-play.
  if (state.warmup) {
    if (warmupRungText) return `Warm-up · ${warmupRungText}`;
    return state.done ? "Warm-up ✓" : "Warm-up";
  }
  return state.done ? "Plan ✓" : `Plan ${state.shown}/${state.target}`;
}

/** The snippet-row tag: "Plan · 60 BPM · 2/4", or "Plan ✓" when done. */
export function snippetTagText(item, state) {
  return state.done ? "Plan ✓" : `Plan · ${item.target_effective_bpm} BPM · ${state.shown}/${state.target}`;
}
