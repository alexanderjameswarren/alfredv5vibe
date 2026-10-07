# Record links — progress

Pasting `https://alfredv5vibe.vercel.app/<id>` opens that record: its own screen
where one exists, a generic read-only page otherwise, "No record with this ID"
when nothing matches.

## Steps

- [x] 1. Plan (read-only). Run tag record_links-r7k-s1-m4qd.
- [x] 2. Resolver migration `090_record_links_resolve_record.sql` —
      `public.resolve_record(p_id text)` (security invoker) over
      `public.record_lookup_tables()` (security definer). Live and verified
      (s4): conformance clean, 48 lookup tables, both smoke tests matched.
      Checkpointed; db: claims released.
- [x] 3. Front-end route: `record` view in `src/viewPaths.js` (not in
      VIEW_TO_PATH), known to the redirect in `src/Alfred.jsx`,
      `src/records/RecordLinkScreen.jsx` calling the RPC. (s4)
- [x] 4. `src/records/recordRoutes.js` (table-to-screen map),
      `GenericRecordPage.jsx`, not-found inline in RecordLinkScreen, tests. (s4)
      Manual check ids: 5f387912-05b3-45c6-90f3-a162c3d8732e (inbox),
      mm0s2dcabze16uiowwe (items).
- [x] 5. Contract migration `092_record_links_contract_line.sql`: appends the
      record-link line to the LIVE `COMMENT ON SCHEMA platform` (no repo copy
      of that comment exists). Written s6; awaiting Alex's run and check.
- [x] 6. Migrations numbered after gitsync (090 run and checkpointed; 092
      awaiting run), conformance check in the s6 report.
- [x] 7. Full app suite, CLI suite and build green (s6). Next: gitpush Finish.

## Decisions (s2)

1. Text-id tables are included. The resolver covers every registered,
   non-exempt table with an `id` column, uuid or text. Skipped:
   `allowed_emails` (exempt, no id), `sam_song_scores` (no id).
2. The URL accepts two id shapes: a standard UUID, or 16–24 chars of `[0-9a-z]`
   containing at least one digit (`uid()` in `src/utils/flattenElements.js`).
   A test asserts no word path in `viewPaths.js` matches.
3. Contract line, added to `COMMENT ON SCHEMA platform` only: "When you mention
   any Alfred, SAM, Ken, DJ or Warren Buffet record, link it as
   https://alfredv5vibe.vercel.app/<id> using its id, instead of describing
   where to find it." `mcp/index.ts` untouched; Alex adds the same line to the
   claude.ai Project instructions.
4. Routing is a `record` view in `viewPaths.js`, not a new `<Route>`; `App.js`
   and `vercel.json` unchanged.

## Decisions (s3)

5. The second URL id shape is widened to 15–24 chars of `[0-9a-z]` with at
   least one digit: about 1 in 100,000 app-made ids is 15 chars. Steps 3–4
   re-check that no word path matches.
6. The generic record page collapses large fields (long text, jsonb, arrays)
   behind a show toggle.
7. authenticated has no access to the `platform` schema and is not given any.
   `public.record_lookup_tables()` (security definer, table names only) feeds
   `resolve_record`, which stays security invoker. Migration
   `090_record_links_resolve_record.sql`.

## Decisions (s5)

8. A record link never lands on a list. Unarchived inbox → its detail;
   archived inbox → what it became, if loaded; otherwise generic. Every
   state-backed screen (inbox, items, intentions, contexts, collections,
   and the parent cases) is chosen only when its row is in Alfred's state.
   Fix for manual tests 1 and 6: 5f387912… is archived with no successor.

## Notes

- Screen map (step 4): inbox → `/inbox/detail/:id`; intents →
  `/intentions/detail/:id`; executions → `/schedule/execution/:id`; sam_songs →
  `/sam/songs/:id`; items, contexts, item_collections → their detail view via
  state; clips → its inbox item; reminders → its inbox item or intention;
  notification_steps → its execution; collection_items → its collection;
  everything else → generic page.
- Watch restructure_p1 (088): if `inbox.archived` becomes a status column, the
  inbox mapping follows it.
