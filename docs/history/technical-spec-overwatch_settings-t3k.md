# Overwatch settings (overwatch_settings-t3k): every limit in the plan

Overwatch's plan (`overwatch_plans.settings`, changed only through a new plan version with `create_overwatch_plan`)
already holds most of its limits. This project moves the rest out of the nightly counts code and the task prompts,
so Alex can change any of them with a new plan version instead of a code change.

Background: `docs/history/technical-spec-overwatch-q4n.md` (sections 4.5, 4.6, 6) and
`docs/history/technical-spec-nightly_counts-f8k.md` (the counts call).

## 1. The claim-block rule (count 5)

Before: a pair of codes was flagged at 3 or more distinct `blocked_at` in 30 days, with no `no_parallel` link.

Now:
- **An episode** is a distinct (`waiter_code`, `holder_code`, `blocked_at`). One wait that covers several files (usually
  `supabase/functions/mcp/index.ts` and its test) is one episode.
- **A pair** is least/greatest of the two codes, so both directions add together.
- **The day** is yesterday's Pacific day only: the day before `local_date`.
- **Flagged** when the pair has **more than** `claim_block_max_per_day` episodes that day (default 10).
- A pair with a `no_parallel` link between its Project groups is still left out. No file is excluded:
  `mcp/index.ts` counts.
- Output: `{code_a, code_b, day, episodes, group_a, group_b}`, most episodes first.

## 2. New settings

| Key | Default | Used by | Replaces |
|---|---|---|---|
| `claim_block_max_per_day` | 10 | counts SQL, count 5 | 3 in 30 days |
| `unrouted_stale_hours` | 24 | counts SQL, `unrouted`, `inbox_urgent.unrouted_old` | `interval '1 day'` |
| `inbox_backlog_old_days` | 5 | counts SQL, `inbox_urgent.backlog_old` | `stall_days` |
| `scan_gap_nights` | 3 | counts SQL `prior_runs.previous` (n − 1 runs), nightly Step 6.5 | 3 nights, `last_two` |
| `pull_max_calls_per_app` | 2 | nightly Step 4.2 | 2 |
| `fading_max_items` | 10 | nightly count 6 | 10 |
| `finish_summaries_per_night` | 3 | nightly count 11 | 3 |
| `impact_max_tables` | 5 | nightly count 11b | 5 |
| `impact_max_follow_ups` | 5 | nightly count 11f | 5 |
| `impact_max_profile_rewrites` | 2 | nightly count 11g, Step 8.4 | 2 |
| `nightly_checks.silence_hours` | 36 | `dispatcherChecks` (already read) | default not named |
| `release_watch_days` | 14 | weekly Step 5.1 | 14 days |
| `drift_no_run_days` | 14 | weekly Step 8.2 | 14 days |

Not moved, because each is a technical cap rather than a judgement:
- the row caps on reads;
- the connector's call budget;
- the 24-hour dispatcher look-back and its −5 min/+6 h signal match;
- the factor rounding;
- calendar facts.

The 14-day limit on how long a hold or drop override may last stays in code: it guards the plan, so the plan cannot set it.

## 3. Missing and invalid settings

- **A key with no default** (the original nightly keys except `inventory_stale_days`), when missing, leaves its count
  out and is named bare in `settings_missing`. This is unchanged.
- **A key with a default** (every key in section 2, plus `inventory_stale_days` at 7) is used when it is a positive whole
  number. Otherwise the default is used and the key is named in `settings_missing` as `"<key> (used <n>)"`.
- **`counts.limits`** holds the effective value of every nightly limit: the ten original keys (null when missing and
  without a default) and the eleven nightly keys in section 2. The prompt reads every number from it.
- **The weekly run** reads the plan itself (`get_overwatch_plan`). Its two new keys follow the same rule in the prompt:
  use the stated default and name it in `settings_missing`.

## 4. Compatibility while the prompts catch up

The scheduled tasks run the prompt text that was pasted into them. Between the migration and the pasting of the s4
prompts:
- `prior_runs.last_two` stays (the same runs, cut to two);
- `claim_blocks` keeps `code_a`, `code_b`, `episodes`, `group_a` and `group_b`.

`unrouted[0].older_than_one_day` is renamed `older_than_stale`, with `stale_hours` beside it. The prompt reads the
entry whole. Drop `last_two` once the s4 nightly prompt is pasted.

## 5. Code

- **s2: migration `overwatch_nightly_counts_settings`.** `create or replace` of `public.overwatch_nightly_counts`
  (from 198), with the same grants (authenticated, service_role; nothing to anon). It also rewrites the comment on
  `claim_blocks`, then runs `platform_check_conformance`. Test: `supabase/tests/overwatch_settings-t3k/1_nightly_counts_test.sql`.
- **s3: `overwatch-nightly.ts`.** `dispatcherChecks` takes the silence threshold from `counts.limits` when present, and
  keeps its own default of 36 otherwise.
- **s4: prompts and skill.** The nightly and weekly prompts read the new keys, the count 5 wording changes to "<N>
  blocks on <day>", and PROMPT VERSION and Skill version are bumped.
- **After the checkpoint:** Claude writes the plan version carrying every key in section 2 with its default, and updates
  the scheduled tasks.
