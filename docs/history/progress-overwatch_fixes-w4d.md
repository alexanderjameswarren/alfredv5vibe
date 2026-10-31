# overwatch_fixes-w4d progress

A small batch of Overwatch fixes. No app code, no database, no deploy.

- [x] **Step 1, plan.** overwatch_fixes-w4d-s1-k8p3.
- [x] **Step 2, build.** overwatch_fixes-w4d-s2-r5n7. Both prompts and the skill at 2026-10-31a.
- [ ] **Step 3, land it.** Alex: gitcom, gitpush Finish; update both scheduled tasks; accept the
      overwatch skill update through `propose_skills`; check the next nightly note.

## Decisions

- **notify-dispatch:** no run row. Stopped only when the oldest scheduled reminder is past due by
  more than the schedule's `grace_hours`. Chain steps checked healthy on 2026-10-31 (8 sent in 7
  days, 0 stuck).
- **Titles:** `task_name` carries the item's title, set in the prompts. Card logic unchanged.
- **Skill follow-ups:** the item carries the repo's `Skill version:` line for chat to compare.

## Next step's scope

```
Scope of this step (step 3, land it):
- create: nothing
- update: docs/progress-overwatch_fixes-w4d.md
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 5m
```
