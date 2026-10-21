# Technical spec: Alfred restructure Phase 5 — Menus and groups

Project code: restructure_p5-h7m
Progress file: docs/progress-restructure-p5.md
Build-order doc: https://claude.ai/code/artifact/5aa5a63b-5d22-48a3-8c9a-dc1bc524f908

## Overview

Add groups: a permanent grouping that sits above items and intentions. In Recipes a group is a **Menu** (Rice + Beans + Salsa). In Alfred it is a **Project**. In Alex (body, mind, spirit) it is a **Series**. A group has its own status, its own notes, can be pinned to Home, is scheduled through its own intention, and (for menus) is executed in one tap with one execution per recipe.

This phase also carries Phase 4 leftovers: moving the Phase 4 docs, fixing Finish's doc lookup, the stale-list Undo in `src/items/useItemActions.js`, retiring the `ai-enrich` edge function, the skip-wording change in the MCP server, and dropping `intents.is_item`.

## Constraints carried from earlier phases

- **One live event per intention**, enforced by the existing partial unique index. Scheduling a menu must never give one intention two dates. This spec satisfies it by scheduling the menu through the menu's own intention; recipes' own intentions are never touched by menu scheduling or menu execution.
- **One open execution per intention** (existing partial unique index).
- **Closed and archived are separate.** Closed = reached its end, worth keeping. Archived = should not have existed.
- **Colour:** teal = execution running, brown = primary action, amber = paused, red outline = destructive. A button wears the colour of the state it produces.
- **Vocabulary:** the app says "execution", never "run". "Log Execution" records an execution that already happened; "Complete" exists only on the execution page.
- **UI rules:** edit forms are standalone pages; a bordered card is something you tap; cards have no caret; 8px corners; pop-up Cancel is a real button with the X icon beside the main button; Undo reverses everything the tap did, status included.
- **Status never set by hand in the normal flow:** someday → active on first execution and on first scheduling. Nothing returns to someday (except Undo of a close).
- **Every database change is a numbered migration**, written as `_pending_` and numbered at the database step after `gitsync`. Every migration that creates a table calls `platform.register_table()` and the block ends with `check_platform_conformance` = CONFORMANT.
- Platform rules: `COMMENT ON SCHEMA platform` (in `supabase/schema-snapshot.sql`) and `docs/history/technical-spec-platform-layer.md`.
- **MCP tools** follow the mcp-platform skill: `defineTool`, `ctx.db` only, declared tier, bounded reads, bare-data payloads.

## Decisions (settled with Alex 2026-10-19/20)

### Group types

- New table `group_types`: `context_id`, `label_singular`, `label_plural`, `icon` (icon name from the app's existing icon set), standard columns.
- Seeds:
  - Recipes → Menu / Menus, icon: crossed utensils, execution mode `together`
  - Alfred → Project / Projects, icon: kanban board, mode `separately`
  - Alex (body, mind, spirit) → Series / Series, icon: numbered list, mode `separately`
  - Fallback icon for any other type: stacked boxes. (Folder = contexts and layers = collections, so both are avoided.)
- `group_types.execution_mode`: `together` (menu: one tap executes every member) or `separately` (project/series: members are executed on their own intentions; the group has no Start Now).
- `contexts.default_group_type_id` (nullable FK, on delete set null). Seed Recipes → Menu, Alfred → Project, Alex (body, mind, spirit) → Series. "Menu" is the label, not "Meal".

### Groups

`item_groups`:
- `group_type_id` (FK), `context_id` (FK to contexts, on delete set null — set from the type at creation; editable)
- `name` — **nullable. Null means derived**: built at read time from member names in position order, joined with " + ". Typing a name stops derivation; clearing it resumes derivation. The derived name is never stored.
- `description`
- `status` (someday / active / background / closed, same check as items), `status_changed_at` (timestamptz not null; also the closed date, as on items/intentions — there is no `closed_at`), `status_written_at` (server-owned), `closed_reason` (done / wont_do). The `status_guard` trigger is attached as on items and intentions.
- `last_completed_at` (denormalised, written by trigger — see below; same done-only rule as items and intentions)
- `pinned boolean not null default false`, like contexts and collections (items and intentions have no pin)
- `archived`
- standard columns (`user_id`, `created_at`, `updated_at`). Ids are text, as on items/intentions.
- RLS: `platform.register_table('public.item_groups', p_policy_mode => 'none', ...)` plus the owner-or-shared-context policy, as `wb_planned_skips` (migration 140) does. `item_group_members` is scoped to its parent group's policy.
- **No tags** on groups. Search finds a group through its members' names and tags.
- **Groups do not contain groups** in this phase. A meal plan is the week's dated menus.

`item_group_members`:
- `group_id` (FK, on delete cascade), `member_type` (`item` | `intention`), `member_id`, `position` (integer, required)
- Unique on (group_id, member_type, member_id)
- **No database rule tying a member's context to the group's context.** The UI defaults the search to the group's context and lets Alex widen it.
- `member_id` is polymorphic with no FK: reads filter out deleted or archived members.
- Members are added with search-and-add like collections, with the picker generalised to find items AND intentions (`CollectionAddItems` is items-only today). Reorder reuses the collection edit page's existing drag behaviour (native long-press drag works on Alex's phone; desktop Chrome's mobile view may not simulate it, so drag is tested on the real phone). Pulling it into a shared hook is fine; no rewrite, no library.

### Group status

- A group has its **own** status; it is never computed from members.
- Automatic rules match items: someday → active on the first execution and on first scheduling.
- **Closing a group never touches its members.** In a project, members close one by one as the work is done while the project stays active; a recipe sits in several menus.
- Close reuses the existing Close pop-up (Completed / Won't do, notes, Closed on date) and the existing rule that moving to background/closed asks about future events and reminders (here, those of the group's intention).

### Scheduling: the group's intention

- `intents.group_id` (nullable FK to item_groups, on delete set null).
- A group is scheduled through **its own intention**, which carries the one live event. "Rice and Beans Monday" = the Rice and Beans menu's intention with an event on Monday.
- At most one non-archived intention per group (partial unique index on intents.group_id where archived is not true), created on first Schedule / Start Now / Log Execution and reused after (same reuse idea as Run Now).
- For a project the intention date is the target date; the day-by-day work lives on the members' own intentions.
- `events.group_id` (nullable FK). When an event is created on a group's intention, `events.item_ids` (jsonb array of text ids) is **frozen** from the group's current item members, so later menu edits don't rewrite history.
- Accepted side effect: freezing a menu's recipes onto its event flips those recipes someday → active through `status_activate_on_event`. Scheduling a menu is a commitment to cook them. It never pulls a recipe out of background (that trigger moves items someday → active only).

### Executing a menu (`together`)

- Start Now on a menu creates:
  - **one execution on the menu's own intention** (`executions.group_id` set) — the teal running card, holds menu-level notes, completes the menu's event on finish;
  - **one execution per item member**: the recipe in `item_ids` (executions have no `item_id` column), `group_id` set, and `intent_id` and `event_id` both **null**, so recipes' own scheduled events and open-execution rules are untouched. Migration 7 makes both columns nullable (both are NOT NULL today; the open-per-intent unique index tolerates nulls).
  - The menu's own execution keeps `item_ids` empty, so a cook is not counted twice in a recipe's history.
- Intention members of a menu (unusual) are listed but not executed by the menu.
- Confirmed at the plan step: `executions_last_completed()` keys on both `item_ids` and the intention's item, so a recipe execution with `item_ids = [recipe]` and no intention moves that recipe's `last_completed_at`. `status_activate_on_execution` flips it someday → active the same way.
- Execution page for a menu: each recipe is a collapsible section with its elements; a **sticky jump bar** of recipe names across the top (scrolls sideways on mobile) jumps to that section.
- Completing the menu completes every recipe execution at once. Each recipe can be marked skipped (outcome 'skipped', as Phase 4's Skip) before completing. Pause/Continue/Delete act on the whole menu. Undo reverses everything (including status flips and event changes), per the Undo rule.
- **Log Execution** on a menu records the menu execution and one closed execution per recipe in one step, with the Phase 4 "Completed on" date.

### Projects and series (`separately`)

- No Start Now and no Log Execution on the group. Members are worked through their own intentions, exactly as today.
- The group detail page shows **one dated list of all members' executions** (e.g. "Bug A — Mon, Tue · Feature Y — Fri"), reusing the Recent executions layout and "Show all (N older)".
- `last_completed_at` on the group = latest closed, done execution of any member; first member execution flips the group someday → active.
- When any member has a running execution, the group's row/card shows a small teal "in progress" marker (derived at read time; no group-level execution).

### `last_completed_at` trigger

Extends `executions_last_completed()`: on a closed, done execution (and on its delete or reopen, which recompute), if `executions.group_id` is set, recompute that group; also, for any group containing the execution's item (or intention) as a member where the group type is `separately`, recompute that group. Same done-only rule as items and intentions: skips do not count, starting does not count. Same status auto-flip as items.

### Notes

- Groups are a new notes target (`notes.target_type` gains `group`). The group detail page reuses the Phase 2 notes layout.

### Screens

**Context page**
- Create button from the context's default group type ("Create Menu", "Create Project", "Create Series"); contexts with no default show "Add Group".
- Browse tabs on **every** context that has at least one group: All / <type plural> / Items. **No Reference tab** (is_reference stays UI-less). Contexts with no groups show no tabs.
- Sort: status first, then last executed; groups and items interleaved in All.

**Group row in lists** — type icon, name, status chip, context, the "when" line from its intention, then "N recipes · last cooked <date>" (use the type's plural and a neutral "last executed" for non-recipe types), teal in-progress marker for projects with a running member.

**Group detail page** — copies the item/intention detail pages:
- Header: type icon, name, Copy icon, status chip, record links, schedule line from its intention, reminder line as on intentions.
- Buttons in fixed order (overflow to ⋯ only when they don't fit): Start Now (together only), Schedule/Reschedule, Log Execution (together only), Edit, Close, Archive.
- Members in position order as standard rows (tap opens them).
- Notes; then Recent executions (menu: each cook; project: members' dated work).

**Group create/edit page** — standalone page modelled on the collection edit page: name (placeholder shows the derived name), type picker (defaults to the context's default type), context, description, pin to home, members with search-and-add and drag reorder, Archive (red outline) at the bottom with confirm.

**Group chips on members** — item and intention rows/cards get their own line of group chips, shown only when the record belongs to a group; tapping opens the group. Running execution cards on Home and the context page and scheduled lines show the group too.

**Record links order everywhere: Context > Group > Item > Intention.** The order is fixed inside `src/shared/RecordLinks.jsx` (Context > Intention > Item > Execution today), so fixing it there changes every page: the execution page (Context > Intention > Item today), item and intention detail pages, and `NoteSourceLinks` in `NoteTimeline.jsx`.

**Home** — a new Pinned Groups section, alongside Pinned Collections and Pinned Contexts.

### MCP

- Skip-wording change in `supabase/functions/mcp/index.ts` (left over from Phase 4).
- New tier-1 read `get_groups` (filters: context_id, status, limit; returns derived name, type, status, last_completed_at, members in order).
- Group fields (`group_id`) surfaced on existing event/execution reads where cheap.
- Add a recipe (item) filter to `get_execution_history` and `platform_search_executions`, so cooks inside menus (no intention) are found; the tool's "when a recipe was last cooked" wording depends on it.
- Write tools for groups are **not** in this phase (Claude proposes groups through the action inbox in Phase 9).
- `mcp/index.ts` was claimed by `warren_buffet_p3-q5k`. All MCP work sits in one late step and claims the file just in time.

## Leftover work folded in

1. **First commit:** move `docs/technical-spec-restructure-p4.md` and `docs/progress-restructure-p4.md` to `docs/history/`.
2. **Finish doc lookup:** Finish looked only for `docs/technical-spec-<code>.md` and `docs/progress-<code>.md`, so `restructure_p4-v9k` never matched `restructure-p4`. Fix: Finish finds the docs to move by searching `docs/*.md` for a line `Project code: <code>` (both Phase 5 docs carry one at the top). Keep the old name-based match as a fallback.
3. **Undo fix:** `src/items/useItemActions.js` still uses the stale-list Undo pattern Phase 4 fixed elsewhere; apply the same fix.
4. **Retire ai-enrich:** remove every caller, delete the function's code folder, and delete the deployed function (Alex confirms the delete). Close Alfred intention muh9uyjx8wdg02kck5d when done.
5. **Drop `intents.is_item`** after ai-enrich is retired: `alter table public.intents drop column if exists is_item;` plus the `is_intention` comment update; conformance check. The process_inbox_item and archive_inbox_item functions (migration 145) do not reference is_item. Close Alfred intention mvhawlfa9s9xlsnv069 when both this and the skip wording are done.

## Out of scope

Groups inside groups; group write tools in MCP; stars on close; recipe-splitting; meal planning (Phase 11); week groceries (Phase 7); collections holding groups (Phase 6); links (Phase 8); a close-the-open-members question on project close; `is_reference` UI.

## Success criteria

- A menu can be created from Recipes, named automatically, reordered by drag, scheduled for a date, started in one tap, executed with per-recipe sections and a jump bar, completed (with a recipe skipped), and each recipe's last-cooked date moves.
- Scheduling a menu never creates a second live event on any intention (verified by SQL).
- A project's page shows its members' executions by date, and a running member shows the teal marker on the project and the project chip on the running card.
- Browse tabs, group chips, record-link order and pin to Home work in Chrome mobile view.
- ai-enrich is gone, `intents.is_item` is dropped, conformance is CONFORMANT, MCP deployed with `get_groups` and the skip wording.
