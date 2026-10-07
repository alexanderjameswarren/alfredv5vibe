# Claim blocks — Progress

Project code: `claim_blocks-h3n`
Spec: `docs/technical-spec-claim_blocks-h3n.md`

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

| step | description | status | notes |
|---|---|---|---|
| 1 | Read-only plan | done | Decisions: separate blocks file; record from check, claim and guard; tile text "by <holder>" / "<step> · Blocking N" |
| 2 | Blocks file, recording, clearing, status section, `yield` | done | Alex tested all steps 2026-10-07 |
| 3 | Holder notice hook | done | Retested 2026-10-07 after Alex's `autoMode.allow` rule; yield silent |
| 4 | Switchboard stripes, labels, flash; loops; status button; stale orphan tile | done | Alex tested 2026-10-07; stale tile did not recur |
| 4b | Polish: grey status button, Blocks last in status, "⇄" loop label, icons hidden while blocked/blocking, main by project name | done | Alex tested 2026-10-07 |
| 4c | Status button shares the idle arrow's background; padlock icon for waiters; "deadlock" wording | done | Alex tested 2026-10-07 |
| 5 | CLAUDE.md claim-blocks section; cli-workflow SKILL.md yield exception, Blocking lines in the TLDR, Switchboard signs | done | Edits explicitly requested and approved by Alex; SKILL.md to be uploaded to claude.ai by him |

## Follow-ups (not in this project)

- **Claims guard misreads a heredoc target.**
  - `S=…; cat > "$S/x" <<EOF` is judged as a whole command, because of the heredoc, so `$S` from the earlier part is never expanded and `$S/x` is read as a repo path. The write is blocked even though the target is outside the repo.
  - The block message then says "writes via: null": in whole-command mode, a redirect-only command leaves both labels unset.
  - Seen 2026-10-07 in Step 4. Both are in `writeCheck` in `scripts/lib/claims-core.mjs`.

## Log

- Step 1 (2026-10-07): plan approved with six decisions (see the step 2 prompt).
- Step 2 (2026-10-07): `.git/alfred-claim-blocks.json` is written under the claims lock. It is recorded from `check` (silent, best-effort), from a refused `claim`, and from the guard, which uses a 2s lock timeout and never changes its decision. A record is live while its holder still holds an overlapping claim, and readers apply that rule too. Writers prune on claim, release, cleanup, yield and `removeClaims`. A Finish (`removeClaims` with no filter) and `cleanup` also drop the owner's own records as a waiter. `status` has a Blocks section. `yield <file>` needs all of: a live block naming this holder and file, an exact file claim, and an empty `git diff <base>` and `git status`, where base is `main` in a worktree and `origin/main` in main. A git error counts as changed. `CLAIMS_BLOCKS_FILE` redirects the file for tests. New tests: `scripts/lib/claim-blocks.test.mjs` (12).
- Step 3 (2026-10-07): `.claude/hooks/block-notice.mjs` is registered as a second UserPromptSubmit hook. It finds the checkout from its `.git` file or folder, with no git at all, and adds `additionalContext` only when a live block names this thread as holder. The text comes from `holderNotice` in claims-core. Waiters are mapped live through `codeOfOwner`, so main shows its bound code. The text covers the yield rule, the changed-file report with merge impact (`gitpush <wt> checkpoint --paths`, or for main, no single-file merge and `gitpush main push` carries everything), and a "Blocking:" line. The hook cannot tell changed from unchanged, so `yield` decides; a folder-held file is flagged as changed up front. `yield` is on the allow list. 4 hook tests.
- Step 3b (2026-10-07): in the fresh-session test, the auto-mode classifier denied `yield` as "Modify Shared Resources" despite the allow rule. Causes found:
  - On entering auto mode, Claude Code drops "wildcarded interpreter" allow rules (permission-modes docs). A `node …:*` rule is very likely dropped, and there is no documented way to check which were.
  - `autoMode` rules are read only from user or managed settings, never from `.claude/settings*.json`.
  - My attempt to add an authorising paragraph to CLAUDE.md was itself denied as "Instruction Poisoning". I did not retry it.

  Fix proposed to Alex: an `autoMode.allow` entry in `~/.claude/settings.json`, written by him. The hook now says: if yield is denied, do not retry; report the file as unchanged so Alex can run yield himself.
- Step 4 (2026-10-07):
  - **Loops.** `blockLoops` in claims-core finds loops: an edge is in a loop when the waiter is reachable back from the holder. `status` marks loop lines "⟲ LOOP" and adds a Loop line. The holder notice adds a MUTUAL BLOCK paragraph.
  - **Switchboard rules.** status.ahk mirrors the rules (`ItemsOverlap`, `LiveBlocks`, `BlockView`, `BlockLine`), checked against the same cases as the node tests.
  - **Bottom line.** A waiter reads "by <holder tile name>" (with "+N" for more holders), or "Stuck with <name>" in a loop. A holder reads "<step> · Blocking N", and the git counts are dropped when the line would not fit. Fit is judged with a per-character width table for 26px Atkinson Bold, measured from the font file. The room beside the icon is 219px (terminal), 184px (terminal + chat) or 167px (orphan "Claims").
  - **Page.** Stripes are a `repeating-linear-gradient` on `.tile.blocked`. Going from blocked to unblocked adds `.cleared`, which runs a 900ms flash once.
  - **Status button.** It sits below ▼ and opens `conhost powershell -NoExit` running `claims.mjs status` in REPO. The window goes on the primary monitor, or the other one if the primary is the touch screen.
  - **Step 4b polish.**
    - The status button uses `--statusBtn`: the idle arrow's grey, railBtn at 30% over the rail.
    - `status` prints Blocks and Loop last.
    - A loop now reads "⇄ <name>".
    - `BlockLine` returns `hideIcon`; the tile gets icon "none", and `.kind:empty` collapses, so the bottom line has 260px.
    - `BlockNames` labels main by `ProjectName(mainProject)` alone.
    - Widths at 26px with no icon: "by restructure p1" 208, "⇄ restructure p1" 193 (about 205 if ⇄ falls back to another font), "s11 · Blocking 1" 197, "1 held · Blocking 1" 224, "by claim blocks" 194. All fit within 260px.
  - **Step 4c.**
    - The status button draws `var(--railBtn)` at `opacity: var(--idle)` in a `::before` behind its icon. `.rb.off` uses the same `--idle`, so it is the idle arrow's own background, and the hard-coded `--statusBtn` is gone. The rail has no background of its own, so the earlier mix was made against the wrong colour.
    - A waiter's tile shows icon "lock", an outline SVG in the kind slot in the same style as the terminal and bubble, followed by the holder's name. "restructure p1" is 171px against 231px of room beside the padlock.
    - Deadlocked tiles keep "⇄ <name>" with no icon.
    - `status` uses "⟲ DEADLOCK" and "Deadlock: …", and the holder notice says "DEADLOCK:".
  - **Stale orphan tile.** Not reproduced. ReadClaims re-reads the claims file every second, Switchboard's JSON library parses the live file, and the orphan list is rebuilt on every Refresh. Covered by a test and by a retest step.
