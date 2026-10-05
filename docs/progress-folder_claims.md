# folder_claims — progress

Make a folder claim cover every file inside it, in both directions, for
`claims.mjs` claim/check and the claims guard. Alfred intention muvfsbevybt3ne86sun.
Main checkout, no worktree. Unblocks alfred_split-v8n.

## 2026-10-05, step 1 (plan, read-only)

All three callers already shared `covers`/`overlaps`/`heldBy` in
`scripts/lib/claims-core.mjs`. Cases a–g passed in a scratch repro. Three
failures were found:

1. A shell write that names the held folder itself (`cp x src/items/`,
   `mkdir src/items`, `tar -C src/items`) was blocked. `toRepoRelative` drops
   the slash, and `src/items` was not covered by `src/items/`. This is the
   switchboard_touch bug.
2. `claim src/items` without a slash was stored as a file claim, which
   covered nothing.
3. From main, a path under `.claude/worktrees/<name>/` overlapped nothing, so
   main could claim and edit inside another thread's worktree.

The guard's "who holds it" message also used its own case-sensitive filter.

## 2026-10-05, step 2 (fix)

- `covers` matches the folder named without its slash.
- New `holds(item, p)` and `holdersOf(state, rel)`. `heldBy`, `holderOf`,
  the guard's message and `claims.mjs` claim all use `holds`.
- `normaliseItem` adds the slash to an existing folder. It refuses a missing,
  extensionless path ("add a trailing slash") and any path under
  `.claude/worktrees/`.
- `heldBy` is never true inside a worktree. The guard blocks edits there with
  its own message.
- Tests: folder-claim units in `claims-core.test.mjs`, and the end-to-end
  `claims-folders.test.mjs` (CLI + guard on a scratch checkout, cases a–g and
  every edge case).
- Results: `node --test "scripts/lib/*.test.mjs"` 142/142 passed; app suite
  2030/2030 passed.

Left for separate bugs: PowerShell `Expand-Archive` is not seen as a write,
and a read-only `git grep` for "claims.mjs claim" is blocked as a chained claim.

Next: Alex runs gitpush Finish for main, then gitsync in alfred_split-v8n.
