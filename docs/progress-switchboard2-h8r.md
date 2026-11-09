# Switchboard 2.0 — Progress

Project code: `switchboard2-h8r`
Spec: `docs/technical-spec-switchboard2-h8r.md`

Status: Phases 0 to 3 complete (Phase 3's worktree finished and merged as cb42ff8 on 2026-11-05). Part 3, git by link, continues under the same code in a fresh worktree; the docs came back from `docs/history/` at s80b-s80c. Next: s81.

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

## Steps

The run tag is filled in when a step runs. Database items are claimed just in time, at the step that needs them.

| phase | step | description | db items | status | date |
|---|---|---|---|---|---|
| — | s1 | Read-only plan | — | done | 2026-10-29 |
| — | s2 | Claim Phase 0 files; write spec and progress | — | done | 2026-10-29 |
| — | s3 | Fold in later decisions: phase order, tile states, clicks, plan guard, sandboxes | — | done | 2026-10-29 |
| — | s4 | Tier decisions; next step's scope at the end of every report | — | done | 2026-10-29 |
| 0 | 0.1 | Split out the shell parser; fix `>` in quotes, `=>`, heredoc and script writes | — | done (s5-m3tx) | 2026-10-29 |
| 0 | 0.2 | Guard and hooks on the new parser; hooks tests; diff `a/` and `b/` prefixes | — | done (s6-p5ua) | 2026-10-29 |
| 0 | 0.3 | `number-migration`; gitpush refuses `_pending_` files and duplicate numbers; gitsync `--no-edit`; "Done at"; gitcom echo | — | done (s7-c6hn) | 2026-10-29 |
| 0 | 0.4 | Main blocks live-worktree codes; duplicate run tag refused; README links | — | done (s8-v9qe) | 2026-10-29 |
| 0 | 0.5 | Plan guard: parse the scope block, record it, enforce create, update, delete, deploy and SQL | — | done (s9-k7wf) | 2026-10-29 |
| 0 | 0.6 | Scope vs changes in the report; cli-workflow skill scope summary; CLAUDE.md | — | done (s10-r2jd) | 2026-10-29 |
| 0 | 0.7 | Module boundaries: bridge vs clipper in `extension/`, header interfaces | — | done (s11-n6hb) | 2026-10-29 |
| 0 | 0.8 | `INTERFACES.md` draft; full test run | — | done (s12-w4tc) | 2026-10-29 |
| 1 | 1.1 | Send to CLI: extension and host | — | done (s13-q2vx) | 2026-10-29 |
| — | s14 | Re-plan Phase 1: Send by a link in the reply; Alfred's address is a setting | — | done (s14-h5rc) | 2026-10-29 |
| 1 | 1.2 | Send link: host list, click catch, prompt frame | — | done (s15-b3nk) | 2026-10-29 |
| 1 | 1.3 | Send link: panel pastes into the project's window | — | done (s16-f7pz) | 2026-10-29 |
| 1 | 1.4 | Alfred `/send/:runTag` fallback page | — | done (s17-c4mz) | 2026-10-30 |
| 1 | 1.5 | Skill: a Send link under every prompt | — | done (s18-k8tn) | 2026-10-30 |
| 1 | 1.6 | Tile states, including Outside scope and Not sent | — | done (s19-v6pd, s19c-y2rt); Report unread moved to Phase 2 | 2026-10-30 |
| 1 | 1.7 | Running colours by time left | — | done (s20-m7qc) | 2026-10-31 |
| 1 | 1.8 | Estimate on the tile; Estimate vs actual | — | done (s21-p4hw) | 2026-10-31 |
| 1 | 1.9 | Progress strip | — | done (s22-g3lm) | 2026-10-31 |
| 1 | 1.10 | Six-tile layout and lane order | — | partly done (s23-x5lt): layout done; lane order needs lane data, moved to Phase 2 | 2026-10-31 |
| 2 | 2.1 | Phase 2 plan | — | done (s24-q8pn) | 2026-10-31 |
| 2 | 2.2 | Write the plan into the progress file and spec | — | done (s25-m4tc) | 2026-10-31 |
| 2 | 2.3 | Queue schema | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:table:switchboard_settings`, `db:fn:switchboard_issue_link`, `db:fn:switchboard_consume_link` | done (s26-r7kd, s26b-t3wn): migration 189 run by Alex; all 40 verify checks passed; CONFORMANT (97 tables); checkpointed | 2026-10-31 |
| 2 | 2.3b | `.clip` exemption only inside a thread's own checkout; plan guard refuses other checkouts | — | done (s27-h9qp) | 2026-10-31 |
| 2 | 2.4 | Runner function and CLI queue | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_consume_link`, `db:deploy` | done (s28-w2bv, s28b-k5fd, s28c-n8jx): deployed, verify_jwt off, `/queue` smoke-tested; run routes first exercised at 2.6 | 2026-10-31 |
| 2 | 2.4b | `deployTargets` skips flag values and stops at redirects | — | done (s29-c6mt) | 2026-10-31 |
| 2 | 2.5 | MCP tools: issue a link, get a run | `db:fn:switchboard_issue_link`, `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:deploy` | deployed (s30-p4zr), CONFORMANT (97 tables); neither tool has run live yet: first calls from claude.ai | 2026-11-01 |
| 2 | 2.6 | Approve page | — | done (s31-v8ke): end-to-end on the live app. Claude read action 26f0cc8f-6ef0-4f14-81da-a915ad086e5b and issued the link (second link refused); Alex dry-ran and approved; run b9a740a5-53e3-409f-a503-122ec57e310a succeeded with one row; reload showed "already been used"; get_switchboard_run by run id shows succeeded. Run id is `data-switchboard-run-id`, real runs only | 2026-11-01 |
| 2 | 2.7 | Extension: approval link and result | — | done (s32-j3ya, s32b-q6hu, s32c-f2wl): end-to-end in Chrome. Claude issued a link for action c0c8ead7-da8d-4967-8f79-d284e6a2df5b in a claude.ai tab; Alex clicked it there; dry run posted nothing; Approve ran it; "sql 773effb0-0bc4-414a-bae1-c00ce4e6d81b" sent itself to that tab; get_switchboard_run shows succeeded with one row. `chat_url` dropped from the spec; hosts are allowed at run time (1.2.1) | 2026-11-01 |
| 2 | 2.8 | Panel read endpoint | `db:table:switchboard_actions`, `db:table:inbox`, `db:table:clips`, `db:table:portfolios`, `db:table:project_plans`, `db:table:portfolio_plans`, `db:table:portfolio_lanes`, `db:table:portfolio_slices` (all read), `db:deploy` | done (s33-x7gd, s33b-m5cq): deployed, verify_jwt off; no key 401, wrong key 401, POST 405; with the key 25 projects; switchboard2-h8r in lane Main, order 2, nothing waiting; report_unread seen true on a fresh clip. `waiting_on_alex` true not yet seen live: first at 2.9. Checkpointed by Alex; `db:deploy` released | 2026-11-01 |
| 2 | 2.7c | One-click approve and closing the tab | — | done with one bug (s34-b9tn): checkpointed, extension 1.2.2. The dry run ran on open and Approve ran run eaf76ba0-ae0d-4620-a414-ff46b24f3d68 (succeeded, select 3), but `sql <run id>` was never posted and the tab didn't close; the page showed "Done, you can close this tab." Fixed in 2.7d. Skipping the dry run for selects dropped by Alex | 2026-11-01 |
| 2 | 2.7d | Missed post, honest headline, plain description | `db:deploy` | done with one serious bug (s35-k2pe): headline, description and automatic dry run correct; run 3f6609cd-5867-457e-b88b-8147e6f373e7 succeeded after an extension reload. But Alex was mid-message with a screenshot in the box and no text: the extension sent his unfinished message, posted the line and closed the tab, because the box check treated an attachment as empty. Fixed in 2.7e | 2026-11-01 |
| 2 | 2.7e | Posting guards, matching Send cli | — | done (s36-r4vh), extension 1.2.4: with a screenshot in the chat's box, Approve ran run 5596a17d-fdc3-4892-9cc4-8859dd2e813e (succeeded); nothing was sent, the chat wasn't touched, the tab stayed open with the line, Copy and the banner; after the box was cleared, Try again posted "sql 5596a17d-..." and the tab closed | 2026-11-01 |
| 2 | 2.7f | The approve page looks and behaves like the rest of Alfred | — | done (s37-w6fa), extension 1.2.5: Alex checkpointed and tested; the page matches Alfred, the message and Try again sit inside the card, Copy works, and Try again posted run d3b5b803-a007-40fa-986c-220f4e501ee0 (succeeded) and closed the tab | 2026-11-01 |
| 2 | 2.9 | Panel: Waiting on SQL, Report unread, lane order, tap rules | — | done (s38-d4ms): Alex checkpointed and restarted the panel; the switchboard2 tile showed tan "Waiting on SQL"; lanes ran gmail capture, switchboard2, arnold v1, warren buffet p4, then the rest; approving ran run 014ef9a9-c2d1-4fbb-92de-0dbcb7b0a6a7 (succeeded), which posted back by itself. The orange and red tap rules are not yet seen live | 2026-11-01 |
| 2 | 2.9c | Tile order and grid size; Send link's plain words | — | done (s44-a9rj), extension 1.2.8: Alex checkpointed, restarted the panel and reloaded the extension. Decided (s46): 3×2 keeps long names as they are, so a two-line name with "Both working" and an estimate stays cut | 2026-11-02 |
| 2 | 2.9b | Send to CLI link shows Sending, Sent or Not sent | — | done (s39-g8pt, s40-n3hy), extension 1.2.6: built and checkpointed; Alex reloaded the extension and restarted the panel. Live test: s40's own Send link; host.log shows the prompt written at 19:19:36 UTC and "delivery switchboard2-h8r-s40-n3hy: sent" at 19:19:38, and the prompt arrived. The link's on-page words are for Alex to confirm | 2026-11-01 |
| 2 | 2.10 | Read-only role and query function, with secret-column grants | `db:table:switchboard_read_log`, `db:table:switchboard_settings`, `db:fn:switchboard_readonly_query`, `db:fn:check_call_budget` (read), `db:fn:register_table`, `db:fn:set_read_settings` | part 1, the spike. First run (s40-n3hy; run 5e3d1548-64c3-445c-a6c7-8db3f6f5d11a, action dd1c9102-be92-4cb1-a8c1-6dec633ed622) stopped in setup: "create the query function: 0A000 parameter "transaction_read_only" cannot be set locally in functions"; rolled_back true. Every earlier stage worked through the runner: create role claude_reader, grant it to current_user, usage on public and auth, execute on auth.uid(). Second design (s40b-v2rk), run a992aa41-766e-45cd-95a9-e99ea2531d5e: passed 32 of 35. The 3 failures were the predicted ones: the role raised back to postgres from inside a query and reached auth.users; claims forged to see another user's row. Alex decided: claude_reader gets its own login; every read rule names Alex's id directly, not auth.uid(); one rule per table. Part 2 (s41-c5nb, s41b-y8dt, s41c-q3zf): migration 192 ran through the queue: dry run 2ac65ed1-6e5b-4f63-ba10-047397ba7ccd matched the real run 6f31c9ae-150c-4ce8-a72e-29ed687411c8 (action 9edf0f5c-cee3-48c1-863c-5c754d068de1). 88 tables covered; 11 left out, all "no user_id column" (apps, allowed_emails, sam_song_lyrics, sam_song_scores, collection_items, sam_song_measures, dj_playlist_tracks, item_group_members, sam_session_events, sam_song_fingerings, collection_item_removals); CONFORMANT, 98 tables. Possible later step: a read rule for those 11 through the parent row's owner. Done: verify test run e7814f53-e6c9-4781-91b1-6dedfe566515 passed 35 of 36; the failure was no_schema_but_public: claude_reader has usage on schema net (pg_net). Alex set the password from a pre-hashed SCRAM value and stored SWITCHBOARD_READER_DB_URL; a real login printed "logged in as: claude_reader", "raising to postgres refused: permission denied to set role "postgres"", "auth.users refused: permission denied for schema auth". Alex checkpointed 2.10 | 2026-11-01 |
| 2 | 2.7g | Approve page: counts, expected counts, Don't run, Copy details, test kind | `db:deploy` | done (s43-t5vb), extension 1.2.7: Alex checkpointed and reloaded the extension. Wrong-count action d181d1d8-cc08-414b-baab-ceae90316b00: dry run da8de2a9-1f5e-40d0-a801-b1875d81cbe8 showed "2 rows, expected 5" with statement 3 in bold, Approve disabled; Copy details worked; Don't run with reason "count test" posted "sql da8de2a9-... cancelled: count test", closed the tab, and the action shows cancelled with the reason saved. Test action 93e2101d-f8ef-4bc4-8cb9-534870adff97 ran once by itself, no Approve, rows_seen 2, posted "sql e14cf128-13b3-4e41-96bf-843c92446d64". A test action's "done" is status `succeeded` or `failed` | 2026-11-02 |
| 2 | 2.11 | MCP read-only query tool, `get_sql_read` | `db:deploy` | deployed (s42-m7wq, s42b-h6kx), CONFORMANT (98 tables). Live checks from claude.ai: the limits held (one statement, read-only writes refused, 10s timeout, auth and secret column refused, 1000-row cap, log correct). But net is open: the schema grants usage to PUBLIC, anon and authenticated; both net tables grant all privileges to PUBLIC; all 12 net functions run for PUBLIC (no ACL); all granted by supabase_admin. claude_reader read net._http_response (360 rows). net.http_get was stopped only by read-only. No public function calls net.http_* (only extensions.grant_pg_net_access). Alex decided: a plan guard in get_sql_read (built in s42b; not yet seen live) and an undone test of revoking net (`3_net_revoke_test.sql`, queued as 9a59549f-20a0-4694-85f7-ca1c977146c7). The budget counts from `switchboard_read_log`, not `check_call_budget`, which counts every tool's calls. Done (s43-t5vb): the guard passed live (net._http_response, net.http_get, information_schema and query_to_xml refused; switchboard_actions and pg_class allowed). The revoke test (run 7b666e1a-bd11-4b76-8981-1ad775329f43) ran all 18 statements with no effect: every role's net access was the same before and after, because supabase_admin made the grants. Two cron jobs use net (notify-dispatch-every-minute, wb-sync-daily), both as postgres. Decision: net stays open at source; get_sql_read's plan guard plus read-only are the protection | 2026-11-02 |
| 2 | 2.12 | Skill rule and Phase 2 checklist | — | done (s45-e2lc, s47-x4fu): CLAUDE.md, the skill (version 2026-11-02), spec §7 and the checklist below. The skill's flow was used live end to end on the kill switch actions | 2026-11-02 |
| — | s48 | Plan for the tile bug, the move, git by link, Salesforce reads and actions | — | done (s48-k3vq) | 2026-11-02 |
| — | s49 | Docs back in `docs/`; plan and Alex's decisions written in; Part 1 re-planned | — | done (s49-p7wd) | 2026-11-02 |
| tiles | s50 | A claims check records no block | — | done (s50-r4ty) | 2026-11-02 |
| tiles | s51 | A closed chat's saved link gives way | — | done (s51-h2nz, s51b-w6jc): test-status, smoke and bridge host tests all pass. Live test failed; s51c-q8bx found the cause, no code changed: `readTag` in `extension/claude-watch.js` reports a tag only from a chat's latest reply, so a chat whose latest reply has no prompt can't take over until its next prompt lands. Waiting on Alex's choice | 2026-11-02 |
| tiles | s52 | One live link per project code; kind and expiry in the link | see "Database items" below | done (s52-c8mu, s52b-n5ge, s52c-t9ka): migration 196, action 1fc1a816-31ee-491f-84b3-e0e7a06ac526, run 16d873c0-162c-4a99-b595-97bf33de0a00 succeeded, CONFORMANT (101 tables). Verify test, action 0f9726b6-c43d-48c4-ba47-27ef381558f2, run dccc75fe-d8ab-4848-a274-8300eb6305dd, passed 9 of 9. `mcp` deployed; CONFORMANT (101 tables) after it | 2026-11-02 |
| tiles | s53 | Approval link states and `lastTag`: extension and approve page | — | built, unit tests pass (s53-v3ld), extension 1.2.9; seen live at s55 | 2026-11-02 |
| tiles | s54 | Tile states from the chat; re-pairing on `lastTag` | — | built (s54-j6wp): test-status, smoke and bridge host tests all pass; seen live at s55 | 2026-11-02 |
| tiles | s55 | Live test of the five states | — | done (s55-x2rf), with one bug fixed in s55b: live on extension 1.2.9, tan "SQL ready", the link's Sent, light green "SQL running", the result posted and "Claude writing"; with text in the box, red "SQL not posted", the page kept the line and Try again, a tap cleared to "Your turn", and Try again posted. Actions 96ad49f7-7ff4-43e3-bc5f-41569d935c26 and c0f0e983-d212-4067-a648-1ccf420feee6; runs 20b85a9b-2f51-4ec6-86e6-30aa576739b5 and 4bf80586-9033-4e8a-9511-99e35b4d32f3 | 2026-11-02 |
| tiles | s55b | A link whose run has finished stops counting as live | — | done (s55b-m4zh), extension 1.2.10, in main. No separate retest, by Alex's choice: the next real link will show it | 2026-11-02 |
| 3 | s56 | Seed script and dry run | — | done (s56-g7tn, s56b-d5qv): the seed ran into the scratchpad, 78 files, 41 rewrites. Node tests there: 408 pass, 34 fail, all for s57 to fix; panel tests pass | 2026-11-02 |
| 3 | s57-s57d | Seed run, tests green (new repo, `switchboard_repo-k7m`) | — | done, switchboard f565e94: the guard accepts `claims/` and `clip/` paths as well as `scripts/`, tests use the new repo's files, the Overwatch sender is found from its library, version strings | 2026-11-03 |
| 3 | s58 | install.ps1 (new repo) | — | done, switchboard 2b66af7: install to `%LOCALAPPDATA%\Switchboard`, `.gitattributes`, README install section | 2026-11-03 |
| 3 | s59, s59b | Config loader (new repo) | — | done, switchboard 2096122: `loader/load.mjs` (`repos.json`, `projects.json`), Overwatch and `setupCmd` per repo, WRONG REPO in prompt-check, install copies the loader | 2026-11-03 |
| 3 | s60, s60b | User-level hooks (new repo) | — | done, switchboard ac77b8d, installed: the known-repo rule and stand-back, the sound in every folder, install registers them with a backup | 2026-11-03 |
| 3 | s61 | Shims in alfred-v5 | — | built (s61-q3jx): scripts, hooks and the libraries alfred-v5 still imports run the installed copy; moved tests and unused libraries deleted; `scripts/lib` tests 54 pass | 2026-11-03 |
| 3 | s62-s68 | `sb repo/project/org`, client start and end, Salesforce guard, deploy wrapper, compare and tiers, PII hold, finish modes (switchboard repo) | — | done, switchboard commits 13b1a2b to 12f75f6 | 2026-11-04 |
| 3 | s69 | Panel across repos | — | done, switchboard 215335b: every repo in `projects.json`, settings in `config\panel.ini`, install makes the shortcuts, git commands read `mainBranch` | 2026-11-04 |
| 3 | s70 | Client reports | — | done, switchboard 7212976: clip attaches git's change list to every client-repo report; gitpush skips the Overwatch inventory where there is no alfred-v5 mcp | 2026-11-04 |
| 3 | s71 | Claims init and clip fixes | — | done, switchboard dd7aa78: `claims init` (`sb client start` runs it); a missing claims file blocks only repo changes; report text sent to clip is never read as a change; `clip --last`; `claims.cmd` recognised; chat titles match with spaces | 2026-11-04 |
| 3 | s72 | Shared sf org check | — | done, switchboard 9bb9943: one org check (display, org list, instance URL) with named failures; "Report sent" and "Report held" tiles; Alex's own sf usernames pass the PII hold; install stops and restarts the panel | 2026-11-04 |
| 3 | s73 | Bridge and Terminal tiles | — | done, switchboard a9a55d3: bridge host registered to the install; per-repo Terminal tiles; `sb org verify` on the shared helper; `sb deploy` and `sb test` print coverage | 2026-11-04 |
| 3 | s74, s74b | Panel layout A | — | done, switchboard 7562934, b95bbb1: repo groups, a black Terminal tile with a PS badge, drag scrolling, chats grouped by project code; `sb repo name` | 2026-11-04 |
| 3 | s75a, s75d, s75e | Extension split | — | done, switchboard 5028bb0, 13bdf7e: fixed id `bfehbmjaaplaplldfdcgjifgjimchldf` from a manifest key, installed to `%LOCALAPPDATA%\Switchboard\extension`; the seed had copied 6 of its 20 files, now whole; install names what holds the panel folder and always restarts the panel | 2026-11-04 |
| 3 | FIRST CLIENT GATE | Team IMPACT | — | passed: registered by `--adopt`; two fixes built, reviewed and deployed to sandbox and production, each in its own worktree | 2026-11-04 |
| 3 | s75b | alfred-v5 cutover plan | — | done (s75b-n6gw), read-only; the skill yielded to cli_rules-v8m | 2026-11-04 |
| 3 | s76 | Overwatch without the repo's sender | — | done, switchboard 4018732: `repos.json` `overwatch: true` posts through the installed sender, on for alfred-v5; bridge for the fixed id only; the brown top bar back | 2026-11-04 |
| 3 | s77 | CLAUDE.md names the installed commands | — | built (s77-k8dz) | 2026-11-04 |
| 3 | s78, s79, s79b | Settings handover, then deleting the shims and dead folders; then Finish | — | done: s79b deleted the shims and dead folders; Finish merged as cb42ff8. Phase 3 complete | 2026-11-05 |
| 5 git | s80, s80b, s80c | Queue changes: git payload check, `picked_up_at`, needs_click by type, no link for no-click actions, `switchboard_pickup_git` | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:table:clips`, `db:fn:switchboard_issue_link` | migration 206 succeeded (action 56a7cf70-fc54-4285-922a-017b506fc06c, run 305cba34-1598-4c26-9dec-8a1d68ec8882), CONFORMANT (103 tables); `6_verify_git.sql` passed 17 of 18 (run 529be5c5-7de1-4ab7-b619-7968180ac5cf). The failure, a gitpush with no mode let through by a null check, is fixed by migration 207 (action 0035347d-ff7e-442e-b644-538cbdea09b7) and the test re-queued (action 3b2cfdd4-fc23-4a00-8fe5-8834d820960a); both awaiting approval. clips.source comment names clip.cmd | 2026-11-05 |
| 5 git | s81 | Runner: helper pickup and result, pickup key | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:deploy` | deployed (s81-c9wt): `/pickup` and `/result` behind `x-switchboard-pickup-key` (`SWITCHBOARD_PICKUP_KEY`, constant-time, separate from the queue key). A pick with no result for 30 minutes is failed at the next pickup. No key: 401 on `/pickup`, `/result` and `/queue`. Runner tests 51 pass. Waiting on Alex to set the key | 2026-11-05 |
| 5 git | s82, s82b | Helper and by-link mode (switchboard repo, as switchboard_repo-k7m) | — | done (s82-x4mb, s82b-n2fy), uncommitted there until Alex's `gitpush main push`. The helper runs allowlisted git actions in a visible window and posts `/result`; it picks up on an approval trigger, not a timer; `helper.mjs --status`. By link, a question becomes exit 3. Finish takes `--phase` or `--project-done`, and only `--project-done` archives the docs | 2026-11-05 |
| docs | s83, s83b | docs/ tidy: only open projects' docs stay in docs/ | — | done. s83 (s83-d6lt) was a read-only audit of the 24 files. s83b (s83b-h3vq) moved 10 to docs/history/, each confirmed byte-identical before its source was deleted: progress-gmail-capture, progress-email-capture, technical-spec-email-capture, progress-record_links-r7k, progress-sam-rail, lyrics-paste-progress, oauth_consent-progress, restructure-p1-progress, restructure-p2-progress, review-warren_buffet_p2-m4t. technical-spec-gmail-capture's two links now point at history. Kept by Alex's decision: Drive Mix's spec and progress, and the gmail capture spec (code comments name both specs). Also kept: the eight task prompts, which are live automations; skills read four of them, and inventory.mjs would mark one in history as retired | 2026-11-05 |
| 5 git | s84 | MCP tool `queue_switchboard_git` (spec §11.3) | `db:table:switchboard_actions`, `db:deploy` | partly done (s84-m6qr): the tool, its payload checks and headlines in switchboard.ts, 7 new tests (45 pass), spec §11.3. **Waiting:** (1) mcp/index.ts and index.test.mjs, held by notification_routing-d7v (block recorded), for registration and the deploy; (2) a database step for `switchboard_queue_git`, because authenticated can't insert into switchboard_actions | 2026-11-05 |
| 5 git | s84c | `switchboard_queue_git` (database half) | `db:table:switchboard_actions`, `db:fn:switchboard_queue_git` | migration 208 queued (action fed21064-9ed7-4d47-9715-960012a16305): security definer, needs a signed-in caller, inserts kind git as created_by claude, returns `{action_id}`, execute for authenticated only. Test `7_verify_queue_git.sql` queued (action 1a707c7f-8c3b-4a9a-9e67-d8dcd7335a73), to run after 208. Conformance before 208: CONFORMANT (103). **Remaining, as s84d:** register the tool in mcp/index.ts (held by notification_routing-d7v), the deploy, the bad-payload check | 2026-11-05 |
| 5 git | s84b | Approve page for git actions; three cli-workflow rules | — | done on the page side (s84b-k4zw). For a git action (`preview.kind` 'git'), the page says what will run in plain words, has no dry run, Approve says it went to the desktop helper and the result comes back to the chat, the action id is the run mark, and the chat line is `git <action id>`. SQL is unchanged. 4 new tests (31 pass). cli-workflow 2026-11-05a: send a prompt for a held file anyway; a delete or move starts with Set-Location or uses absolute paths; an extension reload goes in the reinstall step. **Needs s84e:** the runner still treats every link as SQL | 2026-11-05 |
| 5 git | s84e | Runner: git links on /preview, /approve, /cancel | `db:deploy` | built, not deployed (s84e-b5rn). A git link's /preview returns `kind` and `payload`. /approve checks the link as before, then spends it with the fingerprint: the action is consumed for the helper, no dry run is asked for, and nothing runs; it replies `{ok, action_id, sent: true}`. /cancel needs no dry run. /dry-run is refused. SQL is unchanged. 6 new tests, 57 pass. Deployed in s84k: a bad JWT, no queue secret, no pickup key and a wrong one all get 401, and an unknown route gets 404, each with the runner's own body | 2026-11-05 |
| 5 git | s84d | Register `queue_switchboard_git`, deploy mcp | `db:deploy` | done in s84k (s84k-j4qe): registered in mcp/index.ts with a zod schema for each payload key; index.test.mjs expects it (195 tools, 41 pass). mcp deployed; an unauthenticated call gets 401. 208 and its test both ran (succeeded). **Not yet checked live:** the bad-payload refusal, because this session's Alfred connector loaded its tool list before the deploy | 2026-11-05 |
| 5 git | s84k | s84d plus the s84e deploy | `db:deploy` | done (s84k-j4qe): switchboard-runner and mcp deployed while holding db:deploy. Yielded docs/history/progress-sam-rail.md to sam_cleanup-m4t (unchanged from main) | 2026-11-05 |
| 5 git | s84s | get_switchboard_run reads git runs; queue_switchboard_git's reply; cli-workflow 2026-11-06a | `db:deploy` | partly done (s84s-v7nd). In switchboard.ts, get_switchboard_run takes `project_code` as a third way in (exactly one of three): that code's latest action of any kind and its latest run. A bad code is refused; one with no actions gives "no action for <code>.". queue_switchboard_git keeps `chat_url` only when it's https://claude.ai/chat/<uuid> and drops anything else, and replies with `next`: the result arrives in this chat, or say "check the git run". 5 new tests, 49 pass. The skill is at 2026-11-06a: tests before the checkpoint; Expected lines describe the screen; git result lines; how to write scope paths. **Blocked:** mcp/index.ts and index.test.mjs are held by notification_routing-d7v (block recorded), so the descriptions and the mcp deploy wait for s84t | 2026-11-06 |
| 5 git | s84t | The mcp half of s84s | — | stopped (s84t-q4jx): main had moved, with notification routing's mcp/index.ts changes, and the CLI doesn't run gitsync. Alex ran gitsync by link (action 440ff091) | 2026-11-06 |
| 5 git | s84t2 | The mcp half of s84s | `db:deploy` | done (s84t2-r6mh), after confirming main is merged. mcp/index.ts: get_switchboard_run advertises `project_code` and says what succeeded and failed mean for git; queue_switchboard_git says the result line arrives by itself, also mentions "check the git run", and says chat_url is optional, chat addresses only. 1 new test, 91 pass. mcp deployed. Live: project_code switchboard2-h8r returned the gitsync action 440ff091 (succeeded, summary ending "Merged main into worktree-switchboard2-h8r"); "Bad Code" was refused | 2026-11-06 |
| 5 git | s84f | Git result lines in the chat (switchboard repo) | — | todo. The extension posts `sql <id>` for every approval (`runLine` ignores kind; POST_LINE allows only `sql <uuid>`), so a git approval posts the wrong line. Nothing posts the outcome after the helper's /result: the panel tile shows Git done or Git failed, and that's all | |
| 5 git | s85 | Skill and CLAUDE.md for git by link; dot-folder paths; stale claims | `db:deploy` | done (s85-h3cz), live test pending. cli-workflow 2026-11-06b adds a "Git by link" section; a reply with a git link carries no prompt; a prompt offered again is repeated whole with its Send link. CLAUDE.md: Alex runs git by link, and nothing changes for the CLI. switchboard.ts: `usablePath` accepts dot-folder segments (.claude/...) and refuses ., .., a leading / or -, drive letters, backslashes and empty segments; 2 new tests, 51 pass. mcp deployed. Released the 20 docs-tidy claims, mcp/index.ts and index.test.mjs. **Open:** the helper's PATH_WORD (switchboard helper/lib/core.mjs:31) still refuses .claude paths at run time | 2026-11-06 |
| 5 git | s86a | Design of s86 | — | done (s86a-p5ke): spec §11.4-11.7. Six read-only checks, with the guard's `checkOrg` run fresh before each; production refused by link; sb setup by link within limits; new kinds `sf_check` and `sb_setup` (a migration). Split into s86b, s86c, s86e, s86d and s86f, in that order. Spec §5.4 and §11.2 updated to match; §11.3's "doesn't exist yet" corrected. Alex decided at s86b: D1 A, D2 A, D3 A, and D4 a developer sandbox with sb org add by link, the alias named at s86f | 2026-11-06 |
| 5 git | s86b | Helper kinds: migration and test | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_needs_click`, `db:fn:switchboard_queue_helper`, `db:fn:switchboard_queue_git`, `db:fn:switchboard_pickup_helper` | written (s86b-d2sq), not numbered or applied. `_pending_switchboard2-h8r_helper_kinds.sql`: kinds sf_check and sb_setup; an sf_check payload check (the six checks, the alias, metadata_type only for metadata, no other key); an sb_setup payload check holding D2 (types developer, developer_pro, partial or full; level objects or metadata; no contract key; only known keys); needs_click (sf_check false, sb_setup true); `switchboard_queue_helper`; `switchboard_queue_git` through it; `switchboard_pickup_helper` (returns kind). `8_verify_helper_kinds.sql`: 45 checks, or 43 when a real action is ready and the pickup checks are skipped. Live: the migration plus the test, in one rolled-back --test run, queued as action d5d5c58c-a0ce-468c-a3eb-2b242a3cde3a; result not in yet. db claims released at the end of the step. That run (11a56942) passed 43 of 45: sf_missing_alias_refused and sf_metadata_without_type_refused failed, because a CHECK passes on NULL | 2026-11-06 |
| 5 git | s86b1 | NULL-safe checks, expiry, wake-up options | as s86b, plus `db:deploy` | written (s86b1-f7wr), not numbered or applied. Both payload checks coalesce every condition to false, and the array lengths sit behind a CASE; the NULL paths are now tested (6 for sf_check, 9 for sb_setup). switchboard_pickup_helper fails queued no-click actions over 10 minutes old, with a run saying "expired before the helper picked it up"; tested with back-dated rows, including an old clicked action that must not expire. The test has 64 checks, or 58 when the pickup checks are skipped. Wake-up options A, B and C are in spec §11.4; A (the extension sees `sf <id> queued`) is recommended. Rolled-back test queued as action f24fe176-f6e6-48dc-8571-a943bb542b7f; it passed 64 of 64 | 2026-11-06 |
| 5 git | s86ba | Number and queue the helper-kinds migration (was s86b2) | as s86b, plus `db:deploy` | live (s86ba-m3jt): applied, verified 64/64 and checkpointed (main 6bb9fea), per the s86c prompt. Alex's gitsync (b865a364) brought in 216 and 217, which don't touch switchboard (217 only names 206 in a comment), so it's 218. 218_switchboard_helper_kinds.sql is byte-identical to the tested pending file, which is deleted. Apply queued as a91ed98a-921a-4e3a-a5b9-9c41c1d787ce; 8_verify_helper_kinds.sql queued with --test to run after it, as f154bc53-a728-41af-b0a1-897143083263. Conformance before: CONFORMANT (103). The schema snapshot is left to gitpush. db claims held until the checkpoint | 2026-11-06 |
| 5 git | s86c | Runner: helper kinds | `db:deploy` | done (s86c-t6yb). /pickup takes body `kinds`: none (the helper today posts `{}`) or `["git"]` uses switchboard_pickup_git, git only; all of git, sf_check, sb_setup uses switchboard_pickup_helper; any other list is a 400, since pickup_helper has no kind filter. Every pick carries `kind`. sb_setup links behave as git; sf_check is refused on every link route (409); other non-sql kinds too. /result and the 30-minute rule cover all three kinds. 10 new tests, 67 pass. Deployed; live refused calls all 401 with the runner's own body. | |
| 5 git | s86d | Tools and approve page for sf_check and sb_setup | `db:deploy` | done (s86d-k8xr). queue_switchboard_sf_check: the six checks, alias, metadata_type for metadata only; switchboard_queue_helper with kind sf_check; never a link; the reply asks Claude to end with `sf <id> queued`, says the result arrives as `sf <id> done or failed`, and the 10-minute expiry. queue_switchboard_sb_setup: client start (1-10 orgs, one `--org-setup` each, one source) or org add (exactly one org); D2 refused in the tool (production, ids/data, contract and production_allowed keys); queue then link; the description says ask Alex first. Approve page: sb answers, the files written, the login warning, `data-switchboard-kind="sb_setup"`, `sb <id>` lines. get_switchboard_run covers both kinds. Spec §11.4 and §11.5 updated. Tests: tools 60, mcp 44, page 34. mcp deployed; live list has 200 tools and both new ones; bad-token calls refused. | |
| 5 git | s86h | Setup and checks with no project code; the from_sandbox folder | `db:table:switchboard_actions`, `db:deploy` | written (s86h-r2tx), not numbered or applied. `_pending_switchboard2-h8r_setup_folder.sql`: switchboard_queue_helper derives `sf-<alias>` or `sb-<client>` when no code is given (NOT NULL, issue_link and pickup unchanged: one live link per client, one running per alias); 218's sb_setup check re-added with `folder` in the key list; a new `switchboard_actions_sb_setup_folder` check, NOT VALID for the one cancelled from_sandbox row. `9_verify_setup_folder.sql`: 39 checks. Migration plus test queued as one rolled-back --test, c1ffbbd3-b86f-46a7-b9e6-d67b2020c257. Tools: sf_check project_code optional; sb_setup takes no project_code and needs `folder` with from_sandbox; approve page shows the folder in full and that it must be empty. Tests: tools 62, mcp 45, approve page 36. mcp not deployed: it sends a null code and `folder`, which 218 refuses, so it waits for the migration (s86h2). db claims released at the end of the step | 2026-11-08 |
| 5 git | s86ha | Number and queue the setup-folder migration (was s86h2) | `db:table:switchboard_actions`, `db:deploy` | queued (s86ha-v9fe). Alex's gitsync (18ad339c) left 218 newest, so it's 219. 219_switchboard_setup_folder.sql is byte-identical to the tested pending file (c1ffbbd3, 39/39), which is deleted. Apply queued as 6c69fb78-dc1a-419b-945b-683b09c6845d; 9_verify_setup_folder.sql queued with --test to run after it, as 3b0cd9de-f7ec-4101-954e-76b6427990de. mcp deploy waits for s86hb. The schema snapshot is left to gitpush. db claims held until the checkpoint | 2026-11-08 |
| 5 git | s86hb, s86hc | Renumber the setup-folder migration to 220, deploy mcp | `db:deploy` | done (s86hc-j7pd; s86hb-q3wn stopped at a plan guard block, its scope had SQL none). **Renumbered 219 → 220**: overwatch_settings-t3k checkpointed its own 219_overwatch_nightly_counts_settings.sql into main while ours was uncommitted. Both are live and touch different objects, so nothing was re-applied: 220_switchboard_setup_folder.sql is byte-identical to the 219 file applied as 6c69fb78 and verified 39/39 as 3b0cd9de (sha256 549f36c6…), and our 219 is deleted. mcp deployed: live tools/list has 200 tools, sf_check's project_code optional, sb_setup with `folder` and no project_code; a bad-token call was refused ("Invalid JWT") and queued nothing; conformance CONFORMANT (103). The schema snapshot is left to gitpush. db:deploy held until the checkpoint | 2026-11-08 |
| 5 git | s86hd | Redeploy mcp with both chats' changes | `db:deploy` | done (s86hd-w4kc). After s86hc, overwatch_settings-t3k deployed mcp v210 from its own worktree, which didn't have our s86h tools, so the live tools went back to s86d (project_code required, no folder). Alex's gitsync (9f2c8302) merged main 721726d here; HEAD equals main and supabase/functions has no diff against it. Deployed as v211 from this worktree. Live: 200 tools; sf_check needs only check and alias; sb_setup has `folder` and the "ASK ALEX" line, no project_code; a bad-token call refused and queued nothing; no token 401. Overwatch's nightly change (silence threshold from counts.limits) gives the same live output as the old code, because the plan has no silence_hours and limits holds the default 36; it's in v211 because the source equals main. **Switchboard fix list:** the deploy guard should refuse a function deploy from a worktree missing main's commits. db:deploy held until the checkpoint | 2026-11-09 |
| 5 git | s86k | gitnewtree names its repo (alfred-v5 half of switchboard s86j); cli-workflow 2026-11-09a | `db:table:switchboard_actions`, `db:deploy` | partly done (s86k-n6qv). **Blocked:** notification_routing-d7v holds supabase/functions/mcp/index.ts and index.test.mjs; the claim was refused and recorded, so queue_switchboard_git's schema and description don't name `repo` yet, and mcp isn't deployed. Done: `_pending_switchboard2-h8r_gitnewtree_repo.sql` adds `switchboard_actions_git_repo` (repo only on a gitnewtree, `C:\...`, at most 240, no `..`, NULL-safe, validated: no git row has a repo); `11_verify_gitnewtree_repo.sql`, 23 checks; migration plus test queued as one rolled-back --test, a4bf5614-d1fa-4e8b-9a4b-8df88f2dd015. switchboard.ts: gitnewtree takes `repo` (GIT_REPO), trimmed, refused on other commands; the headline names it. Approve page: a gitnewtree says which repo. cli-workflow 2026-11-09a and CLAUDE.md: `claims number-migration` gives the number, never by hand; one git link per reply; a deploy refused from a worktree missing main means a gitsync link; gitnewtree by link names its repo. Tests: tools 62, page 36. db:deploy not claimed, since nothing could deploy | 2026-11-09 |
| 5 git | s86kb, s86kc | The mcp half of s86k; number and queue the migration | `db:table:switchboard_actions`, `db:deploy`, `db:migration:222` | stopped (s86kc-b8wd; s86kb-t5ry stopped because main wasn't merged, and Alex's gitsync 2d2379cd fixed that). mcp/index.ts: queue_switchboard_git advertises `repo` for gitnewtree, schema and description; 1 new test, 47 pass. `claims number-migration` gave 222 and claimed db:migration:222, but not the file, so the claims guard blocked writing supabase/migrations/222_gitnewtree_repo.sql. Not written, not queued, mcp not deployed. db:table and db:deploy released; db:migration:222 kept | 2026-11-09 |
| 5 git | s86kd | Write and queue 222 | `db:table:switchboard_actions`, `db:migration:222` | queued (s86kd-f2mx). 222_gitnewtree_repo.sql is byte-identical to the pending file tested 23/23 as a4bf5614 (sha256 eca721a3…), which is deleted. Apply queued as 7ff990f5-02ef-4178-bc4d-10fabc221192; 11_verify_gitnewtree_repo.sql queued with --test to run after it, as 3e936105-3d1b-43dc-a118-8c5785074f66. **Switchboard fix list:** `claims number-migration` claims the number (db:migration:NNN) but not the file it names, so the claims guard blocks writing it until the file is claimed separately. mcp deploy waits for 222 to be live. db claims held until the checkpoint | 2026-11-09 |
| 5 git | s86ke | Deploy mcp with the gitnewtree repo | `db:deploy` | done (s86ke-p9dk). 222 live (apply 87f20def), verified 23/23 (5ea4ef9d). main is in HEAD. mcp deployed as v213, carrying the s86kc edit on top of notification_routing-d7v's merged changes. Live tools/list: 200 tools; queue_switchboard_git has `repo` and "FILL IN repo"; create_reminder, send_alfred_push and log_claude_notification still require started_by; sb_setup still has `folder`. A bad-token gitnewtree call with a repo got "Invalid JWT" and queued nothing. Conformance CONFORMANT (103). db:deploy held until the checkpoint | 2026-11-09 |
| 5 git | s86m | Panel finds every run tag | `db:deploy` | code done (s86m-q7vd), not deployed. switchboard-panel/core.ts: PROJECT_OF_TAG's step segment was `s\d+[a-z]?`, so tags like s86ka to s86ke never matched, and the panel showed "Your turn" instead of "Send cli". It's now `s\d[a-z0-9]*`, as claims reads it (switchboard s86l), through an exported `projectOfTag`. 1 new test (s86kd, s86l, s86, s1, four non-tags, and an s86ke clip read as unread); 8 pass. Not deployed: main's 887d5de (the schema snapshot only) isn't in this worktree, so it waits for a gitsync. db:deploy released | 2026-11-09 |
| 5 git | s86ma | Deploy switchboard-panel | `db:deploy` | done (s86ma-wk4p). After Alex's gitsync, main is in HEAD. switchboard-panel deployed as v5 with s86m's `s\d[a-z0-9]*` tag pattern; a call with no key got 401 `{"ok":false,"error":"unauthorized"}`. s86l's panel (EndpointReadsTag, LinkForProject) is installed. Live tests for Alex: a two-letter report tile, and a link lighting only its own tile. db:deploy held until the checkpoint | 2026-11-09 |
| 5 git | s86p | Plan: sf_check by link | none | done (s86p-h2nc). Alex decided 2026-11-09 that sandbox checks use links for now; a no-click design is its own project. Only `switchboard_needs_click` changes; the runner, tool, page and extension follow | 2026-11-09 |
| 5 git | s86pa | sf_check by link: code, pending migration, verify 12 | none | built (s86pa-n6xb). Pending migration `_pending_switchboard2-h8r_sf_check_click.sql` (needs_click true for sf_check); verify 12 (22 checks); rolled-back test queued as 2be76f4f, not yet run. queue_switchboard_sf_check queues then issues the link (as sb_setup), no queued_line; mcp description and get_switchboard_run's sentence updated. Runner: sf_check goes to handleHelperRun. Approve page: sfLines, `sf <id>` and `sf <id> cancelled`. Tests: tools 62, mcp 47, runner 69, page 39. Spec §11.4, §11.6. Not numbered, not deployed | 2026-11-09 |
| 5 git | s86q (switchboard repo) | Extension takes sf_check approvals | none | todo: isHelperKind and cleanRun take sf_check, `sf <id> cancelled` in runLine and both POST_LINE copies, bridge.js remembers its chat | |
| 5 git | s86pb | Number, queue, deploy runner | `db:deploy` | done (s86pb-v5mr). Test 2be76f4f passed 22/22 and s86q (extension 1.2.19) is installed. main in HEAD, no drift (main still 204f9ab). number-migration gave 223: `223_sf_check_click.sql`, byte-identical to the pending file, which is deleted. Queued for real as e8cd1dc5-4118-4137-ab1d-62fed7eea295, not yet applied. switchboard-runner deployed as v11; keyless call 401 `{"ok":false,"error":"unauthorized"}`. mcp not deployed (still v213). db:deploy held for the next step | 2026-11-09 |
| 5 git | s86pc | Checkpoint, deploy mcp, conformance, verify 12 live | `db:deploy` | todo: after 223 is applied and the checkpoint (223, ApprovePage) lands | |
| 5 git | s86f, s87 | Live test of sandbox checks and sb setup by link (see below), the panel snapshot | see below | todo | |
| 4 | s88-s92 | Salesforce reads: spec §10 | see below | todo | |
| 5 SF | s93-s96 | Salesforce actions by link: spec §11 | see below | todo | |
| 6-8 | | Spec §12-§14 | | todo | |

## Proposed scope per step (Phase 0)

Every report ends with the next step's block, copied from here. The progress file is implied in every block.

**0.1, shell parser split and fixes**
- create: scripts/lib/shell-parse.mjs, scripts/lib/shell-parse.test.mjs
- update: scripts/lib/claims-core.mjs, scripts/lib/claims-core.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**0.2, guard and hooks on the new parser**
- create: nothing
- update: .claude/hooks/claims-guard.mjs, scripts/lib/hooks.test.mjs, scripts/lib/shell-parse.mjs, scripts/lib/shell-parse.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**0.3, migration numbers, gitsync, gitpush** (estimated run: 12m)
- create: nothing
- update: scripts/claims.mjs, scripts/lib/claims-core.mjs, scripts/lib/claims-core.test.mjs, scripts/git-push-worktrees.mjs, scripts/git-sync.mjs, scripts/lib/git-flow.mjs, scripts/lib/git-flow.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**0.4, wrong-window on main, duplicate run tag, README** (estimated run: 10m)
- create: nothing
- update: scripts/lib/project-code.mjs, scripts/lib/project-code.test.mjs, .claude/hooks/prompt-check.mjs, scripts/lib/hooks.test.mjs, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/README.md
- delete: nothing
- deploy: nothing
- SQL: none

**0.5, plan guard** (estimated run: 15m)
- create: .claude/hooks/plan-guard.mjs, scripts/lib/plan-scope.mjs, scripts/lib/plan-scope.test.mjs
- update: .claude/hooks/prompt-check.mjs, .claude/settings.local.json, scripts/lib/hooks.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none
- **Not yet claimed:** `.claude/settings.local.json`, `scripts/lib/plan-scope.mjs` and `scripts/lib/plan-scope.test.mjs`. They need Alex's OK at that step.

**0.6, report sections, skill, CLAUDE.md** (estimated run: 15m)
- create: nothing
- update: scripts/clip.mjs, scripts/lib/last-report.mjs, scripts/lib/clip.test.mjs, .claude/skills/cli-workflow/SKILL.md, .claude/CLAUDE.md
- delete: nothing
- deploy: nothing
- SQL: none

**0.7, module boundaries** (estimated run: 15m)
- create: extension/lib/ (only if the bridge split needs a new module)
- update: extension/, tools/claude-sessions/, scripts/lib/session-status.mjs, scripts/lib/session-status.test.mjs, .claude/hooks/ (headers)
- delete: nothing
- deploy: nothing
- SQL: none

**0.8, interfaces draft and full test run** (estimated run: 12m)
- create: tools/claude-sessions/INTERFACES.md
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none

## Proposed scope per step (Phase 1)

**1.1, send to CLI: extension and host** (estimated run: 20m). The claude.ai tab's prompt goes through the bridge to the native host, which writes it for the panel. Duplicate tags are refused.
- create: nothing
- update: extension/bridge.js, extension/claude-watch.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

*Re-planned in s14: Send is a link in the reply (spec §7.1), not a tile tap. The old 1.2 block is replaced by the blocks below.*

**1.2, Send link: host list, click catch, prompt frame** (estimated run: 12m). The host reads `[links] hosts=` from the panel's settings.ini and sends it in `hello`. `claude-watch.js` catches clicks and middle-clicks on `/send/<tag>` links to listed hosts, reads the prompt from the same reply, and sends it on. `bridge.js` closes a `/send/` tab that opens anyway. The host takes an extension-sent `prompt` frame in place of the 1.1 `sendprompt` command path, which is removed.
- create: nothing
- update: extension/claude-watch.js, extension/bridge.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

**1.3, Send link: panel pastes into the project's window** (estimated run: 15m). The panel sees `prompt-<project>.json` and finds that project's VS Code window; none found means nothing is sent, and it never uses the active window. It refuses while the tile is Running. Otherwise it focuses Claude Code's input, pastes, submits, restores the clipboard and deletes the file. A refusal turns the tile red "Not sent" until tapped. That covers the panel's own refusals, and the host's or extension's in `prompt-result.json` (`ok: false`, with `project` and `error`). It starts by confirming how to focus Claude Code's input reliably, and stops to ask if there is no reliable way.
- create: nothing
- update: tools/claude-sessions/lib/bridge.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

**1.4, Alfred fallback page** (estimated run: 6m). The app route `/send/:runTag`: the tag, its project, and "Send this from your desktop". It reads no data and needs no sign-in.
- create: src/switchboard/SendFromDesktop.jsx, src/switchboard/SendFromDesktop.test.jsx
- update: src/App.js
- delete: nothing
- deploy: nothing
- SQL: none

**1.5, skill: a Send link under every prompt** (estimated run: 4m). It adds one base-address line (`Alfred base: https://alfredv5vibe.vercel.app`). Every reply with a prompt ends with `[Send to CLI](<base>/send/<run tag>)` directly under the prompt block. The tile no longer sends. Bump the version.

  Done in s18, version 2026-10-30. **Checkpoint for 1.4 and 1.5 together:** src/switchboard/SendFromDesktop.jsx, src/switchboard/SendFromDesktop.test.jsx, src/App.js, .claude/skills/cli-workflow/SKILL.md, docs/progress-switchboard2-h8r.md.
- create: nothing
- update: .claude/skills/cli-workflow/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: none

**1.6, tile states** (estimated run: 12m). This covers the five states and their precedence, dark variants, and two reds cleared by a tap. "Outside scope" is written by the plan guard as `wrong` / `outside scope`. "Not sent" comes from 1.3's refusal. "Report unread" needs interface 3; if that needs a Supabase function, the step stops and plans the database items first. Rename the orange tile label "Send cli" (a report is waiting) to "Report ready": it is easily confused with the Send link (s17).
- create: nothing
- update: tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, .claude/hooks/plan-guard.mjs, scripts/lib/session-status.mjs, scripts/lib/session-status.test.mjs, scripts/lib/hooks.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**1.7, running colours by time left** (estimated run: 6m). Spec §7.5.
- create: nothing
- update: tools/claude-sessions/lib/status.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**1.8, estimate on the tile; Estimate vs actual** (estimated run: 10m). The panel already reads `estimate` from `.clip/scope.json` (1.7, `ReadScope`, `s.estimate`); 1.8 shows it as `0:30 / 2:30`. `clip.mjs` prints the Estimate vs actual line for the report and appends to `.clip/estimates.jsonl`.
- create: nothing
- update: scripts/clip.mjs, scripts/lib/last-report.mjs, scripts/lib/clip.test.mjs, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**1.9, progress strip** (estimated run: 6m). Spec §7.6, with the `progressStrip` setting on the status menu.
- create: nothing
- update: tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**1.10, six-tile layout and lane order** (estimated run: 10m). Spec §7.7 and §7.3: the 3 × 2 grid, the type scale, the "7+" hint, re-measured fit tables, and tiles ordered by lane.
- create: nothing
- update: tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk
- delete: nothing
- deploy: nothing
- SQL: none

**2.1, Phase 2 plan** (estimated run: 6m). Done in s24-q8pn; read-only.
- create: nothing
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none

**2.2, write the plan into the progress file and spec** (estimated run: 3m). Done in s25-m4tc.
- create: nothing
- update: docs/progress-switchboard2-h8r.md, docs/technical-spec-switchboard2-h8r.md
- delete: nothing
- deploy: nothing
- SQL: none

**2.3, queue schema** (database step; estimated run: 12m). Tables `switchboard_actions`, `switchboard_runs` and `switchboard_settings`, with RLS via `register_table`, explicit grants, nothing for anon, and a pg_cron prune at 30 days. Functions `switchboard_issue_link` and `switchboard_consume_link`: single-use, bound to the fingerprint, 30-minute expiry, one live link at a time. Alex tests: run the migration and get CONFORMANT; in the verify script a second use, a changed fingerprint, an expired link and a second live link each fail.
- create: supabase/migrations/_pending_switchboard2-h8r_queue.sql, supabase/tests/switchboard2-h8r/1_verify_queue.sql
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: switchboard_actions, switchboard_runs, switchboard_settings

**2.3b, close the `.clip` gap** (estimated run: 5m; added in s26b, from the stray file in s25). A worktree could write the main checkout's `.clip/` files, because `foreignPath` treats exempt paths as not foreign and the plan guard allows anything outside its own checkout. Apply the `.clip` exemption only inside a thread's own checkout, make the plan guard refuse writes to other checkouts, and add tests, including another worktree's `.clip/`. Alex tests: nothing by hand; the hooks suite covers it.
- create: nothing
- update: scripts/lib/claims-core.mjs, scripts/lib/claims-core.test.mjs, .claude/hooks/plan-guard.mjs, scripts/lib/hooks.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**2.4, runner function and CLI queue** (database step; estimated run: 15m). `switchboard-runner`: a `queue` endpoint (queue key, inserts `kind='sql'` only); `dry-run` and `approve` endpoints (valid JWT and approval link, one transaction over `SUPABASE_DB_URL`). It flags statements that cannot run in a transaction and slow statement types, and sends those to the SQL editor. It builds the capitals headline on the server, runs `check_platform_conformance` after each write and records each run in `switchboard_runs`. `scripts/sql-queue.mjs` queues a `_pending_` or numbered file. Alex tests: set `SWITCHBOARD_QUEUE_SECRET`, queue a harmless SELECT from the CLI, see the row.
- create: supabase/functions/switchboard-runner/index.ts, supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs, scripts/sql-queue.mjs, scripts/lib/sql-queue.mjs, scripts/lib/sql-queue.test.mjs
- update: nothing
- delete: nothing
- deploy: switchboard-runner
- SQL: none

**2.4b, fix `deployTargets`** (estimated run: 4m; added in s28c). `deployTargets` in scripts/lib/plan-scope.mjs takes every word after `deploy` that does not start with `-` as a function name, so `deploy x --project-ref abc 2>&1` was refused as "undeclared deploy: abc, 2>". Skip flag values, stop at redirects, with tests. A real second function name must still be refused.
- create: nothing
- update: scripts/lib/plan-scope.mjs, scripts/lib/plan-scope.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**2.5, MCP tools: issue a link, get a run** (database step; estimated run: 8m). `issue_switchboard_link` (tier 2) writes the link hash through `switchboard_issue_link`, which refuses a second live link. `get_switchboard_run` (tier 1). Alex tests: ask Claude to issue a link for the queued item, then a second, which is refused.
- create: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs
- update: supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- delete: nothing
- deploy: mcp
- SQL: none

**2.6, approve page** (estimated run: 10m). `/approve/:token`: needs Alex's Alfred login; shows the headline, the SQL, Dry run, then Approve. After Approve the run id is on the page as a data attribute. Alex tests, after a push: a dry run rolls back; Approve runs once; a second click fails; logged out asks for login; it works from the phone.
- create: src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx
- update: src/App.js
- delete: nothing
- deploy: nothing
- SQL: none

**2.7, extension: approval link and result** (estimated run: 12m). Recognises `/approve/` on the listed hosts and remembers the tab the link was clicked in. It reads the run id and project from the approve page's data attributes and posts `sql <run id>` into that tab once the chat is idle; a link opened elsewhere falls back to one matching chat. Alex tests: approve from the chat (posted there).
- create: nothing
- update: extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/bridge.js, extension/claude-watch.js, extension/lib/config.js, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none

**2.8, panel read endpoint** (database step; estimated run: 10m). `switchboard-panel`, with its own key that can do nothing else. It returns, per project code, whether the latest CLI report's inbox item is unarchived, whether an action is waiting on Alex, and the lane (`project_plans.project_code` → group → `portfolio_slices` → `portfolio_lanes` in the active plans). Alex tests: curl with the key returns his lanes.
- create: supabase/functions/switchboard-panel/index.ts, supabase/functions/switchboard-panel/core.ts, supabase/functions/switchboard-panel/core.test.mjs, supabase/functions/switchboard-panel/deno.json
- update: supabase/config.toml
- delete: nothing
- deploy: switchboard-panel
- SQL: none

**2.7c, one-click approve and closing the tab** (added in s33; estimated run: 8m). The approve page runs the dry run by itself when it opens, so Alex makes one click, Approve. After `sql <run id>` has been posted, the extension closes the approve tab. Where it can't (the phone, or posting failed), the page says "Done, you can close this tab." Alex tests: from a claude.ai tab, one click posts the line and the tab closes; on the phone, the page shows the sentence.
- create: nothing
- update: src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, extension/bridge.js, extension/claude-watch.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json
- delete: nothing
- deploy: nothing
- SQL: none

**2.7d, missed post, honest headline, plain description** (added in s35; estimated run: 15m). The extension stores clicked tabs and waiting runs and says on the page why a post can't go. A select that may write gets a "may change data" headline. `sql-queue.mjs` requires `--describe`, stored as `payload.description` and shown above the SQL. Alex tests: the steps in the s35 report.
- create: nothing
- update: supabase/functions/switchboard-runner/index.ts, supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs, scripts/sql-queue.mjs, scripts/lib/sql-queue.mjs, scripts/lib/sql-queue.test.mjs, src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, extension/bridge.js, extension/claude-watch.js, extension/service-worker.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json, docs/technical-spec-switchboard2-h8r.md
- delete: nothing
- deploy: switchboard-runner
- SQL: none

**2.7e, posting guards** (added in s36; estimated run: 10m). Post only into a completely empty box with Claude not replying, one rule shared with Send cli. If it can't post, the chat isn't touched and the tab stays open with the line, Copy, and Try again. The tab closes only after a confirmed post.
- create: nothing
- update: extension/bridge.js, extension/claude-watch.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json, src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx
- delete: nothing
- deploy: nothing
- SQL: none

**2.7f, the approve page looks and behaves like the rest of Alfred** (added in s37; estimated run: 10m). The "not posted" message goes inside the card, under the sql line, in an element the page reserves (`data-switchboard-status`); the extension fills it and its Try again button and draws nothing of its own. Copy is the shared `CopyButton`. Buttons and heading follow Alfred's existing pages.
- create: nothing
- update: src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, extension/bridge.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json
- delete: nothing
- deploy: nothing
- SQL: none

**2.9b, Send to CLI link shows what happened** (added in s37; estimated run: 12m; after 2.9). The link changes the moment it's clicked to "Sending…" and ignores further clicks, then "Sent ✓" once the panel confirms delivery, or "Not sent" with the reason. The panel and host report delivery back to the extension. The extension's link text on claude.ai is the only page change. Alex tests: a double click sends once; a delivered prompt shows Sent ✓; with the project's window closed, Not sent and why.

Also in 2.9b (noted in s38): the "Claude is still writing" reason says "wait until Claude finishes, then try again", not "clear that". The "Approve" subtitle under "Alfred" on the approve page is too faint: normal dark text. And Send cli while Claude is replying still types `cli` into the box unsent (`cliPlan` "type"); the panel now calls that blocked, but the typed word then blocks the retry, so Send cli should touch nothing there.
- create: nothing
- update: src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, extension/bridge.js, extension/claude-watch.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/smoke-test.ahk, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

**2.9, panel: Waiting on SQL, Report unread, lane order** (estimated run: 8m). The panel polls the endpoint and caches the lanes; an unknown lane sorts last. Alex tests: a queued item shows tan; archiving the report clears orange; tiles follow his lanes. Also: a tap on a red latch tile (such as Outside scope) only clears the latch, even if a report is waiting underneath. In s32's session a tap on a red Outside scope tile typed "cli" instead.
- create: nothing
- update: tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, tools/claude-sessions/INTERFACES.md
- delete: nothing
- deploy: nothing
- SQL: none

**2.9c, tile order and grid size; Send link's plain words** (added in s41b; estimated run: 12m). The main checkout's tile always first, then lane_order, then everything else. Up to 6 tiles at today's size in 3×2; 7 or more at the previous smaller size in 3×3, so 9 fit before scrolling; text stays readable at the smaller size. Waiting on SQL (tan) stays the top priority as today, with one change: tan shows only when the CLI is not running. While the CLI runs, the tile stays running green, even if an action was queued during the run; tan appears once the run ends. The Send to CLI link's "Sending…" and "Sent ✓" lose their link styling: plain text, not clickable-looking. Alex tests: tile order with main bound and free; 6 and 7 tiles; a sent link's look. The link's words are the extension's, so its files are in this block.
- create: nothing
- update: tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, tools/claude-sessions/INTERFACES.md, extension/claude-watch.js, extension/lib/bridge-core.test.mjs, extension/manifest.json
- delete: nothing
- deploy: nothing
- SQL: none

**2.7g, approve page: counts, expected counts, Don't run, Copy details, test kind** (added in s41; estimated run: 20m; a runner deploy). Per-statement counts shown after the dry run. The CLI states expected counts when queueing, and the runner blocks Approve on a mismatch, showing expected and actual. A Don't run button with an optional one-line reason posts "sql <dry-run id> cancelled" with the same guards and closes the tab on success. Copy details beside any error. A "test" kind of action only runs undone, never offers Approve, shows its result and posts back.
- create: nothing
- update: supabase/functions/switchboard-runner/index.ts, supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs, scripts/sql-queue.mjs, scripts/lib/sql-queue.mjs, scripts/lib/sql-queue.test.mjs, src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, extension/bridge.js, extension/claude-watch.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json
- delete: nothing
- deploy: switchboard-runner
- SQL: none

**2.10, read-only role and query function** (database step; estimated run: 12m). Starts with a small test of the guarded function: it runs as `claude_reader` and answers only for Alex's user. Only then the real work: `switchboard_read_log`, `switchboard_readonly_query` (read-only, one statement, 1000 rows, 10s timeout, 1s lock wait), and column-level grants built from `platform_read_settings()`, with a helper that re-applies them when the list changes. The kill switch is `switchboard_settings.reads_enabled`. Alex tests: a write, two statements, a secret column and a slow query are each refused; rows are capped; another user's rows never appear.
- create: supabase/migrations/_pending_switchboard2-h8r_reads.sql, supabase/tests/switchboard2-h8r/2_verify_reads.sql
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: switchboard_read_log, switchboard_settings

**2.11, MCP read-only query tool** (database step; estimated run: 8m). `get_sql_read` calls `check_call_budget` twice (20 per 10 minutes, 200 per day), checks the kill switch, and logs every call. Alex tests: Claude runs a query; the 21st in 10 minutes is refused; the kill switch blocks reads.
- create: nothing
- update: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- delete: nothing
- deploy: mcp
- SQL: none

**2.12, skill rule and Phase 2 checklist** (estimated run: 5m). The cli-workflow skill gets the order: queue, Claude reviews, Claude issues the link (one at a time), then fetches the result. Claude quotes the description next to the headline and link in chat, and shows only the approve link, not a link to the action as an Alfred record. Alex tests: the Phase 2 checklist below.
- create: nothing
- update: .claude/skills/cli-workflow/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: none

Database items per step are in the table at the top. Report unread and lane order (moved from 1.6 and 1.10) are 2.8 and 2.9. The migration number comes from `claims.mjs number-migration` at the deploy step, after `gitsync` and the drift check.

**Claims and drift (s25-m4tc):**
- `claims.mjs check` on supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs and `db:deploy`: all free, no conflicts. Arnold's s24 conflict is clear. Nothing claimed.
- Drift from the 2026-10-31 gitsync (db331fc to a7f0030, Arnold and Gmail capture): migrations 186-188 touch only `arnold_*` and `claude_notification*` objects, and platform.ts is unchanged. No Phase 2 table or function is touched, and no step needs re-planning. `mcp/index.ts` and its test gained Arnold's tools, so 2.5 builds on the new versions. The new tables are registered, so 2.10's grants cover them like any other.

## Proposed scope per step (s50 onward)

From the s48 plan and Alex's decisions in s49. A block leaves out any list that is nothing or none. Blocks from s56 to s72 and s80 to s96 (renumbered at s77) name folders where the files don't exist yet; each is narrowed to real paths when its prompt is written.

### Part 1, tile fixes, ahead of the move

**s50, a claims check records no block** (estimated run: 6m). Decision D. `cmdCheck` stops calling `recordBlocks`; only a refused claim and the guard record one. Any `via: "check"` record left in the blocks file is dropped on read, so an old false block clears itself. The file was already empty at s49. The help text in `claims.mjs` stops saying a refused check is recorded. Alex tests: nothing by hand; `check` on a held file reports the conflict and exits 1, and `status` shows no block.
- update: scripts/claims.mjs, scripts/lib/claims-core.mjs, scripts/lib/claim-blocks.test.mjs

**s51, a closed chat's saved link gives way** (estimated run: 8m). Decision E. A pure function in status.ahk picks the link: the saved one while its tab is open; if the chat list is fresh and its tab is gone, the open chat that issued the project's newest run tag, by step number; otherwise the saved one. `LearnChatLink` uses it. Alex tests: close a project's chat, open a new one that issues a tag, and its tile joins the CLI's.
- update: tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/lib/status.ahk, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk

**s52, one live link per project code; kind and expiry in the link** (database step; estimated run: 10m). Decision C, and what A and B need. `switchboard_issue_link` looks for a live link in the same `project_code` only, and appends `?kind=<kind>&exp=<unix seconds>` to the URL. The kinds shown are `sql`, `git` and `deploy` (for `sf_deploy` and `sf_test`). The tool's description and the skill's "One link is live" line say per project. If warren_buffet still holds `mcp/index.ts`, the migration goes first and the description waits. Alex tests: a second link in one project is refused; a link in another project is issued.
- create: supabase/migrations/_pending_switchboard2-h8r_link_per_project.sql, supabase/migrations/196_link_per_project.sql, supabase/tests/switchboard2-h8r/4_verify_link_per_project.sql
- update: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs, .claude/skills/cli-workflow/SKILL.md
- delete: supabase/migrations/_pending_switchboard2-h8r_link_per_project.sql
- deploy: mcp
- SQL: switchboard_actions

*A database step's block must list the numbered file and the `_pending_` delete, or the plan guard refuses them at the numbering (s52). s80, s87 and s88 need the same when their prompts are written.*

**s52c, deploy `mcp`** (estimated run: 3m; after migration 196 has run and its test has passed). Claim `db:deploy` at this step, deploy, run `check_platform_conformance`, then Alex checkpoints.
- create: nothing
- update: nothing
- delete: nothing
- deploy: mcp
- SQL: none

**s53, approval link states: extension and approve page** (estimated run: 12m). Decisions A and B. The watcher finds a live approval link in the latest finished reply, reading kind and expiry from the URL; a link with neither counts as `sql` with no expiry, so links already issued keep working. The bridge tracks each clicked link's state and drives its text, "Sending…" then "Sent ✓". The approve page gains `data-switchboard-running`, with the kind, while a real or test run is under way. The chat report and the host carry only `{kind, state}`, never the token. Manifest version bump. Alex tests: tile states come in s54; here, the link's words and the unit tests.
- update: extension/claude-watch.js, extension/bridge.js, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/manifest.json, tools/claude-sessions/bridge/host.mjs, tools/claude-sessions/bridge/host.test.mjs, tools/claude-sessions/INTERFACES.md, src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx

**s54, tile states from the chat** (estimated run: 10m). Decisions A and B. `ViewOf` takes the chat's approval state and shows tan "SQL ready", "Git ready" or "Deploy ready"; the short green "SQL running" and so on; and a red "SQL not posted" and so on, which a tap clears. The panel stops reading `waiting_on_alex`. `FocusTarget` sends a tap on a "… running" tile to the chat. The old "Waiting on SQL" label goes everywhere. Re-pairing uses `chats.json`'s `lastTag` instead of `issuedTag`, so a chat whose latest reply has no prompt can take over a closed chat's link (decision on s51c). The fields come from s53: `approveKind` (null means no live link), `approveState`, `approveStateKind`, `lastTag`. Alex tests: the checks in `test-status.ahk`; live in s55.
- update: tools/claude-sessions/lib/status.ahk, tools/claude-sessions/claude-sessions.ahk, tools/claude-sessions/ui/switchboard.html, tools/claude-sessions/test-status.ahk, tools/claude-sessions/smoke-test.ahk, tools/claude-sessions/README.md, tools/claude-sessions/INTERFACES.md

**s55, live test of the five states** (estimated run: 5m). After Alex checkpoints s52 to s54, reloads the extension and restarts the panel. Queue a harmless action: orange, not tan. Claude issues a link: "SQL ready". Click: Sending, Sent. Approve: "SQL running". Result posted: "Claude writing", at once. Then a screenshot in the box: red "SQL not posted"; and a link left to expire: not tan. Git and Deploy labels are seen in tests only until their links exist. Fixes are named at the time in a follow-up prompt.
- update: nothing

### Part 2, the move

Blocks are rooted in the new repo, `C:\Users\Alex\projects\switchboard\`, unless they say alfred-v5.

**s56, seed script (alfred-v5 window)** (estimated run: 15m). The path map and import rewrite; dry run into the scratchpad, with tests run there. An approved exception to the Edit and Write rule (s49).
- create: tools/switchboard-seed/seed.ps1, tools/switchboard-seed/path-map.json

**s57, seed run and tests green** (estimated run: 15m). Alex runs the seed and commits; the first prompt in the new window. The dry run (s56b) showed what's to fix: the guard's and the claims parser's pinned `scripts/` paths (`isLoneScriptCommand` and the claims command parser in `claims/lib/claims-core.mjs`), and the test paths. It starts with a first claim, since a repo with no claims file blocks every write.
- update: claims/lib/claims-core.mjs, claims/lib/claims-core.test.mjs, claims/lib/project-code.test.mjs, hooks/lib/hooks.test.mjs, overwatch/lib/overwatch-post.test.mjs, panel/INTERFACES.md with version strings

**s58, install.ps1** (estimated run: 10m). Copies code, puts commands on PATH. No hooks yet.
- create: install.ps1

**s59, config loader** (estimated run: 10m). `repos.json` and `projects.json`, read by every command; the project code finds the folder.
- create: config/load.mjs and its test
- update: claims/, git/, hooks/prompt-check.mjs

**s60, user-level hooks** (estimated run: 12m). No-op outside listed repos; install.ps1 registers them.
- update: hooks/, install.ps1, tests

**s61, shims in alfred-v5 (alfred-v5 window)** (estimated run: 15m). Shims, CLAUDE.md and the skill. Changed from the plan: the hooks stay as shims, and the project hook settings stay, so every worktree keeps working until s72.
- update: scripts/, .claude/hooks/, .claude/CLAUDE.md, .claude/skills/cli-workflow/SKILL.md
- delete: scripts/lib/

Notes from s57 to s61, for the steps they name:
- Interface version strings (s57) are written but not enforced yet.
- s68: `git/git-push-worktrees.mjs` line 247 runs `scripts/schema-snapshot.mjs` in the repo, which only alfred-v5 has.
- The Overwatch outbox check (a repo posts only where the sender is at its root, and the config can only switch it off) must stay as safe in any later change.
- A broken `claims-core` stops the guard everywhere with a misleading message. Give that case its own message later.
- Change an import and its use in one edit, so the guard never runs a half-changed file.
- s64: the Salesforce guard runs in every folder, known repo or not.
- The new repo's `.claude/settings.local.json` is machine-local.
- The seed's path map missed `scripts/inventory.mjs`; it stays in alfred-v5, using the shims for `claims-core`, `finish-summary` and `overwatch-post`.

**s62, `sb project`, `sb org`, protection** (estimated run: 15m). Spec §5.4 and §5.5.
- create: sb/ and tests
- update: hooks/claims-guard.mjs

**s63, `sb client start` and `end`** (estimated run: 15m). With `--adopt <path>` for an existing repo; `.git/info/exclude`.
- update: sb/

**s64, Salesforce guard** (estimated run: 15m). Spec §9.6, including the block on Salesforce MCP tools and refusing a repo whose `.mcp.json` names an org.
- create: salesforce/guard.mjs and its test, salesforce/RULES.md
- update: hooks/, claims/shell-parse.mjs

Also in s64, since it rewrites the shell parser's rules: fix the s51 guard false positive. A command starting with `cd` is judged whole, so an `rm` of a temp file flagged scripts the command only ran (`writeCheck` in `scripts/lib/claims-core.mjs`, the `afterCd` fallback). And its second form (s56): a command that writes anywhere has every repo path named in it treated as written, even with no `cd`. A `New-Item` in the scratchpad flagged a test pattern the same command only ran.

**s65, deploy wrapper: files, lock, tests** (estimated run: 15m). Spec §9.7.
- create: salesforce/deploy.mjs and its test

**s66, wrapper: compare and tiers** (estimated run: 15m). The click tier is refused until s94.
- update: salesforce/deploy.mjs and its test

**s67, PII hold** (estimated run: 8m). Spec §9.8.
- update: clip/, tests

**s68, finish modes, non-Alfred repos** (estimated run: 12m). `pr`, `local-commit`, and the migration and snapshot checks off where the repo has none.
- update: git/, tests

**s69, panel across repos** (estimated run: 15m). Paths from `projects.json`, so Send and the tiles reach client windows; the host list moves to `config\`. Prompts to the new repo stop being pasted by hand here (the s48 plan's s65).
- update: panel/, the bridge host, tests

**s70, FIRST CLIENT GATE** (estimated run: 10m, then Alex's setup). Alex runs `sb client start`; the Phase 3 checklist is tested on a Team IMPACT sandbox. Client work can start here.
- update: fixes only, named at the time

**s71, extension split** (estimated run: 12m). Switchboard's own Chrome extension with a fixed ID; the host manifest re-registered; the clipper stays in alfred-v5.
- update: extension/, install.ps1 (new repo); extension/ (alfred-v5, bridge half deleted)

**The cutover, s76 to s79** (from the s75b plan, renumbered). `.claude/settings.local.json` is tracked and identical in every checkout: one edit, spread by checkpoint and gitsync. The user-level hooks stand back while a checkout's settings name any Switchboard hook, so the hook entries are removed in one write. `scripts/lib/claims-core.mjs`, `finish-summary.mjs` and `overwatch-post.mjs` stay, because `sql-queue` and `inventory` import them. The cli-workflow skill is cli_rules-v8m's (yielded at s75b); it carries the four rule changes and the `claims.cmd` and `clip.cmd` renames.

**s76, Overwatch without the repo's sender (switchboard window)**. Done: `repos.json` `overwatch: true` posts through the installed sender, and alfred-v5 has it on.

**s77, CLAUDE.md names the installed commands (alfred-v5 window)** (estimated run: 12m). `claims.cmd`, `clip.cmd`, the Switchboard install for the hooks; no shims wording.
- update: .claude/CLAUDE.md

**s78, settings handover (alfred-v5 window)** (estimated run: 5m). One write of `.claude/settings.local.json`, and the step's only change: every hook and sound entry removed, the seven claims permissions switched to `claims.cmd`, the `tools/claude-sessions/run-tests.ps1` permission dropped. Then Alex checkpoints it and runs gitsync in each worktree between turns; in each checkout the user-level guard writes `.clip/claims-guard.log`.
- update: .claude/settings.local.json

**s79, delete the shims and dead folders (alfred-v5 window)** (estimated run: 8m). Only after every checkout has s78. Then `gitpush switchboard2-h8r finish`.
- update: .gitignore, supabase/config.toml, scripts/inventory.mjs (comments only)
- delete: scripts/claims.mjs, scripts/clip.mjs, scripts/git-commit-claimed.mjs, scripts/git-new-worktree.mjs, scripts/git-push-worktrees.mjs, scripts/git-sync.mjs, scripts/overwatch-post.mjs, scripts/lib/session-status.mjs, scripts/powershell-profile-snippet.ps1, .claude/hooks/, tools/claude-sessions/, tools/switchboard-seed/, extension/

Outside the repo, for Alex: the `~/.claude/settings.json` autoMode line that names `node scripts/claims.mjs yield`; on the Surface, install.ps1 before it pulls s78.

### Part 3, every git command by link

The helper arrives here rather than with Phase 4. Every git link needs a click for the first two weeks (spec §11.1).

**s80, queue changes** (database step; estimated run: 10m). `git` is already an allowed kind. Adds `needs_click` by action type and a pickup function. Done (s80b, s80c): migrations 206 and 207.
- create: supabase/migrations/_pending_switchboard2-h8r_git_actions.sql, supabase/tests/switchboard2-h8r/6_verify_git.sql
- SQL: switchboard_actions, switchboard_runs

**s81, runner: git actions and pickup key** (estimated run: 12m). The runner must mark every picked run, and its action, `succeeded` or `failed`: `switchboard_pickup_git` hands out one git action at a time per project, so a picked action left `consumed` stalls that project's queue. Done (s81-c9wt): `/result` closes it; a pick older than 30 minutes is failed at the next `/pickup`.

  For s82: the helper reads the key from `%LOCALAPPDATA%\Switchboard\config\pickup.key` (one line, outside every repo; protected like the rest of config), posts `/pickup` with header `x-switchboard-pickup-key`, and always posts `/result` with `ok`, a one-line `summary` and the `exit_code`, even when the command fails or is refused. A run longer than 30 minutes would be failed under it, so the helper should refuse anything it can't finish in that time.
- update: supabase/functions/switchboard-runner/index.ts, supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs
- deploy: switchboard-runner

**s82, helper and allowlist** (estimated run: 15m). Spec §11.2; a visible terminal; git commands refuse rather than ask when run by link.
- create: helper/ and tests
- update: git/

**s83, s83b: docs/ tidy** (done; see the table). This took the s83 number, so the MCP tool is now s84 and the approve page s84b.

**s84, MCP tool to queue a git action** (estimated run: 8m). Needs `mcp/index.ts`, held by notification_routing-d7v. It inserts a `kind: git` switchboard_actions row and returns the link for Alex's click. The payload is the one the s82 helper accepts; it refuses any other key:
  - always: `command` (gitcom, gitsync, gitnewtree, gitpush)
  - gitcom: `message`, `include_unclaimed` (all or none)
  - gitnewtree: `install` (true or false)
  - gitpush: `mode` (push, checkpoint, finish); `finish` (phase or project-done, required for a Finish); `paths` or `all` (checkpoint); `db` (release or keep); `message`; `include_unclaimed` (main only)
- update: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs, docs/technical-spec-switchboard2-h8r.md (§11)
- deploy: mcp

  s84 found (s84-m6qr): authenticated can't insert into switchboard_actions, so the tool calls `switchboard_queue_git`, which needs its own database step (**s84c**, below). The tool is written and tested against fakes; registration and the deploy wait for mcp/index.ts.

**s84c, `switchboard_queue_git`** (database step; estimated run: 10m). A SECURITY DEFINER function, granted to authenticated only: it inserts a `kind: git` row for `auth.uid()` (`created_by: 'claude'`) and returns `{action_id}`. Then register the tool in mcp/index.ts, deploy mcp, and check that a bad payload is refused.
- create: supabase/migrations/_pending_switchboard2-h8r_queue_git.sql, supabase/tests/switchboard2-h8r/7_verify_queue_git.sql
- update: supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- deploy: mcp
- SQL: switchboard_actions
- db items: `db:table:switchboard_actions`, `db:fn:switchboard_queue_git`, `db:deploy`

  s84c's database half is done (s84c-t9vk): migration 208 and the test are queued. The registration and deploy move to s84d.

**s84d, register `queue_switchboard_git` and deploy mcp** (estimated run: 8m). Waits for notification_routing-d7v to release mcp/index.ts and index.test.mjs, and for 208 to be live.
- update: supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- deploy: mcp
- db items: `db:deploy`
- check: a call with a bad payload is refused

  Done in s84k.

**s84t, the mcp half of s84s** (estimated run: 8m). Waits for notification_routing-d7v to release mcp/index.ts and index.test.mjs. switchboard.ts already has the code (s84s).
- update: supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- deploy: mcp
- db items: `db:deploy`
- get_switchboard_run:
  - add `project_code: z.string().optional()`;
  - "Pass exactly one of action_id, run_id or project_code"; project_code gives that code's latest action, of any kind, and its latest run;
  - append: "For kind git, status succeeded means the command ran and exited 0: completed, even if it changed nothing. Failed means a non-zero exit or a helper refusal. The run summary ends with the command's own Result: line."
- queue_switchboard_git:
  - replace the description's return sentence with: "Returns { action_id, url, expires_at, headline, payload, next }. Give Alex the url whole. Once he approves, the result line (git <action id> done or failed) arrives in this chat by itself when the command finishes, and nothing is posted at approval; he can also say \"check the git run\".";
  - chat_url: "Optional; don't guess it, the extension remembers the chat. Only a https://claude.ai/chat/<uuid> address is used."
- test: index.test.mjs checks that get_switchboard_run's schema has project_code and that queue_switchboard_git's description doesn't say "send git".
- check, live, in a new thread: get_switchboard_run with project_code switchboard2-h8r returns its latest action; with "Bad Code" it is refused.

**s84b, approve page and `git <id>` post** (estimated run: 10m). "Git ready" and "Git running" already exist from s54.
- update: src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, extension/, panel/

**s85, skill, CLAUDE.md, live test of all four** (estimated run: 8m).
- update: .claude/CLAUDE.md, .claude/skills/cli-workflow/SKILL.md

**s86, sandbox sf checks and `sb` setup answers by link.** Designed in s86a: spec §11.4-11.7. Read-only checks on a sandbox run without a click; `sb client start` and `sb org add` answers go by link; production stays in Alex's terminal. Decided at s86b: D1-D3 are A, so every part below stays (spec §11.7). Run in this order.

**s86ba, number and queue the migration** (renamed from s86b2: the Send extension still misreads a digit after a letter in a step name; database step; window switchboard2-h8r; estimated run: 6m). After Alex's gitsync, and after the rolled-back test passes. Done in s86ba-m3jt: see the table.
- Take the next free number, write it, and delete the `_pending_` file.
- Queue the migration. After it's approved, queue `8_verify_helper_kinds.sql` with --test, and run check_platform_conformance.
- create: supabase/migrations/<NNN>_switchboard_helper_kinds.sql. Declare the exact number in the prompt.
- delete: supabase/migrations/_pending_switchboard2-h8r_helper_kinds.sql
- SQL: switchboard_actions, switchboard_runs
- db items: the s86b list, plus `db:deploy`

**s86b, helper kinds** (database step; window switchboard2-h8r; estimated run: 12m). Spec §11.6. Written as `_pending_`, then numbered in s86b2 after gitsync. Live test: the test script with --test.
- create: supabase/migrations/_pending_switchboard2-h8r_helper_kinds.sql, supabase/tests/switchboard2-h8r/8_verify_helper_kinds.sql
- SQL: switchboard_actions, switchboard_runs
- db items: `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_needs_click`, `db:fn:switchboard_queue_helper`, `db:fn:switchboard_queue_git`, `db:fn:switchboard_pickup_helper`, `db:deploy`

**s86c, runner: helper kinds** (window switchboard2-h8r; estimated run: 10m).
- /pickup calls `switchboard_pickup_helper` and returns `kind`.
- /preview, /approve and /cancel treat `sb_setup` as they treat git.
- An `sf_check` has no link. Live check: a bad token gets 401 or 404.
- update: supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs, supabase/functions/switchboard-runner/index.ts
- deploy: switchboard-runner
- db items: `db:deploy`

**s86e, helper, sb and extension** (window switchboard_repo-k7m; estimated run: 20m).
- The helper posts `{"kinds": ["git", "sf_check", "sb_setup"]}` to /pickup (all three, or none: the runner refuses a part), and switches on the pick's `kind`.
- planAction for `sf_check`: the six templates, `checkOrg` fresh, production refused, the kept fields only. And for `sb_setup`: the limits, then `sb ... --by-link`.
- `sb` gains `--aliases`, `--sandboxes`, `--integration-ok`, `--name` and `--by-link`.
- The extension posts `sf <id> done|failed` and `sb <id> done|failed|cancelled`.
- Reinstall Switchboard and reload the extension in one step, with an Expected line naming the version.
- update: helper/lib/core.mjs, helper/lib/core.test.mjs, helper/helper.mjs, sb/lib/client.mjs, sb/lib/client.test.mjs, sb/lib/org.mjs, sb/lib/store.mjs, sb/lib/sb.test.mjs, extension/lib/bridge-core.js, extension/lib/bridge-core.test.mjs, extension/claude-watch.js, README.md

**s86d, tools and approve page** (window switchboard2-h8r; estimated run: 15m). After s86e, so the helper understands what the tools queue.
- Two new tools: `queue_switchboard_sf_check` (no link; returns the action id and says the result line arrives by itself) and `queue_switchboard_sb_setup` (a link).
- The approve page shows `sb_setup` in plain words.
- Live check: a bad payload is refused for each tool.
- update: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs, src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, docs/technical-spec-switchboard2-h8r.md
- deploy: mcp
- db items: `db:deploy`

**s86kb, the mcp half of s86k and the migration** (database step; estimated run: 12m). Once notification_routing-d7v has released mcp/index.ts and its test, and after gitsync: queue_switchboard_git advertises `repo` for gitnewtree; number the migration with `claims number-migration`, queue it and 11_verify; deploy mcp after it's live.
- create: supabase/migrations/<number from claims number-migration>_switchboard_gitnewtree_repo.sql
- update: supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- delete: supabase/migrations/_pending_switchboard2-h8r_gitnewtree_repo.sql
- deploy: mcp
- SQL: switchboard_actions

**s86f, live test** (claude.ai only, no code; about 10m of Alex's time).
- `org-verify` and `limits` on D4's sandbox.
- A check on an alias not listed for the repo is refused before sf runs.
- If D4 says so, `sb org add` by link for a second sandbox.

**s87, panel snapshot in Supabase** (database step; estimated run: 12m). After git by link: the panel writes a snapshot of its tiles to Supabase, and an Alfred tool reads it.
- create: supabase/migrations/_pending_switchboard2-h8r_panel_snapshot.sql, supabase/tests/switchboard2-h8r/10_verify_panel_snapshot.sql
- update: panel/, supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts
- deploy: mcp

### Part 4, Salesforce reads

**s88, schema and purge** (database step; estimated run: 10m). Encrypted result storage, `sf_reads_enabled`, a 10-minute purge.
- create: supabase/migrations/_pending_switchboard2-h8r_sf_reads.sql, supabase/tests/switchboard2-h8r/6_verify_sf_reads.sql
- SQL: switchboard_actions, switchboard_runs, switchboard_settings

**s89, helper reads** (estimated run: 15m). GET only, the org check, level checks, `soql-parser-js`.
- create: salesforce/helper/ and tests

**s90, runner: results** (estimated run: 10m).
- update: supabase/functions/switchboard-runner/index.ts, supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs
- deploy: switchboard-runner

**s91, `sf_read` tool** (estimated run: 8m).
- update: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs
- deploy: mcp

**s92, live on the client sandbox** (estimated run: 6m). Results checked by Alex, not pasted.
- update: fixes only

### Part 5, Salesforce actions by link

**s93, `sf_deploy` and `sf_test` actions** (estimated run: 12m). A migration if the allowlist needs one; helper; runner.
- update: helper/, supabase/functions/switchboard-runner/index.ts, supabase/functions/switchboard-runner/core.ts, supabase/functions/switchboard-runner/core.test.mjs
- deploy: switchboard-runner

**s94, click tier in the wrapper** (estimated run: 10m). Lifts s66's refusal.
- update: salesforce/deploy.mjs and its test

**s95, approve page warnings and skill** (estimated run: 8m).
- update: src/switchboard/ApprovePage.jsx, src/switchboard/ApprovePage.test.jsx, .claude/skills/cli-workflow/SKILL.md

**s96, live test** (estimated run: 6m). No-click and click deploys on a sandbox; production refused.
- update: fixes only

### Database items (s50 onward)

Each is claimed at its step, never before, and released by Checkpoint.

| Step | Items |
|---|---|
| s52 | `db:fn:switchboard_issue_link`, `db:table:switchboard_actions`, `db:deploy` |
| s80 | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_issue_link` |
| s81 | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:deploy` |
| s84 | `db:table:switchboard_actions`, `db:deploy` |
| s86b | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:fn:switchboard_needs_click`, `db:fn:switchboard_queue_helper`, `db:fn:switchboard_queue_git`, `db:fn:switchboard_pickup_helper`, `db:deploy` |
| s86c, s86d | `db:deploy` |
| s87 | the snapshot table (named at s87), `db:deploy` |
| s88 | `db:table:switchboard_actions`, `db:table:switchboard_runs`, `db:table:switchboard_settings` |
| s90, s91 | `db:table:switchboard_runs`, `db:deploy` |
| s93 | `db:table:switchboard_actions`, `db:deploy` |

`switchboard-panel` needs no deploy in Part 1: the chat decides tan, so its `waiting_on_alex` just goes unread. It is removed the next time that function is deployed.

### First client: Team IMPACT (from s48)

It already has a repo, a remote and an alias, and the spec says it allows an integration user. ActBlue needs a folder per nonprofit.

**Until s70, don't open Claude in `C:\Users\Alex\projects\team-impact`.** Its committed `.mcp.json` gives any session there the Salesforce MCP server on `team-impact-prod`, with the `data` and `users` toolsets, and that org was connected at s48.

Alex by hand:
1. `sf org logout --target-org team-impact-prod` (recommended at s48; not confirmed done).
2. Sort out the 17 uncommitted files on `feature/heat-map-proximity` before s70.
3. Remove or empty the committed `.mcp.json`, and correct its CLAUDE.md deploy line.
4. Install `gh`: it is not on this machine, and the `pr` finish needs it.
5. Log `team-impact-sandbox` back in; its token had expired.
6. Create the private GitHub repo, run the seed, and run `install.ps1` at s58 and s60.
7. At s61, replace the PowerShell profile functions: they outrank PATH, and the file syncs to the Surface through OneDrive.

Alex gives at s70: whether `github.com/alexanderjameswarren/teamimpact` is the client's real source and which branch is main; whether `TeamImpactHeatMap` is still needed; sandbox aliases, the type of each and whether they're shared; whether production is allowed and at what level; integration user or admin login per org; whether the contract allows client data to reach Claude; whether the CLI may deploy, per sandbox.

## Estimate

| # | phase | steps |
|---|---|---|
| 0 | Fixes, boundaries, plan guard | 8 |
| 1 | Send link, fallback page, skill rule, tile states, estimates, layout | 10 |
| 2 | SQL queue, read-only queries (2.2-2.12, 2.3b, 2.4b, 2.7c to 2.7g, 2.9b and 2.9c, after the 2.1 plan) | 20 |
| — | Plans, s48 and s49 | 2 |
| — | Tile fixes (s50-s55) | 6 |
| 3 | The move (s56-s79) | 24 |
| 5 | Git by link (s80-s87) | 8 |
| 4 | Salesforce reads (s88-s92) | 5 |
| 5 | Salesforce actions by link (s93-s96) | 4 |
| 6 | Spec files, archiving | 2 |
| 7 | npm start per tile | 2 |
| 8 | Remote devices | 4 |
| | **total** | **95** |

Run time from s49 to s96, by the estimates in the blocks:

| part | steps | run time |
|---|---|---|
| s49 | 1 | 4m (the plan's figure) |
| Tile fixes | 6 | 51m |
| The move | 24 | 3h19m planned for s56-s72; s73-s79 not re-estimated |
| Git by link | 8 | 1h27m |
| Salesforce reads | 5 | 49m |
| Salesforce actions | 4 | 36m |
| **total** | **48** | **7h06m planned, plus the move's added steps** |

s48 planned 35 steps and about 6h09m. Part 1 grew from 2 steps and 18m to 6 steps and 51m, so everything after it moved up by 4. At s77 the plan was renumbered: the move ran to s79 (sub-steps in the switchboard repo, the cutover s76-s79), and git by link starts at s80 with two new steps (s86, s87). The first client gate passed on 2026-11-04.

## Decisions

- **s49, on the s48 plan (Alex):**
  - **Accepted as recommended:** a plain copy for the history; docs back in `docs/`; `switchboard_repo-k7m` as the new repo's code, with prompts pasted by hand until the panel reads several repos (s69, which s48 called s65); the seed by script, as an approved exception; `sql-queue` stays in alfred-v5.
  - **Git clicks:** every git link needs a click for the first two weeks. After that gitcom and gitsync may run without a click only when claude.ai issues them. The CLI never runs them.
  - **A, tan:** the chat alone decides. The database may only turn tan off for an expired link, never delay it. *Built with no database read at all:* the server writes the expiry into the link, so the chat knows it. The cost, accepted in spec §7.2: a link used from another device stays tan until it expires.
  - **B, approval links behave like Send links,** for SQL, git and deploy alike: tan "SQL ready", "Git ready" or "Deploy ready"; Sending then Sent in the chat; light green "SQL running" and so on; the usual "Claude writing" when the result is posted; red when the page can't post. This replaces s48's "Waiting on you".
  - **C, one live link per project code,** not per account. Spec rule 1 stays: one link at a time per thread.
  - **D, a claims check records no block;** only a refused claim does. At s49 the blocks file was already empty, because the block goes once the holder lets go of the file. s50 removes the cause and drops any `via: "check"` record left over.
  - **E, a saved chat link whose tab is gone** gives way to the open chat that issued the project's newest run tag.
- **s48, found while planning:** the plan guard ignores paths outside its own repo, so new-repo work is done only from a window on that repo. Team IMPACT's committed `.mcp.json` reaches production through MCP, which a shell-only guard can't see; spec §9.6 now covers it.

- **s28, on the runner (Alex approved):** one run at a time with several queued; a script's outer begin and commit dropped, other transaction control refused; one command per send; `/preview`; an index on a table the same script creates is not slow; run routes open to any origin, with access by JWT. Smoke-test action 26f0cc8f-6ef0-4f14-81da-a915ad086e5b (`select 1`) stays queued; nothing runs it without a link. `scripts/sql-queue.mjs` uses `process.exitCode`, because `process.exit` straight after an HTTPS fetch exits 127 on Windows; a plain-HTTP test does not reproduce that, so it was checked by hand over HTTPS.
- **s27, the `.clip` gap closed:** `foreignPath` no longer exempts `.clip/` in another checkout, so the claims guard refuses main's. A sibling worktree's was already refused there, because its path is not exempt from main's root. The plan guard now uses `foreignPath` for edits and shell writes and refuses "writes into another checkout". `.git/` and the other exempt folders in main stay as they were. Other threads get this once they sync.
- **s26b, on the 2.3 schema (Alex approved):** read-only grants on `switchboard_actions` and `switchboard_runs`; a trigger that fixes payload, fingerprint, kind and headline; no audit on `switchboard_runs`, so results do not outlive the prune; `link_hash` a secret column. The numbered file is `189_switchboard_queue.sql`, the name in Alex's scope, not the `189_queue.sql` that `number-migration` suggested. Decided in s32b: nothing writes `chat_url`; the column stays, empty and unused, since this step has no SQL.
- **s25, on the Phase 2 plan (Alex):**
  - **Row-level security:** Claude's read-only queries run through a guarded function that runs as `claude_reader` and answers only for Alex's user. Step 2.10 starts with a small test of this before the real work.
  - **Secret columns, approved:** blocked for `claude_reader` with column-level grants built from `platform_read_settings()`, plus a helper that re-applies them when the list changes. This touches the platform layer, and Alex has approved that.
  - **Tool name:** the read-only query tool is `get_sql_read`.
  - **Also confirmed:** the run id travels on the approve page as a data attribute. Only the runner function executes queued SQL, over `SUPABASE_DB_URL`, and only with a valid JWT and approval link. `switchboard_issue_link` allows one live link at a time.

- **s2, on the step 1 risks:**
  - The tab check binds to the chat address, with the title as a second check.
  - Salesforce full data passes through Supabase: it is encrypted per result, deleted on fetch, and purged on a schedule. Each client's contract must allow it.
  - Org settings live in the install, keyed by repo path. `.clip/` goes in `.git/info/exclude`.
  - Applied migrations are recorded only in `switchboard_runs`.
  - Risks 5 to 13 were accepted as written.
- **s2, new decisions:**
  - Org settings are managed by `sb` terminal commands, and Claude sessions are blocked from them.
  - `sb client end` signs out of the client's orgs and closes its projects.
  - `cliMayDeploy` is per org and on by default.
  - Deploy by link is optional where `cliMayDeploy` is on and required where it is off.
  - Production deploys are never allowed.
- **s3:**
  - **Confirmed from s2:** protect only the installed copy and its config; `sb client start` and `sb client end` are terminal-only; Apex test failures in client repos are summarised, not pasted.
  - **Phase order:** 0, Send to CLI, SQL queue with read-only queries, the move, Salesforce reads, then the rest.
  - **Tile states and colours:** spec §7.2.
  - **Click rules:** spec §11.1, and capital-letter headlines written by the server.
  - **Plan guard:** spec §6.2.
  - **Sandbox deploys:** own files only, a short lock per sandbox, own tests only, retrieve and compare first, and change tiers. See spec §9.7.

- **s4:**
  - **Permission sets:** click-tier when they add a system permission; object and field access only stays no-click.
  - **Triggers and record-triggered flows:** Apex triggers and active record-triggered flows are click-tier in partial and full sandboxes, and no-click in developer sandboxes. The sandbox type is asked of Salesforce.
  - **Accepted as written in the spec:** test files must be declared; CLAUDE.md gets a line on the sandbox lock; click-tier deploys are refused until Phase 5; a gitsync conflict shows as red "Check CLI".
  - **Reports:** every report ends with the next step's scope block, taken from this file.

- **0.1 (s5-m3tx):**
  - **What moved.** `shell-parse.mjs` holds the parsing: write words, redirects, payloads, splitting, words and heredocs. It has no claims or filesystem imports. `writeCheck`, `repoPathsIn` and `pathWord` stay in claims-core because they need the repo, and claims-core re-exports the parser's public names, so no caller changed.
  - **The move changed no behaviour.** The 127 existing tests passed both before and after it.
  - **One root cause for `>` in quotes and `=>`.** Interpreter source (`node -e`, `python -c`) was scanned for shell redirections, so `x > 1` and `a >= b` read as writes to files named `1` and `=`. Interpreter source now has no redirections. A real redirect after the payload still counts.
  - **Heredocs.** In bash, bodies are stripped before scanning (`stripHeredocs`).
    - A body read by an interpreter or shell (`node -`, `bash`, `cat <<EOF | python -`) is judged as a payload.
    - Plain input bodies are ignored, except when they feed a write or `xargs`; then the whole command, body included, is judged as before.
    - Because bodies are stripped, a heredoc no longer forces whole-command mode, and variables from earlier parts are expanded. That closes the claim_blocks-h3n follow-up.
    - PowerShell is unchanged.
  - **One test changed.** In `claims-core.test.mjs`, the old "a heredoc falls back to the whole command" case (`cat <<EOF > /tmp/x` naming `scripts/clip.mjs`) encoded the bug itself. It now asserts no write, and an `xargs rm <<EOF` case replaces it as the whole-command case.
  - **Script writes.** New patterns cover node `fs` (`append`, `copy`, `rename`, `unlink`, `rm`, `mkdir`, `createWriteStream`, the promises forms), python `os`, `shutil` and `pathlib`, and shells started from code (`child_process`, `execSync`, `os.system`, `subprocess`). The `open(...,'w')` rule now needs the mode as its own argument, so `open('app.py')` is no longer a write.
  - **The guard already runs the fixed parser.** Its own file is untouched and it still imports from claims-core, but claims-core now delegates to `shell-parse.mjs`. Only this worktree's guard is affected.
  - **Found, not fixed:** `git apply` or `patch` fed by a heredoc is not caught, before or after this step, because diff paths carry `a/` and `b/` prefixes, which `pathWord` does not strip.

- **0.2 (s6-p5ua):**
  - **Imports.** `claims-guard.mjs` imports `runText` and `writeIndicator` from `shell-parse.mjs` directly; everything else still comes from claims-core.
  - **Diff prefixes.** `pathWord` in claims-core retries a non-existent path without its `a/` or `b/` prefix, and keeps the stripped path when it is a real, non-exempt repo path. So `git apply <<EOF` and `patch <<EOF` now name the files they change. A real folder named `a/` still matches first.
  - **New tests.**
    - The a/b-prefix tests in claims-core (failed before the fix, pass after).
    - Two end-to-end guard tests in hooks.test. One allows the 0.1 false positives: comparisons in `node -e`, and a heredoc to `$TEMP` that mentions rm. The other blocks script writes and the heredoc patch; its patch case failed before the fix.
  - **Spec additions.** §7.4 to §7.7: run estimate, running colours, progress strip, six-tile layout. Phase 1 goes from 5 to 7 steps, and the total from 60 to 62.

- **0.3 (s7-c6hn):**
  - **`claims.mjs number-migration <_pending_ file>`.** Under the claims lock it reads `supabase/migrations/` in main and in every worktree (`git worktree list`) and prints the next number and the numbered file name.
    - **Issued numbers are recorded.** Each one goes into `<git common dir>/alfred-migration-numbers.json`, so a number that has been handed out but not yet written is never given to another thread. The spec said "writes nothing"; this file is in `.git`, not the repo, and without it the race stays open.
    - **Only the thread's own files.** It refuses a file that is not `_pending_<this owner>_…sql`. Owners with underscores work.
    - **Format.** Numbers are padded to 3 digits.
  - **gitpush refuses** a `_pending_` migration that still exists, and a new migration whose number main (as committed or pushed) or another new file in the same push already uses.
    - The check runs in Push and Finish on main, and in Checkpoint and Finish on a worktree, before the plan prints and before anything changes.
    - Edits to files main already has are never refused, so main's old duplicates (122, 150, 153) block nothing.
  - **gitsync** merges with `git merge --no-edit main` (`syncMergeArgs`).
  - **gitpush** ends `Done at YYYY-MM-DD HH:MM:SS` (`doneAt`).
  - **The gitcom echo:** only the echo looked wrong, and the argument list was fine. `gitLive` printed `args.join(" ")`, and commit b3a44fa received all 8 paths. On that 268-character line the missing space falls at column 181, which matches the terminal wrapping at 180 and losing the space at the wrap. `commandEcho` now prints more than two paths after `--` one per line. The fix is in git-flow.mjs, so `git-commit-claimed.mjs` did not need a change.

- **0.4 (s8-v9qe):**
  - **Main and live worktrees.** On main, the prompt hook blocks any tag whose project code is a live worktree, bound or unbound, and binds nothing. "Live" is read from `.git/worktrees/*/gitdir`, with no git call: the worktree's `.git` file must still exist. The message names the worktree and its folder.
  - **Duplicate paste: the hook refuses it, not the panel.** Spec §6.1 said the panel would refuse, but Switchboard never types prompts: Alex pastes them into Claude Code himself.
    - The rule: a tag equal to the run tag this checkout last accepted (`run_tag` in `.clip/session-status.json`) is blocked as "ALREADY PASTED".
    - The status is written as `wrong` with event `duplicate run tag`, and the tile shows red "Already pasted"; a tap clears it, as for Wrong window.
    - `override:` resends on purpose.
    - Only the last tag is compared. Tags from before that one are not remembered.
  - **README.** The spec link and the bridge-spec link both point to `docs/history/`, and the table gains the Wrong window / Already pasted row.
  - **Not fixed, out of scope:** `extension/README.md` line 181 still links `docs/technical-spec-switchboard_bridge.md`, which also lives in `docs/history/` now.

- **0.5 (s9-k7wf):**
  - **`scripts/claims.mjs` yielded** to gmail_capture-h3w, now that it matches main (f6a2512).
  - **Recording.** The prompt hook records each allowed tagged prompt Alex typed in `.clip/scope.json`: the run tag, `found`, the five lists, and `Estimated run`. The library is loaded so that a failure can never change a prompt decision. Untagged replies and machine traffic leave the scope alone. `PLAN_SCOPE_FILE` redirects it; `drive()` in hooks.test always does, so no test can write the real file.
  - **Enforcement.** `.claude/hooks/plan-guard.mjs` is registered beside the claims guard, with the same matcher, and logs to the same `.clip/claims-guard.log` with a `plan` marker.
    - **Edit tools:** a new file must be under create; an existing one under create or update. Folder entries cover everything under them, and the run tag's `docs/progress-<code>.md` is implied.
    - **`.sql` files:** the new text's tables (create, alter, drop, truncate, insert, update…set, delete from, create index on, grant on) must be named under SQL. Comments are ignored, and schema prefixes and quotes are stripped.
    - **Shell:** rm, del, Remove-Item and git rm targets must be under delete. Other shell writes are judged like the Edit tools. Supabase function names, `db push` and `sf project deploy` metadata or source dirs must be under deploy; a bare `supabase functions deploy` counts as "(all functions)".
    - **Outside the guard:** paths outside the repo, and the claims-exempt folders (`.clip/`, `.git/` and so on).
  - **Decision: no scope file at all → allow.** That covers sessions and threads from before this hook, and the window before the first tagged prompt.
  - **No scope block → nothing may change.** As the spec says, a tagged prompt without a block records `found: false`, and every edit, delete and deploy is then refused, except outside the repo and in `.clip/`.
  - **Rollout risk.** If this reaches main before step 0.6 puts scope blocks into every cli-workflow prompt, every thread's next tagged prompt without a block stops all its edits. Either checkpoint it together with 0.6, or set `PLAN_GUARD=off` (the hook honours it and says so).
  - **Widening the scope** means sending a tagged follow-up prompt (for example s9b) with a new block. An untagged reply cannot widen it.
  - **`extension/README.md`:** the bridge-spec link now points to `docs/history/`.
  - **Found live:** Claude Code reloaded the settings mid-session, so this session's tool calls already run through the plan guard. With no scope recorded yet, it allows them.
  - **Live tests (s9b, s9c):** an undeclared README update was refused by the plan guard alone (the claims guard would have allowed it); a declared one was allowed.

- **0.6 (s10-r2jd):**
  - **`clip.mjs --scope` prints the "Scope vs changes" section; clip.mjs does not add it to the report.** CLAUDE.md requires the pushed and printed report to be identical, so the CLI runs `--scope` and pastes the output in. It needs no clipboard settings and pushes nothing.
  - **What it compares.** The scope comes from `.clip/scope.json`. "This run's edits" are the plan guard's `ALLOW … plan <tag>  in scope: <path>` log lines, and git status (`--porcelain -z`, untracked files listed) is added to them.
    - **Changed, not declared:** edited this run, and not covered by create, update or delete.
    - **Declared, not touched:** a create, update or delete entry that no changed path matches.
    - **Uncommitted from earlier steps:** in git status, but neither declared nor edited this run. A worktree carries these until it checkpoints, and listing them as undeclared would be noise.
    - **Gaps:** shell writes are not in the log, so a shell write shows only as "uncommitted from earlier steps". `.clip/` is left out. The log stops growing at 256 KB, after which the edits are missed.
  - **The missing-section warning is a warning, never a refusal.** It applies to file pushes only, not to piped output, so a test log pushed with `|` is not nagged. A next-step heading counts only when `- create:`-style lines follow it.
  - **The logic lives in `last-report.mjs`** (`missingSections`, `scopeVsChanges`, `formatScopeVsChanges`, `touchedFromLog`, `changedFromStatus`). It imports `covers` from plan-scope, so 0.6 depends on 0.5 and the two must reach main together.
  - **Skill 2026-10-29b:** a new section, "Every prompt declares its scope and its estimated run". Every prompt carries the block and the estimate, starting from the last report's next-step block and saying where it differs. Every reply carrying a prompt opens with a plain scope summary, and sending it is Alex's approval. The return leg checks "Scope vs changes". The templates and both examples now carry a block.
  - **CLAUDE.md:** two new sections. "The plan guard" covers widening scope only by a tagged follow-up, never editing `scope.json` or setting `PLAN_GUARD=off`, test files declared, and the two report sections. "Salesforce sandboxes and client repos" covers the sandbox deploy lock and Apex failures summarised. The two report sections do not count toward the 25-line limit.
  - **Spec §7.2:** a new red "Outside scope" tile state, cleared by a tap. Phase 1 stays at 7 steps, because it goes into the tile-states steps (the plan guard writes `wrong` / `outside scope`, as prompt-check does for "Already pasted").
  - **A slip, caught by the guard (0.6):** the first two CLAUDE.md edits used the main checkout's path, and the claims guard refused them. They were redone on this worktree's copy, which was identical. Main's file was not changed.

- **0.7 (s11-n6hb):**
  - **Boundaries were drawn in place; no file moved.** This step's scope allows no deletes and no new files outside `extension/lib/`. Phase 3 does the moves.
  - **Extension: the split already held.** The bridge half (`bridge.js`, `claude-watch.js`, `lib/bridge-core.js`) and the clipper (the rest) import nothing from each other, except `service-worker.js`'s `import "./bridge.js"`. MV3 allows one service worker, so that import stays as the only seam.
    - `extension/lib/boundaries.test.mjs` lists the two halves and fails on any crossing import, or on a `.js` file in neither half.
    - Every file's header names its half, and the README says so.
    - No module was needed under `extension/lib/`.
  - **Switchboard: decisions out of the panel.** The status logic was already pure, in `lib/status.ahk`. Three pieces were still in `claude-sessions.ahk` and moved, with the same output:
    - the button text, now `ButtonLabel(s, name, offset, nowUtc)`; `Label()` is a one-line wrapper;
    - the tile's git counts, now `GitText`;
    - `ChatRowTitle`.

    The panel's header now states the split: windows, timers and file reading in the panel; decisions in `status.ahk`; the bridge in `bridge.ahk`. The file readers (ReadStatus, ReadClaims and the rest) stay in the panel, because a new file there was outside the scope.
  - **Hooks:** each header gains "Owns:" and "Uses:" lines. All five already imported only from `scripts/lib/`. `scripts/lib/session-status.mjs` names its interface and its users.
  - **Stale spec links** in the headers of the bridge files, `service-worker.js`, `bridge.ahk`, the panel and `bridge/host.mjs` now point to `docs/history/`.
  - **`scripts/lib/session-status.test.mjs` was declared but not changed:** no new boundary needed a test there.

- **0.8 (s12-w4tc):**
  - **`tools/claude-sessions/INTERFACES.md`** lists 17 interfaces: 10 on the machine (`.clip/` and `.git/` files), 4 between Chrome, the host and the panel, and 3 to Alfred. Each row gives the direction, the file or endpoint, and its version check.
  - **No version strings exist yet.** Only clip-capture has a check by behaviour: the plain-text fallback, and the flag when the stored run tag differs. Spec §4's version strings are left for Phase 3, before the move.
  - **Full run, all green:**
    - app 3165 passed, 7 skipped, 0 failed (216 suites, 1 skipped);
    - scripts/lib 353/353;
    - extension 18/18 (boundaries 2, bridge-core 15, plan 1);
    - bridge host 11/11;
    - Switchboard test-status and smoke both passed.
  - **Phase 0 complete.** Still open from it:
    - main's old duplicate migration numbers (122, 150, 153), left as they are;
    - the panel's file readers are still in `claude-sessions.ahk` (0.7);
    - the plan guard sees no shell writes in `--scope` (0.6).
  - **The test checklist's Phase 0 line** is met, and is ticked below.

- **1.1 (s13-q2vx):**
  - **The path.** The panel's `command.json` carries `sendprompt` (tab, `project`, optional `tag`). The host forwards it, adding `sentTag`, the last tag sent for that project, from `sent.json`. `bridge.js` asks the tab's watcher for `read-prompt`, without focusing the tab. The watcher returns the last whole prompt in Claude's latest finished message, code blocks first.
    - `checkPrompt` refuses: no prompt; a project code different from the window's; a tag other than the one the panel named; or the tag already sent. Only a passing prompt leaves the extension.
    - The host checks again. The project matches the pending command; the text starts and ends with its `Run tag:` line; it is 64 KB at most; it is not a duplicate; and no `prompt-<project>.json` is still waiting. Then it writes that file and records the tag in `sent.json`.
    - `result.json` carries `did: "prompt"` and the tag, never the text.
  - **"The latest prompt whose tag has not been sent"** is read as the last whole prompt in Claude's latest message. When that one was already sent, nothing is sent; the watcher does not fall back to an older prompt. The skill puts at most one prompt in a reply, so an older one is always stale.
  - **A whole prompt** runs from the `Run tag:` + `Window:` header to the closing `Run tag:` line with the same tag. With no closing line nothing is sent, so a cut-off prompt never goes. It is read only when the chat is finished, as for the issued tag.
  - **Privacy rule changed.** `claude-watch.js` no longer says "no chat text ever leaves the page". The exception is the prompt block, and only on `read-prompt`, which a panel command triggers; its header says so.
  - **One at a time per project** is enforced by the waiting `prompt-<project>.json`. In 1.2 the panel also refuses while the tile is Running.
  - **Duplicate tags are checked three times:** in the extension, in the host, and, as before, by the prompt hook when it is pasted.

- **s14 (re-plan, s14-h5rc):**
  - **Send is a link** at the end of the reply, under the prompt, to `<Alfred base>/send/<run tag>`. The tile still shows "Prompt to paste" but sends nothing. Spec §7.1 is rewritten.
  - **Alfred's address is a setting:** spec §2, rule 8. The host list lives in the panel's settings.ini until Phase 3. Phase 2's approval links use a server-side base address and the same host list.
  - **Kept from 1.1:** the whole-prompt rule, the checks, `prompt-<project>.json`, `sent.json`, and `result.json` without text.
  - **Changes in 1.2:**
    - the extension, not the panel, starts the send (a `prompt` frame); the `sendprompt` command is removed;
    - the prompt is read from the clicked reply;
    - the project comes from the tag, and the panel checks it against a live window.
  - **"The latest prompt" kept:** a link in an older reply is refused unless that reply is the latest one carrying a prompt. Otherwise an old link, never sent, could send a stale prompt.
  - **Phase 1: 7 → 10 steps**, adding the click catch, the fallback page and the skill rule, and splitting the panel paste out on its own. The total goes from 62 to 65.
  - **Spec §7.4 calibration:** `clip.mjs` now prints the Estimate vs actual line for the CLI to paste rather than adding it to the report, matching `--scope`.

- **1.2 (s15-b3nk):**
  - **The host list.** The host reads `[links] hosts=` from the panel's settings.ini, or from `SWITCHBOARD_SETTINGS_DIR`. It is comma-separated, lower-cased, and invalid entries are dropped. The host sends it in `hello`. `bridge.js` keeps the list and sends it to every claude.ai tab; a watcher also asks for it on start. When the host disconnects the list is cleared, so a link is never caught and then dropped. With no list, a link simply opens Alfred's page.
    - **Alex must add the line once:** `[links]` then `hosts=alfredv5vibe.vercel.app` in `%APPDATA%\claude-sessions\settings.ini`. The code holds no default, per rule 8.
  - **The link.** It must be https, its host exactly listed (no subdomains), and its path `/send/<tag>`.
    - `sendTagOf` lives in bridge-core, and claude-watch has a copy because content scripts cannot import. One test checks both against the same cases.
  - **The catch.** Capture-phase `click` and `auxclick` listeners on the document call `preventDefault` and `stopImmediatePropagation` for a listed link only; the middle button is included, other buttons are not.
    - The backup: when a listed `/send/` tab is created or navigated with a claude.ai opener, `bridge.js` closes it and asks the opener's watcher to act on the last link with that tag.
  - **The reply.** `promptForLink` finds the reply that holds the link. It refuses:
    - when the link is outside any reply;
    - when the reply is older than the latest one carrying a prompt;
    - when the reply has no whole prompt;
    - when the prompt's tag differs from the link's;
    - and, in the click handler, while Claude is still writing.
  - **Refusals still reach the host,** as a `prompt` frame with `error` and no text, so the panel can show "Not sent" in 1.3.
  - **New file `prompt-result.json`** replaces 1.1's use of `result.json`. The panel's focus wait reads `result.json` by id, and a Send outcome landing there could have overwritten the reply it was waiting for.
  - **Removed:** the panel-started `sendprompt` command, `read-prompt`, `promptResult`, and the host's pending-command map.

- **1.3 (s16-f7pz), the three layers.** For spec §7.1 step 5; the spec file was outside this step's scope.
  1. **Window.** `PickSendWindow` takes the one VS Code window whose title names the checkout's folder. That is the worktree folder, or main's `alfred-v5`, as a whole ` - `-separated segment (`CodeTitleMatches`). None, or more than one, is refused, and the active window is never a fallback. The checkout is `SessionForProject`: a worktree by its code, or main by its binding.
  2. **Focus.**
     - The panel activates the window and checks that it is in front.
     - It reads the focus through UI Automation (`lib\focus-check.ahk`: `IUIAutomation::GetFocusedElement`, then the element's name, help text, class and automation id).
     - `FocusVerdict` passes only when the name or help text exactly matches, ignoring case, a name saved in `[send] input`. Chromium gives a placeholder as the help text.
     - It refuses at once when the class or name looks like Monaco or xterm (an editor or terminal).
     - If focus is elsewhere, it presses `[send] focusKey` (default `^{Esc}`) once, checks VS Code is still in front, and reads the focus again. Any failure means nothing is pasted, and the tile shows "Not sent: <reason>".
     - **There is no built-in input name.** Until Alex runs `lib\focus-check.ahk` once, which shows what UI Automation sees and saves it on Yes, every Send is refused with "Claude's input is not set up".
  3. **Delivery.** After the paste (clipboard, Ctrl+V, Enter, clipboard restored), the tile waits up to `[send] deliverySeconds` (default 8) for `.clip/session-status.json` `run_tag` to equal the tag. If it doesn't, the tile shows "Not delivered".
  - **The tab-title check was not built.** It was optional, and the three layers do not need it.
  - **Refused while** the CLI is processing, or waiting on an approval.
  - **Every prompt file is taken and deleted,** whether it is delivered or refused, so a refused prompt never goes later by surprise. A refused tag is removed from `sent.json`, so the same link can be clicked again.
  - **Host and extension refusals** in `prompt-result.json` show as "Not sent: <error>". The file present at startup is not shown, nor is an id already shown. A tap clears any Send note.
  - **Found while testing:** the panel's `prompt-*.json` glob also matched `prompt-result.json`, which would have been taken and deleted. It is now skipped.
  - **Live check:** `FocusedElement()` ran on this machine and read Chrome's focused window (class `Chrome_WidgetWin_1`). So the COM calls work; what Claude Code's input reports is still to be seen at calibration.
- **1.3 follow-up (s16c-d9wq), Send link not caught:**
  - **The cause, certain.** AutoHotkey's `IniWrite` writes `settings.ini` as UTF-16 LE with a BOM, and the host read it as UTF-8. So `readLinkHosts()` returned `[]` on the real file, `hello` carried no hosts, and the click catch and the backup had nothing to match. The tests had written UTF-8 files.
    - Fixed by decoding by the BOM. A new host test with a UTF-16 LE file failed before the fix and passes after. The real file now reads `["alfredv5vibe.vercel.app"]`.
  - **Not ruled out:** claude.ai's link markup or click handling could still be a second problem. Only Chrome can show it, so there are now log lines at each stage:
    - `host.log`: `link hosts: …` at start.
    - The service worker console: `[Alfred bridge] link hosts from the host: …`, and `/send/ tab left open: … <why>`.
    - The claude.ai tab's console: `[Alfred watch] link hosts: …`, `Send link not caught: … <why>`, and `Send <tag>: <outcome>`.
  - **Duplicate `clip-full-page` menu:** the top-level call and `onInstalled` both ran `removeAll` before either `create`. Installs now run one after another, and the create callback reads `lastError`. The clipper's behaviour is unchanged.
  - **Rule from now on: bump `extension/manifest.json`'s version whenever extension code changes.** It is now 1.1.0.
  - **Settings in use:** `[send] focusKey=^+!c` (VS Code's "Claude Code: Focus input" bound to Ctrl+Shift+Alt+C, because Ctrl+Esc opens the Start menu). `[send] input=Message input`. Claude's input needs `editor.accessibilitySupport` set to "on"; without it, UI Automation sees only class "View".
  - **Risks:**
    - On Windows, Ctrl+Esc opens the Start menu rather than reaching VS Code (confirmed live, s16c). If it does, the panel refuses ("the focus key took focus out of VS Code"), and `focusKey` can be set to another binding.
    - Chromium builds its accessibility tree only when a UI Automation client asks, so the first read after a VS Code start may see only the window. The answer is to refuse and retry the link. Kept: the whole-prompt rule and the host's checks (tag shape, header and closing lines, 64 KB, duplicate, one waiting). The project now comes from the tag; the panel checks the window in 1.3.
- **1.6 (s19-v6pd, s19c-y2rt), tile states, done:**
  - Order after the reds: Waiting on SQL (tan), Prompt to paste (purple), Report ready (orange), Running (green), Your turn (yellow, flashes; green "Claude writing" while Claude writes).
  - s19c: the slate blue "Talking" from s19 is removed; it lost Your turn's flash, the "Claude is waiting on you" alert. Live test passed for the labels and the Outside scope latch.
  - **Outside scope is a latched field, not the `wrong` state** the spec proposed: the Stop hook rewrites the state to waiting at the end of every turn, so `wrong` would vanish. `session-status.json` `outside_scope` holds the refusal and carries over every write; `clear-wrong` (a tap) clears it and leaves the CLI's state alone.
  - s23: the orange label is "Send cli" again (it says what the tap does); "Report ready" below is that same state.
  - Report ready keeps today's test (the report was pushed after the chat last changed) and only shows while the CLI is idle. True "unread until archived" moved to Phase 2 (see "Database items by step").
  - Waiting on SQL is wired (`sqlWaiting`) but nothing sets it until Phase 2.
  - Not sent was already red until tapped (1.3).
  - Three claims-guard tests fail while this thread holds src/App.js (from 1.4): they expect it unclaimed. They pass once 1.4's claim is released by Finish.
- **1.7 (s20-m7qc), running colours by time left, done:**
  - The estimate comes from `.clip/scope.json` (`estimate`, matched on `run_tag`), which the prompt hook already writes; no test seam needed. Elapsed counts from `prompt_at`, or `since` for an older status file.
  - `RunTint` colours only the drawing (button and tile); `s.color` stays green, so focus, taskbar and alerts are unchanged and the tints never flash.
  - Colours (light / dark): olive `#9E9D24` / `#8A8A1E`, text `#1A1600`; ochre `#B7791F` / `#8C5A12`, text `#1A1600` (5.0:1) / white (5.9:1), about ΔE 30 from yellow and from orange; overrun is ochre plus a 6px inset edge `#C62828` / `#FF8A80`. The old panel uses pastel `B8B850` and `C8924A`, with no edge.
  - **Replaced in s22-g3lm:** ochre was too dark to read and a warm colour said "stop" while Claude worked. Now three greens with `#111111` text: `#43A047` / `#8BC34A` / `#C5E1A5` (dark `#388E3C` / `#7CB342` / `#AED581`); overrun is the short shade plus edge `#C62828` in both themes. No estimate keeps `#2E7D32` with white text. Claude writing (project and chat tiles, and the old panel) is drawn in the short shade. Tint names: `greenlong`, `greenmid`, `greenshort`, `overrun`. Spec §7.5 updated.
- **1.8 (s21-p4hw), estimate on the tile; Estimate vs actual, done:**
  - The running tile's action line reads `Working 0:30 / 7:00` (or `Both working …`) when the run has an estimate; elapsed is then the whole run's, from `prompt_at`, the clock the tint uses. No estimate: elapsed only, as before. The old panel's button label is unchanged.
  - `node scripts/clip.mjs --estimate .clip/last-report.md` prints `Estimate vs actual: 7m00s vs 5m15s (-25%)` from scope.json's estimate and the report's Total row, and writes `{ project, run_tag, estimate, actual }` (seconds) to `.clip/estimates.jsonl`, one line per run tag (a rerun replaces it). It pushes nothing. Run it after the timing table, paste the line in, then push.
  - switchboard.html needed no change: the estimate is part of the action text.
  - Diagnosis (no change): gitpush's console flashes are the detached Overwatch sender's un-hidden children: `resolveRepo`'s git (`scripts/lib/claims-core.mjs:96`) and two PowerShell registry reads (`scripts/lib/overwatch-post.mjs:229`). Fix: `windowsHide: true` on both.
  - Follow-up (s21b-w9hd), done: `windowsHide: true` on all 11 child-process calls in claims-core.mjs (3), overwatch-post.mjs (1; `kickSender` already had it), git-flow.mjs (5) and scripts/inventory.mjs (2). A test in overwatch-post.test.mjs fails on any call in those four files without it. Still unhidden, out of scope: clip.mjs (81, 262, 296), schema-snapshot.mjs (36, 49), git-push-worktrees.mjs (247), git-new-worktree.mjs (126, 336, 358, 373), scripts/lib/inventory.mjs (476). None in .claude/hooks.
- **1.9 (s22-g3lm), progress strip, done:**
  - An 8px strip along a running tile's bottom edge, `StripPercent` 0-100 from elapsed over the estimate, stopping at full; red `#C62828` past the estimate. Colour `rgba(17,17,17,.7)`, visible on all three greens (white was not). Only for CLI or Both working with the run's own estimate; not on writing or paused tiles. Touch page only.
  - `progressstrip` in `[panel]` of settings.ini, default 1. "Progress strip" on the tray menu and the tile's right-click menu toggles it at once (`SetProgressStrip` refreshes). Spec §7.6 updated.
- **1.10 (s23-x5lt), six-tile layout, done; lane order moved to Phase 2:**
  - 3 × 2 grid (`ROWS = 2`), tiles about 288 × 240. Name 39px, action 34px, meta 30px (not 34: block lines would be cut off), strip 10px. A seventh tile is on page two; the down arrow reads "7+".
  - `TileInfoWidth` scales the room by 26/30: 225 / 197 / 185. "1 held · Blocking 1" no longer fits, and a holder's git counts drop beside "s3 · Blocking 1".
  - Fixes: `TimerText` keeps "0:33 / 20:00" together with non-breaking spaces and breaks at the slash past 8 digits; tabular digits on the action line. No estimate draws the short green `#C5E1A5`. Orange is "Send cli" again.
  - Lane order: no lane data in the panel. See "Database items by step (Phase 2)".
  - Follow-up (s23c-p8rl), done: the purple label is "Prompt ready" (was "Prompt to paste"); wording only, in status.ahk, the tests and spec §7.1-7.2. tools/claude-sessions/README.md still said "Paste prompt"; fixed in s23d.
  - Send follow-up (s23d-f2ck), done: focus left in an editor or terminal gets one press of `[send] focusKey` (`^+!c` in Alex's settings), then a fresh UI Automation read; paste only into Claude's input, else "the focus could not be moved to Claude's input: …". `FocusKeyHelps` (no key press when the input is not set up) and `FocusAfterKey` in status.ahk; bridge.ahk uses them. The refusal in live use came from the old keybinding's `editorTextFocus` condition, which made the key do nothing in the terminal. Spec §7.1 step 5.
  - Follow-up (s23b-r6gb), done: one gradual running colour replaces the three bands. `greenrun` blends `#43A047` into `#C5E1A5` (dark `#388E3C` into `#AED581`) by elapsed ÷ (estimate − 60s); `greenshort` from a minute before the estimate; `overrun` past it, also for estimates of a minute or less. `RunBlend` and `BlendHex` in status.ahk; the page uses `color-mix` with the tile's `blend`, and the old panel paints `BlendHex`. The strip has a faint full-width track (`#111111` at 18%). `#8BC34A` and `greenlong`/`greenmid` are gone. Spec §7.5 and §7.6 updated.

## Deferred and parked

- Auto-posting "cli" into the chat: parked as a separate idea.
- `claude_reader` token deny list: drafted at the migration step.
- Read rules for the 11 child tables with no `user_id` (2.10): through the parent row's owner. Until then `get_sql_read` can't read them.
- The faint "Send to CLI" subtitle on the /send fallback page.
- Switchboard repo, open (s80b): `gitpush` Finish should ask whether the project is done or only a phase finished, and move the docs to `docs/history/` only when the project is done. At cb42ff8 it archived this project's docs at the end of Phase 3.

## Test checklist

- [x] Phase 0: each of the 9 fixes has a failing test first, then passes. The plan guard refuses an undeclared create, delete, deploy and SQL table. Both suites green.
- [x] Phase 1: a Send link sends only to its project's window and never to the active one. A duplicate, a stale reply's link, and a send while Running are each refused. On a phone the link opens the Alfred page. Each tile state shows; Your turn flashes; Outside scope stays red until tapped.
- [x] Phase 2: done (s47-x4fu). Evidence and what's left to watch are below.

### Phase 2 checklist

Seen live, with evidence:

- [x] Queue schema (2.3): migration 189, 40 of 40 verify checks; CONFORMANT (97 tables).
- [x] Queue from the CLI (2.4): `/queue` smoke-tested; action 26f0cc8f-6ef0-4f14-81da-a915ad086e5b. A missing `--expect` refused live in s43.
- [x] Claude reads an action and issues a link; a second live link is refused (2.5, 2.6): action 26f0cc8f-6ef0-4f14-81da-a915ad086e5b.
- [x] Approve page, dry run, real run; a link works once (2.6): run b9a740a5-53e3-409f-a503-122ec57e310a; reload said "already been used".
- [x] The result posts to the clicked tab (2.7): action c0c8ead7-da8d-4967-8f79-d284e6a2df5b, run 773effb0-0bc4-414a-bae1-c00ce4e6d81b.
- [x] One-click approve, dry run on open (2.7c, 2.7d): runs eaf76ba0-ae0d-4620-a414-ff46b24f3d68, 3f6609cd-5867-457e-b88b-8147e6f373e7.
- [x] Posting guards: a screenshot in the box stops the post, Try again sends it (2.7e, 2.7f): runs 5596a17d-fdc3-4892-9cc4-8859dd2e813e, d3b5b803-a007-40fa-986c-220f4e501ee0.
- [x] Wrong count disables Approve; Copy details; Don't run posts its reason (2.7g): action d181d1d8-cc08-414b-baab-ceae90316b00, dry run da8de2a9-1f5e-40d0-a801-b1875d81cbe8.
- [x] Test action: one undone run, no Approve (2.7g): action 93e2101d-f8ef-4bc4-8cb9-534870adff97, run e14cf128-13b3-4e41-96bf-843c92446d64.
- [x] Panel endpoint (2.8): no key 401, wrong key 401, POST 405; 25 projects with the key; `report_unread` seen true.
- [x] Tan and lane order on the panel (2.9): run 014ef9a9-c2d1-4fbb-92de-0dbcb7b0a6a7.
- [x] Send link says Sending, Sent or Not sent (2.9b): s40's own link; host.log shows "delivery switchboard2-h8r-s40-n3hy: sent".
- [x] Read role (2.10): migration 192, dry run 2ac65ed1-6e5b-4f63-ba10-047397ba7ccd, real run 6f31c9ae-150c-4ce8-a72e-29ed687411c8; verify run e7814f53-e6c9-4781-91b1-6dedfe566515, 35 of 36, the one failure being net. A real login was refused raising to postgres and reading auth.users.
- [x] `get_sql_read` limits (2.11): one statement, writes refused, 10s timeout, auth and secret column refused, 1000-row cap, log correct.
- [x] Plan guard (2.11): net._http_response, net.http_get, information_schema and query_to_xml refused; switchboard_actions and pg_class allowed.
- [x] Net decision (2.11): revoke test run 7b666e1a-bd11-4b76-8981-1ad775329f43 had no effect; net stays open at source.
- [x] An expired link (s46): the revoke-test link expired overnight and was reissued (action 9a59549f-20a0-4694-85f7-ca1c977146c7).
- [x] Send link look (2.9c): "Sending…" and "Sent ✓" showed as plain text live.
- [x] Main stays upper left (2.9c).
- [x] `supabase/functions/mcp/tables.test.mjs` passes after `gitsync` (s46): 1 pass, 0 fail.
- [x] The kill switch blocks reads (2.11): action A bd90245f-439a-45ca-920c-e7cb38ab4647 (run aad0fe02-4581-4bb5-9d82-12f7a31e1a12) set reads_enabled false; `get_sql_read` was refused with "read-only queries are switched off"; action B 9a16582d-e86c-42c9-9173-b3c18460cb12 (run 75b69631-6321-4945-846a-828d41bcc907) set it back; a read then returned reads_enabled true.
- [x] The skill's flow, live end to end (2.12): action id, review, link, `sql <run id>`, read back.

Accepted by Alex as tested in code, not seen live:

- [x] SQL for the editor is refused at the queue. Runner tests.
- [x] Changed SQL is refused at Approve. Runner tests, and `wrong_fingerprint_refused` in `1_verify_queue.sql`.
- [x] Orange clears on archive, and the orange and red tap rules (2.9). Panel tests only.
- [x] The 21st read in 10 minutes refused (2.11). Unit tests only, by decision.

To watch in normal use, not blocking (2.9c): 7 tiles at 3×3; an action queued during a run goes green, then tan; a Send link's Not sent button.

Carried, not decided:

- [ ] `node --test "scripts/lib/*.test.mjs"`: the 3 known failures ("xargs rm", "copy over an unclaimed file", "leaves no trace"). s45: 374 pass, 3 fail. App suite: 3190 pass, 0 fail.

Dropped: "fails in the wrong tab". `chat_url` left the spec at 2.7, and Alex's login plus the single-use link keep the SQL safe.

Parked: see "Deferred and parked" above.

### Later phases

- [ ] Tile fixes: a queued action shows no tan; SQL ready, Sending, Sent, SQL running and Claude writing in order; red when the page can't post; an expired link isn't tan; a second link in one project refused, one in another project issued; a `check` records no block; a closed chat's tile re-pairs with the new chat.
- [ ] Phase 3: alfred-v5 works through the shims before the cutover. `sf data query` and a production deploy are blocked, and so are Salesforce MCP tools. A deploy holds the sandbox lock and sends only claimed files. A screen-made change is caught by the compare.

## Timing log

| step | total |
|---|---|
| s1 | 2m53s |
| s2 | 2m07s |
| s3 | 2m18s |
| s4 | 0m38s |
| s5 (0.1) | 10m24s |
| s6 (0.2) | 2m20s |
| s7 (0.3) | 7m22s (estimate 12m) |
| s8 (0.4) | 5m10s (estimate 10m) |
| s9 (0.5) | 5m35s (estimate 15m) |
| s10 (0.6) | 5m29s (estimate 15m) |
| s11 (0.7) | 5m31s (estimate 15m) |
| s12 (0.8) | 1m54s (estimate 5m) |
| s13 (1.1) | 3m45s (estimate 8m) |
| s14 (re-plan) | 2m27s (estimate 4m) |
| s15 (1.2) | 5m19s (estimate 6m) |
| s16 (1.3) | 7m37s (estimate 10m) |
| s16c (1.3 fix) | 2m05s (estimate 10m) |
| s17 (1.4) | 1m27s (estimate 4m) |
| s18 (1.5) | 1m28s (estimate 3m) |
| s19 (1.6) | 7m05s (estimate 8m) |
| s19c (1.6 follow-up) | 3m32s (estimate 4m) |
| s20 (1.7) | 5m15s (estimate 5m) |
| s21 (1.8) | 3m40s (estimate 7m) |
| s21b (1.8 follow-up) | 2m28s (estimate 4m) |
| s22 (1.9 + greens) | 6m35s (estimate 7m) |
| s23 (1.10 + fixes) | 6m14s (estimate 10m) |
| s23b (1.10 follow-up) | 3m03s (estimate 5m) |
| s23c (Prompt ready) | 1m00s (estimate 2m) |
| s23d (focus key) | 3m43s (estimate 4m) |
| s24 (2.1 plan) | 2m31s (estimate 6m) |
| s25 (2.2) | 1m35s (estimate 3m) |
| s26 (2.3, stopped at the block) | 4m44s (estimate 12m) |
| s26b (2.3) | 2m14s (estimate 8m) |
| s27 (2.3b) | 1m55s (estimate 5m) |
| s28 (2.4, code) | 5m24s (estimate 15m) |
| s28b (2.4, stopped at the block) | 0m45s (estimate 6m) |
| s28c (2.4, deploy and smoke) | deploy not timed; 1m00s measured after it (estimate 4m) |
| s29 (2.4b) | 0m39s (estimate 4m) |
| s30 (2.5) | 3m15s (estimate 8m) |
| s31 (2.6) | 1m58s (estimate 10m) |
| s32 (2.7) | 3m15s (estimate 12m) |
| s32b (2.7) | 4m05s (estimate 10m) |
| s33 (2.8) | 2m35s (estimate 10m) |
| s33b (2.8) | 1m25s (estimate 5m) |
| s34 (2.7c) | 2m35s (estimate 8m) |
| s35 (2.7d) | 2h02m13s (estimate 15m), of which 1h55m59s was the claim, deploy and queue phase, most likely waiting at a permission prompt |
| s36 (2.7e) | 3m23s (estimate 10m) |
| s37 (2.7f) | 2m00s (estimate 10m) |
| s38 (2.9) | 9m12s (estimate 12m) |
| s39 (2.9b) | 4m08s (estimate 12m) |
| s40 (2.10 spike) | 3m09s (estimate 8m) |
| s40b (2.10 spike, second design) | 58s (estimate 8m) |
| s41 (2.10 part 2, stopped) | 3m17s (estimate 15m) |
| s41b (2.10 part 2) | start not measured; finished 11:53:50 (estimate 5m) |
| s41c (2.10 part 2, test and password) | 1m09s (estimate 5m) |
| s42 (2.11) | 4m41s (estimate 15m) |
| s42b (2.11, plan guard and net test) | 3m13s (estimate 15m) |
| s43 (2.7g) | 11m (estimate 20m) |
| s44 (2.9c) | 6m (estimate 12m) |
| s45 (2.12) | 4m (estimate 10m) |
| s46 (kill switch queued) | 1m (estimate 5m) |
| s47 (Phase 2 done) | 1m (estimate 3m) |
| s48 (Phase 3 plan) | 3m06s to the end of reading; writing not measured (estimate 8m) |
| s49 (docs back, plan written) | 8m55s (estimate 8m) |
| s50 (check records no block) | 1m43s (estimate 6m) |
| s51 (closed chat's link, stopped at the block) | 1m26s (estimate 8m) |
