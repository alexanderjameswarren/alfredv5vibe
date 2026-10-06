# Restructure Phase 0 — progress

Spec: https://claude.ai/code/artifact/5aa5a63b-5d22-48a3-8c9a-dc1bc524f908
Worktree / owner: `restructure_p0-k2m`

| # | Fix | Step | Status |
|---|---|---|---|
| 1 | FKs on `context_id` (intents, items, events) | 4 | not started |
| 2 | Capture name/description split | 3 | code done, awaiting mcp deploy |
| 3 | Element text becomes a wrapping textarea | 2 | done, verified on phone |
| 4 | Enrichment context gap — part (a) only; (b) dropped, no backlog | 3 | code done, awaiting mcp deploy |
| 5 | Run Now reuses an existing intention; recurrence successor guard | 2 | done, verified on phone |
| — | Item title field wraps (found in step 2 testing) | 3 | done, awaiting phone test |
| 6 | Migration header audit (report only) | 1 | query sent |

## Step 2 (2026-10-06)

**Fix 5.** `startNowFromItem` now looks for a live intention on the item
(`src/utils/runNow.js` → `runNowTargetForItem`). Precedence: recurring first,
earliest live event among those; else the newest one-off; else a new one-off as
before. If the chosen intention's earliest live event is due today or earlier it
is started (or its running execution opened); otherwise `startNowFromIntention`
runs it. `triggerRecurrence` no longer creates a successor when the intention
already has a later live event (`hasFutureLiveEvent`), ignoring the event just
archived, which the caller's stale `events` still shows as live.

**Fix 3.** Element name in `ItemCard.jsx` and `InboxDetailView.jsx` is a textarea:
two rows minimum, grows with content, Enter still adds a row (now on keydown).
The 30-character overflow-into-description rule and its countdown are gone from
both; existing split rows are left as they are. Newlines typed or pasted are
turned into spaces as you type, so stored element text stays one line.

## Step 3 (2026-10-06)

**Fix 2.** `splitCaptureName` (twins `src/utils/captureName.js` and
`supabase/functions/_shared/captureName.ts`; the test checks the bodies match):
first line, else first sentence (a trailing "." dropped), else the last word
boundary at or before 80 characters. Short single-line text is untouched. Used in
`computeBaseline`, the capture-correction re-seed in `InboxDetailView`, and the
`create_inbox_item` / `update_inbox_item` handlers. The leftover only fills an
empty description; `update_inbox_item` reads the stored row to check. The skill
gained a names rule. Existing long names are not backfilled (out of scope).

**Fix 4a.** `create_inbox_item` saves `not_started` when an item or intention is
suggested without a context.

**Item title.** The name field in `ItemCard` and `InboxDetailView` is a two-row
auto-growing textarea; Enter does nothing, as it did in the old input, and
newlines collapse to spaces. The 50-character overflow rule is still in place.

## Data notes from step 1
- No item had more than one live intention, so the precedence rule is a guard.
- Micro Workout Rotation: original daily intention 2026-09-10; seven `once`
  siblings 09-12 to 10-01, all archived; live one `mur79qma8apmj8yc4i` (daily).
