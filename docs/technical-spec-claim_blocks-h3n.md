# Claim blocks — technical spec

Project code: `claim_blocks-h3n`
Progress: `docs/progress-claim_blocks-h3n.md`

Make claim blocks visible. When a thread hits a path another thread holds, record it; show it in
Switchboard; tell the holder at the start of its next turn. How claims are granted or refused does
not change.

## 1. The blocks file

`<git common dir>/alfred-claim-blocks.json`, beside `alfred-claims.json`, written under the same
lock (`alfred-claims.lock`). It is a separate file so a worktree on older code, whose `writeState`
writes only `claims` and `reservations`, cannot erase it.

```json
{ "blocks": [ {
  "waiter": "wtB", "waiter_code": "wtB",
  "item": "src/x.js",
  "holder": "restructure_p1-h4nz", "holder_code": "restructure_p1-h4nz",
  "holder_item": "src/x.js",
  "via": "claim", "run_tag": null,
  "blocked_at": "2026-10-07T07:00:00.000Z", "last_seen": "2026-10-07T07:05:00.000Z"
} ] }
```

- `waiter` and `holder` are claims owners (`main` or a worktree folder name). The `_code` fields are
  project codes: the folder name for a worktree, main's bound code for `main` (or `main` if unbound).
- One record per (waiter, item, holder). A repeat keeps `blocked_at` and moves `last_seen`.
- A missing or unparseable blocks file reads as empty. Losing a block record is harmless; losing a
  claim is not, which is why the claims file itself is still never treated that way.

## 2. Recording

Same record shape from all three places a thread can hit another thread's claim:

| where | `via` | effect on the caller |
|---|---|---|
| `claims.mjs check` with a CONFLICT | `check` | none: same output, same exit code |
| `claims.mjs claim` refused | `claim` | none: still claims nothing, exit 1 |
| claims guard blocking an edit or shell write on a held path | `guard` | none: still blocks; recording is best-effort with a 2s lock timeout |

## 3. Clearing

A record is **live** only while its holder still holds a claim overlapping its `item`. That one rule
covers "the waiter gets the path" (it can only claim once the holder has let go) and "the holder
releases it" (release, `yield`, `cleanup`, gitpush Checkpoint or Finish). Readers apply it on every
read, so a write from older code cannot leave a dead record showing.

Writers also prune dead records whenever they write claims (`claim`, `release`, `cleanup`, `yield`,
`removeClaims`). A finish also drops the finished owner's own records as a waiter:
`removeClaims(ctx, owner)` called without a filter (gitpush Finish), and `cleanup <owner>`.

## 4. `claims.mjs yield <path>`

The narrow exception to "a thread never releases its own file claim". It releases one claim only if all hold:

1. a live block names this thread as holder of exactly that path (`holder_item`);
2. this thread's claim is on exactly that file — not a folder (a folder-held file always takes the changed-file path);
3. the file is unchanged: `git diff --name-only <base> -- <path>` and
   `git status --porcelain --untracked-files=all -- <path>` are both empty. Base is `main` in a
   worktree, `origin/main` in the main checkout (`HEAD` if there is no origin). A git error counts as changed.

On success it releases that claim, prunes the block, and tells the waiting thread to run gitsync
before editing.

## 5. `claims.mjs status`

A "Blocks" section listing live records: waiter code, path, holder code and item, age, via.

## 6. Later steps

- Step 3: `.claude/hooks/block-notice.mjs` (UserPromptSubmit) gives the holder `additionalContext`.
- Step 4: Switchboard. The waiter's tile gets stripes and its bottom line reads "by <holder tile name>".
  The holder's bottom line reads "<step> · Blocking N". The tile flashes once when the block clears.
- Step 5: CLAUDE.md rules, plus a draft for `cli-workflow/SKILL.md`.
