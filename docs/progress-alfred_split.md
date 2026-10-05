# Progress: alfred_split-v8n

## Status: In Progress

Splitting src/Alfred.jsx into feature folders. Spec:
docs/technical-spec-alfred_split.md.

### Steps
- [x] Step 0: plan (read-only), docs, claims
- [x] Step 1: test helper + guards repointed; pure helpers into src/utils
  (Alfred.jsx 12,052 → 11,575 lines; app 2030/2030, CLI 142/142, same as before)
- [ ] Step 2: new shared pieces into src/shared
- [ ] Step 3: existing flat shared UI into src/shared
- [ ] Step 4: recycle bin
- [ ] Step 5: contexts
- [ ] Step 6: home and schedule
- [ ] Step 7: intentions
- [ ] Step 8: items
- [ ] Step 9: executions
- [ ] Step 10: inbox
- [ ] Step 11: collections
- [ ] Step 12: reminders/settings and shell cleanup
- [ ] Finish: Alex runs gitpush Finish

### Notes
- Known bug, for after the split: ItemCard handleCancel resets elements with
  `{ ...el }` instead of the normaliser used by the useState init and the dirty
  twin. After Cancel, re-entering edit can report unsaved changes with nothing
  typed. Plausible, unverified. Not fixed here (pure move).
- Testing is a desktop click-through in the local dev server.
- Step 1: the plan said 9 guard tests; it is 8 files (two of them hold the two
  readdirSync guards). `alfredSource()` = Alfred.jsx + every file under the
  feature folders, minus the pre-existing flat files listed in NOT_FROM_ALFRED,
  so a guard sees exactly what it saw in Alfred.jsx. A new file in a feature
  folder that did not come from Alfred.jsx must be added to that list.
- Inbox step: RecentlyArchived.test slices between `{/* Inbox View */}` and
  `{/* Inbox Detail View` — keep both markers adjacent in one file, or update
  the slice.
- Step 1 also moved the `./utils/caseConvert` import out of Alfred.jsx: only
  `storage` used it.
