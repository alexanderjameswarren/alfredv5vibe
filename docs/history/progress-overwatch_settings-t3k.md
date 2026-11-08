# Progress: overwatch_settings-t3k

Spec: `docs/technical-spec-overwatch_settings-t3k.md`.

## Steps

- [x] **s1**: read-only plan and sweep of hard-coded limits.
- [ ] **s2 / s2b**: claim the free paths, reserve the db items, write the spec, this file, the `_pending_` migration and the
  test script.
  - Done: the claims, the reservations, the spec, this file and the migration.
  - Blocked: the test script. The plan guard refused it because `item_groups` was not under SQL.
- [x] **s2c**: test script written. gitsync was already up to date, so no drift. The next free number is 219.
- [ ] **s2d**: done:
  - db items claimed;
  - `219_overwatch_nightly_counts_settings.sql` written and the `_pending_` file deleted;
  - migration queued (action 166565c0-02f1-470b-bec8-c190aea0c720);
  - test queued (action e56d3d6e-e4d3-4a5a-85de-7fa0646403e9).

  Waiting on the run results, then Checkpoint.
- [x] **s2d**: 219 live (CONFORMANT, test 16/16) and checkpointed.
- [ ] **s3**: progress so far:
  - the 5 files claimed;
  - `overwatch-nightly.ts` reads the silence threshold from `counts.limits`;
  - tests pass, 16/16.

  **The deploy is blocked**: `switchboard2-h8r` holds `db:deploy`. The mcp deploy is still to do.
- [x] **s4**: done:
  - the nightly and weekly prompts and the overwatch skill read every limit by key;
  - `previous` and `older_than_stale` replace `last_two` and `older_than_one_day`;
  - count 5 is yesterday only;
  - the weekly has `release_watch_days` and `drift_no_run_days`;
  - all three are at 2026-11-08a.
- [x] **s3b / s5b**: mcp deployed (`npx supabase functions deploy mcp --no-verify-jwt`), version 210, `verify_jwt`
  false. The live counts carry `limits`, and silence reads 36 ("default"). `db:deploy` released.
- [ ] **s5**: progress so far:
  - suites pass: functions 1132/1132, scripts 54/54;
  - no app file changed, so the app suite was not needed;
  - `db:deploy` claimed, then released without deploying, because the plan guard blocked the read-only search for the
    deploy command (a false positive).

  The mcp deploy is still to do.

## Next steps' scope (s5 and s3b)

s5, the full test suites and the closing report:
```
Scope of this step:
- create: nothing
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none
Estimated run: 10m
```

s3b, the mcp deploy, run once `db:deploy` is free (before or after s5):
```
Scope of this step:
- create: nothing
- update: nothing
- delete: nothing
- deploy: mcp
- SQL: none
Estimated run: 8m
```

## Timing log

| Step | Phase | Start | End | Duration |
|---|---|---|---|---|
| s1 | reading, claims check, report | 11:04:23 | 11:07:57 | 3m34s |
| s2 | claim attempt (refused) | 11:18:52 | 11:19:05 | 0m13s |
| s2b | claims, reserves, reading | 11:25:44 | 11:26:59 | 1m15s |
| s2b | migration, test (blocked) | 11:26:59 | 11:29:47 | 2m48s |
| s2b | spec, progress, report | 11:29:47 | 11:30:20 | 0m33s |
| s2c | test script, numbering, report | 11:49:12 | 11:50:03 | 0m51s |
| s2d | claims, number, queue | 11:52:05 | 11:55:34 | 3m29s |
| s3 | claims, code, tests, deploy claim (refused) | 12:07:20 | 12:08:17 | 0m57s |
| s4 | nightly prompt | 12:12:10 | 12:13:54 | 1m44s |
| s4 | weekly prompt, skill, checks | 12:13:54 | 12:14:42 | 0m48s |
