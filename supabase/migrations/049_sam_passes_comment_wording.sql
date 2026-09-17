-- MOVED 2026-09-18 from docs/migrations/2026-09-16b-sam-passes-comment-wording.sql
-- Originally written 2026-09-16. Content unchanged below this header.
-- Purpose: Correct the sam_passes column comments: NULL means 'recording began when the column was deployed', not a midnight boundary.
-- Kind: comment-only change
-- Applied: YES — the live comments carry the 'deployed part-way through the day' wording
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- SAM passes: correct the column comments. COMMENTS ONLY — no schema change.
--
-- WHY: the comments describe NULL as meaning "every row written before
-- 2026-09-16", which reads as a midnight boundary. It is not one. Each column
-- started recording the moment it was DEPLOYED, part-way through that day:
-- playback_speed around 07:01 PT, and hits / misses / notes_played /
-- accuracy_percent / hand_mode around 07:28 PT. Passes from 2026-09-16 exist on
-- both sides of both cutovers — six from 06:35–06:40 PT have a NULL speed, and
-- rows between 07:01 and 07:28 have a speed but no accuracy.
--
-- A reader taking the old wording literally would conclude that correct data is
-- wrong. The new wording says what NULL actually means (not recorded, because
-- the row predates the column's deployment) and states plainly that
-- completed_at cannot be used to infer what a NULL "should" have been.
--
-- Safe to re-run. Comment-only changes cannot affect the platform contract, but
-- conformance is re-checked at the end per the contract.

comment on column public.sam_passes.playback_speed is
  'Playback speed percentage in force when the pass completed (100 = normal). NULL means NOT RECORDED — not 100. This column began recording when it was deployed, part-way through 2026-09-16 (~07:01 PT), so passes from that day exist both with and without a value and completed_at cannot be used to infer what a NULL should have been. The NULL is the fact: the speed was never captured and is unrecoverable. Only audio-backed songs expose a speed control, so non-audio songs record 100.';

comment on column public.sam_passes.effective_bpm is
  'Generated: round(bpm * playback_speed / 100.0). The tempo actually heard, so 60 bpm at 80% reads 48. NULL whenever playback_speed is NULL — i.e. for any pass recorded before that column was deployed part-way through 2026-09-16 — because an unknown speed gives an unknown effective tempo. Read this for "how fast was it really"; read bpm for "what did the tempo box say".';

comment on column public.sam_passes.hits is
  'Notes played correctly during this pass, from the same per-playthrough counters usePracticeSession keeps for the live display. Partials are counted separately by the app and are NOT included here, matching accuracyOf(). NULL means NOT RECORDED: this column began recording when it was deployed, part-way through 2026-09-16 (~07:28 PT), so passes from that day exist both with and without a value. Do not infer a value from completed_at.';

comment on column public.sam_passes.misses is
  'Beats scored as missed or wrong during this pass. NOTE: a miss is raised on elapsed time alone and does not require MIDI input, so a pass played with no keyboard attached records 0 hits and a full count of misses. Use notes_played to tell that apart from playing badly. NULL means NOT RECORDED — deployed part-way through 2026-09-16 (~07:28 PT), so that day has rows on both sides.';

comment on column public.sam_passes.notes_played is
  'Count of MIDI notes that actually arrived during this pass. 0 means nothing was played — a playback test, or the player was not at the keyboard — which is why accuracy_percent is NULL rather than 0 for those rows. This is the only reliable way to exclude test data from practice history. NULL means NOT RECORDED, which is a THIRD state distinct from both 0 and any positive count: deployed part-way through 2026-09-16 (~07:28 PT), so that day has rows on both sides. A filter for "played" and a filter for "not played" together do NOT cover the NULL rows.';

comment on column public.sam_passes.accuracy_percent is
  'Generated: round(hits * 100 / (hits + misses)), or NULL when notes_played is 0, when no beats were scored, or when hits/misses were never recorded. NULL means unmeasurable; 0 means measured and every note wrong. Do not treat NULL as 0 in any aggregate. The inputs began recording part-way through 2026-09-16 (~07:28 PT), so passes from that day exist on both sides of the change.';

comment on column public.sam_passes.hand_mode is
  'Which hand the player was SCORED on for this pass: both | lh | rh. Recoverable from the snippet for snippet passes, but not for whole-song passes, where it was previously indistinguishable — and hand mode is the likeliest explanation for an accuracy jump. NULL means NOT RECORDED — deployed part-way through 2026-09-16 (~07:28 PT), so that day has rows on both sides.';

-- Per the platform contract, every migration block ends here.
-- Expected: CONFORMANT, plus a table count.
select platform.check_conformance();
-- If the above errors because the platform schema is not exposed to your
-- session, the public wrapper is equivalent:
--   select public.platform_check_conformance();
