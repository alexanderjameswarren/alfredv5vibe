# Drive Mix daily refresh. The Claude scheduled task prompt.

**This file is a snapshot of the live task, 2026-11-05.** Before this, the prompt lived only in
the claude.ai task. It was copied byte for byte from the task, so that git holds the state before
notification routing moved it onto signals.

- **Task:** "Drive Mix daily refresh", trigger `trig_01M9atR63BYAAJx73rWM4Kxj`.
- **Schedule:** daily, **3:54 am Pacific** (4:54 until 2026-10-25), after the DJ daily history
  sync. Schedule row `drive_mix` / `daily_refresh`, executor `claude`, 6 hours' grace.
- **Spec:** `docs/technical-spec-drive_mix-v7r.md` section 7.
- **Edit rule:** change this file, then paste it into the task. Never edit the task alone.

> ## 🛑 A CHANGE TO THIS FILE DOES NOTHING UNTIL IT IS PASTED INTO THE TASK
>
> The task runs the text that was pasted, not the text in this repo. So the prompt carries a
> version, and the final summary and the run details echo it.
>
> ### `PROMPT VERSION: 2026-11-05a`
>
> Bump the date-letter whenever this file changes below the line.
>
> 2026-11-05a: the first version line. A problem item is followed by one `raise_signal` for it;
> the dispatcher decides what reaches Alex, and the task never sends a push.

---

## THE PROMPT — everything below the line goes into the task

---

You are running the Drive Mix daily refresh. Drive Mix is Alex's daily car playlist (YouTube playlist id PLbtyzvGuByeU, title "Drive Mix"), picked each morning from a song pool in Supabase. The DJ daily history sync runs at 3:30 am, just before this. Prompt version: 2026-11-05a. Follow these steps in order. Do not improvise. Run silently: no questions, no notifications beyond the final summary.

Rules that override everything else:
1. NEVER improvise. If something fails or looks wrong, stop at that step and report it (see step 8).
2. Never empty or delete the playlist. Only replace_dj_playlist writes to it.
3. The Alfred server allows 60 calls per 5 minutes; stay well under (this job normally needs about 27, 29 when it raises a problem). On CALL BUDGET EXCEEDED wait 300 seconds once, then continue; any other guardrail error (e.g. LOOP DETECTED) means stop and report.
4. A QUIET DAY IS NOT A PROBLEM. If Alex did not listen to anything yesterday, the history feed has no Today or Yesterday plays and every song carries over. That is a normal outcome and must never raise an inbox item on its own.
5. EVERY RUN IS LOGGED. Step 0 opens a run and Step 9 closes it, including when a step stops early. A run left "running" reads as a job that died.
6. YOU NEVER NOTIFY. Never call send_alfred_push, create_reminder or log_claude_notification, and never send a Claude app push. The problem item (step 8) is followed by one raise_signal for it; the dispatcher decides what reaches Alex.

Tools: load with ToolSearch query "select:mcp__Alfred__create_platform_run,mcp__Alfred__update_platform_run,mcp__Alfred__create_drive_mix_sweep,mcp__Alfred__get_drive_mix_songs,mcp__Alfred__update_drive_mix_songs,mcp__Alfred__create_drive_mix_songs,mcp__Alfred__update_drive_mix_thumbs,mcp__Alfred__get_drive_mix_pick,mcp__Alfred__create_drive_mix_serving,mcp__Alfred__create_inbox_item,mcp__Alfred__raise_signal,mcp__Alfred__get_platform_runs,mcp__Workshop_Surface__get_dj_history,mcp__Workshop_Surface__get_dj_playlists,mcp__Workshop_Surface__replace_dj_playlist".

Step 0 — Open the run. First, call create_platform_run with app "drive_mix", job "daily_refresh", executor "claude", status "running". Keep the run id. If this call fails, carry on with the job anyway and say so in the final summary; there is then no run to close in Step 9.

Step 1 — Date. Today's date for every call is the current UTC date (YYYY-MM-DD). Use it explicitly as `date` everywhere.

Step 2 — Thumbs. Alex's rule: the LATEST thumb wins. Thumbs are recorded ONLY with update_drive_mix_thumbs. Never retire a song for a thumbs down and never reactivate a song yourself: the tool does both (the picker skips thumbs-down songs; a thumbs up revives a song Alex cut).
a) Thumbs down: call get_dj_history with buckets ["Today","Yesterday"], limit 200. Collect every play with like_status "DISLIKE". If it returns no plays at all, that is a quiet day: there are simply no thumbs down to record. Carry on; it is not an error.
b) Thumbs up: call get_dj_playlists mode "contents", playlist_id "LM", limit 40 (Liked Music, most recent likes first). If a liked song is not in the pool (check with get_drive_mix_songs by its artist's lower-cased artist_key) and it is a normal pop/rock/alternative/country/rap/R&B/dance song (NOT instrumental jazz, sleep/meditation/ambient, Christmas, or a multi-hour video), first add it with create_drive_mix_songs, source "playlist_seed", with decade (original release decade) and genre. The tool skips songs already in the pool by video_id.
c) Make ONE update_drive_mix_thumbs call (up to 200 entries) with thumbs: [{video_id, thumbs: "down"}] for every disliked video_id from (a), and [{video_id, thumbs: "up"}] for every liked video_id from (b) that is in the pool. Leave `at` out. If the same video_id appears as both, use "down" only if it is NOT in Liked Music now. Video_ids not in the pool come back as skipped; that is normal. Note any `revived` songs for the summary. If there is nothing to send, skip this call.

Step 3 — Sweep. Call create_drive_mix_sweep (limit 50). It adds songs Alex has played on two or more days as status "pending". Then call get_drive_mix_songs with status "pending" (limit 50) to get the full pending list; if more than 50, tag them and repeat until none are pending.

Step 4 — Tag every pending song.
a) Blocked artists: for each DISTINCT artist_key among the pending songs, call get_drive_mix_songs with artist set to that artist_key and status "retired" (limit 50). If any returned song has retired_reason "cut by Alex artist", that artist is blocked.
b) Decide each pending song from your own knowledge, grouping ids into one update_drive_mix_songs call per identical change (max 50 ids each):
- Blocked artist: retire with retired_reason "cut by Alex artist".
- Instrumental jazz: retire, reason "jazz". (Vocal standards singers such as Sinatra, Fitzgerald, Armstrong, Holiday are KEPT as pop.)
- Instrumental mood music (meditation, Hz/frequency, sleep, spa, yoga, lounge, lofi, nature sounds, cinematic ambient): retire, reason "ambient or sleep".
- Classical: "classical". Christmas/holiday music and film/musical scores or cast recordings: "holiday or soundtrack". Kids/novelty: "kids or novelty". Spoken word/podcast/comedy: "not music".
- Everything else (pop, rock, alternative, country, rap, R&B, dance — including deep cuts, live and acoustic versions): activate with decade (decade of the song's original release: 1950 ... 2020; a cover gets the cover's decade) and genre (pop, rock, alternative, country, rap, rnb, dance, other). Never retire a song for being obscure or for its genre.

Step 5 — Pick. Call get_drive_mix_pick with date = today and no other arguments (count 50, defaults). If it errors, stop and report. Note returned, carried_over, new_cap, new_songs, new_over_cap, cooling_breaks and any slice shortfall.

Step 6 — Write the playlist. Call replace_dj_playlist with playlist_id "PLbtyzvGuByeU" and video_ids exactly as the pick returned them, in order. It returns a proposal first; check the proposal names the playlist "Drive Mix", then re-call with confirmed true. If the title is anything other than "Drive Mix", stop and report — never replace a different playlist.

Step 7 — Record. Only after step 6 succeeded, call create_drive_mix_serving with date = today and the same video_ids in the same order. If it says the date already has a serving, the job already ran today: report it and stop.

Step 8 — Report. Decide whether something went wrong:
- Any step failed or stopped, the pick returned fewer than 50, or any slice shortfall: that is a problem.
- carried_over is 50: check the DJ sync before deciding. Call get_platform_runs with app "dj", job "daily_history_sync", limit 1.
  - If that run started today (UTC date of started_at equals today) and its status is "ok" or "partial", the sync ran fine, so a full carry-over just means Alex did not listen yesterday. That is a quiet day and NOT a problem. Do not report it.
  - If that run is "failed", "running", or did not start today, the sync did not deliver yesterday's listening. That IS a problem; say which (failed, still running, or did not run today) and give the run id.
- Cooling breaks and new songs over the cap are normal and are NOT problems.
Only if there is a problem, call create_inbox_item with source_type "task", source_app "drive_mix", source_metadata {"task_name": "Drive Mix daily refresh", "run_date": "<today>"}, and captured_text starting "Drive Mix refresh problem <date>" followed by a short plain-English description of what happened and at which step. Keep the new inbox id, then call raise_signal once for it: app "drive_mix", job "daily_refresh", started_by "task:drive-mix-daily-refresh"; severity "high" and subject_key "drive_mix:daily_refresh:failure:<failure_kind>" when the run will close "failed" (failure_kind is the lower-case slug Step 9 records), otherwise severity "normal" and subject_key "drive_mix:daily_refresh:problem"; title the item's first line; body one plain line; link "/<inbox id>"; details {"inbox_id": "<inbox id>", "kind": "flag"} (the inbox id tells the dispatcher the item already exists, so it points at it instead of making another); source_ref "<subject_key>:<today>". Keep the returned signal_id. A failed raise_signal never fails the run: note its verbatim error for Step 9 and the summary, and carry on. If everything went normally, create nothing and raise nothing. Finish with a one-line summary: prompt version 2026-11-05a, thumbs down and up recorded, songs revived, songs added from Liked Music, songs swept, activated, retired, songs served, carried over (and "quiet day" if the carry-over was explained by a quiet day), new songs (and how many over the cap), and the inbox item and signal ids if a problem was raised.

Step 9 — Close the run. Last, also if the run stopped early: call update_platform_run with the run id from Step 0, once. Status "ok" when the playlist was replaced and the serving recorded; "partial" when a slice ran short or the sync looked stale; "failed" otherwise, with a one-line error_message and details {"failure_kind": "<short slug>"}. Put {"prompt_version": "2026-11-05a", "songs_added": n, "songs_served": n} in details, plus "inbox_item_id" and "signal_id" when step 8 raised a problem, or "signal_error" when raise_signal failed. Never downgrade a failure to "ok" to get the close accepted.
