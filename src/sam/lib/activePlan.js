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
  "target_playback_speed, target_effective_bpm, target_passes, accuracy_target, instruction";
const SONG_COLS = "id, title, audio_file_path, default_bpm";
const SNIPPET_COLS = "id, song_id, title, start_measure, end_measure, rest_measures, settings, archived";

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
    map.set(r.plan_item_id, { attempts: r.attempts ?? 0, qualifying: r.qualifying ?? 0 });
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

/** Display state of one item for today. */
export function itemState(item, progress) {
  const p = progress?.get?.(item.id) || { attempts: 0, qualifying: 0 };
  const target = item.target_passes || 0;
  const done = p.qualifying >= target && target > 0;
  return {
    attempts: p.attempts,
    qualifying: p.qualifying,
    shown: Math.min(p.qualifying, target),
    target,
    done,
    amber: !done && p.attempts > 0 && p.qualifying < target,
  };
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
 */
export function firstIncompleteItem(plan, progress) {
  return planItemsInOrder(plan).find((i) => !itemState(i, progress).done) || null;
}

/**
 * What to practise after `item`: the next incomplete item after it in working
 * order, or — when everything later is done — the first incomplete item
 * anywhere in the plan, so a finished item at the bottom still points back up
 * at the one bar he skipped. Null when there is nothing left to do.
 *
 * Never returns `item` itself: a row must not offer itself as its own Next.
 */
export function nextIncompleteItem(plan, progress, item) {
  const order = planItemsInOrder(plan);
  const open = (i) => !itemState(i, progress).done && i.id !== item?.id;
  const at = item ? order.findIndex((i) => i.id === item.id) : -1;
  return order.slice(at + 1).find(open) || order.find(open) || null;
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

/** "60 BPM · 90% · 4 passes", or "78 BPM · 2 passes" for free play. */
export function itemTargetText(item) {
  const passes = `${item.target_passes} pass${item.target_passes === 1 ? "" : "es"}`;
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
  parts.push(`${state.done ? "Done " : ""}${state.shown}/${state.target} today`);
  if (item.instruction) parts.push(item.instruction);
  return parts.join(" · ");
}

/** The compact playing badge: "Plan 2/4", or "Plan ✓" when done. */
export function planBadgeText(state) {
  return state.done ? "Plan ✓" : `Plan ${state.shown}/${state.target}`;
}

/** The snippet-row tag: "Plan · 60 BPM · 2/4", or "Plan ✓" when done. */
export function snippetTagText(item, state) {
  return state.done ? "Plan ✓" : `Plan · ${item.target_effective_bpm} BPM · ${state.shown}/${state.target}`;
}
