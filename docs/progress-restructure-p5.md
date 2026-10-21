# Progress: Alfred restructure Phase 5 — Menus and groups

Project code: restructure_p5-h7m
Spec: docs/technical-spec-restructure-p5.md

## Status: In progress (step 3 done, awaiting verification)

Each step stops for Alex's verification before the next. Database steps follow the just-in-time pattern: gitsync, drift check, claim db items at that step, `_pending_` migration numbered after the sync, Alex runs the SQL, conformance CONFORMANT, Checkpoint releases db claims.

### Development steps

- [x] 1. Plan (read-only): files, db items per step, claims check, answers to the spec's "plan step must confirm" questions
- [x] 2. Confirm and claim
- [x] 3. Housekeeping: move Phase 4 docs to docs/history/; Finish finds docs by their "Project code:" line
- [ ] 4. Undo fix in src/items/useItemActions.js
- [ ] 5. Retire ai-enrich: remove callers and code; delete the deployed function (db:deploy)
- [ ] 6. Database: drop intents.is_item + is_intention comment; conformance
- [ ] 7. Database: group_types (seeded, with icons and execution_mode), contexts.default_group_type_id, item_groups, item_group_members, intents.group_id (+ one live intention per group), events.group_id, executions.group_id (+ intent_id and event_id nullable), notes target 'group', last_completed_at / status triggers (status_guard on item_groups); register_table (policy 'none' + shared-context policy); conformance
- [ ] 8. Data layer: group queries, derived names, realtime
- [ ] 9. Group create/edit page (search-and-add, drag reorder, type picker, pin, archive)
- [ ] 10. Group detail page (header, buttons, members, notes, recent executions)
- [ ] 11. Context page: create button, browse tabs, group rows, sort
- [ ] 12. Group chips on member rows and running cards; record-links order Context > Group > Item > Intention (incl. execution page); pinned groups on Home
- [ ] 13. Scheduling a group through its intention (frozen item_ids on events); Close/Undo for groups
- [ ] 14. Menu execution: Start Now together, per-recipe sections, sticky jump bar, skip a recipe, complete all, Log Execution
- [ ] 15. Projects/series: dated member execution list, teal in-progress marker, last_completed_at roll-up
- [ ] 16. MCP: skip wording, get_groups, group_id on reads, recipe (item) filter on get_execution_history / platform_search_executions; deploy (mcp/index.ts claimed at step 2)
- [ ] 17. Final verification; close Alfred intentions mvhawlfa9s9xlsnv069 and muh9uyjx8wdg02kck5d; update the build-order doc

### Notes

- 2026-10-20 Step 1 plan reported (clip `[restructure_p5-h7m-s1-k8vd]`). Findings folded into the spec on 2026-10-21: executions have `item_ids` (no `item_id`), and `intent_id` and `event_id` are NOT NULL; the date column is `last_completed_at`; items have no pin; there is no `closed_at`; the RecordLinks order is fixed inside the component.
- 2026-10-21 Step 2: Alex accepted corrections 1-8 and the spec is updated. The drag stays as built (native long-press works on the phone; drag is tested there). warren_buffet_p3-q5k released viewPaths.js. 78 files and folders were claimed in one command. No db: items are claimed yet.
- 2026-10-21 Step 3:
  - Moved the Phase 4 spec and progress files to `docs/history/` as Write copies, byte-identical by `cmp`, then deleted the originals.
  - Finish (`planDocsMove` in `scripts/lib/git-flow.mjs`) now moves every `docs/*.md` with a `Project code: <code>` line (bold or backticks allowed; `docs/history/` excluded), plus any doc named after the code. `missing` is reported only when no doc carries the line.
  - Four new tests in `git-flow.test.mjs`. A dry run on this worktree finds both P5 docs. CLI suite passes 239/239.
