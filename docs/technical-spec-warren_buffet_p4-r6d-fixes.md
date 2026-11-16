# Warren Buffet: fixes after Phase 4 (technical spec)

Project code: `warren_buffet_p4-r6d`. Planned at s23 (run tag `warren_buffet_p4-r6d-s23-k7wf`) and accepted at s24, 2026-11-15.
Progress: `docs/progress-warren_buffet_p4-r6d-fixes.md`. Phase 4's own spec and progress are in `docs/history/`.

This is part 1 of the slice. Next parts, under the same project code and planned separately (no design here):
- **Part 2:** keeping Amazon and Whole Foods order items fresh.
- **Part 3:** billing: clients, time logs, hours and invoices.

## 1. The fixes

### F1. wb-money: every to-do comes with an explanation, a link and an offer (S25)

File: `.claude/skills/wb-money/SKILL.md`.

When a money answer, or a line of the weekly cleanup, names something for Alex to do, the skill gives him three things:
1. **What it means, in plain words.** For example, what is wrong or due, and why it matters. No tool names, field names or jargon.
2. **The record's link**, `https://alfredv5vibe.vercel.app/<id>`, as it does now.
3. **An offer to do it himself in chat** when a tool can do it, named in plain words. For example, "I can mark this reviewed with your note". A write still follows the show-before-you-write rule.

A bare tool call or a raw field name is never the to-do. When no tool can do it, the skill says where he does it, such as the Money screen or the bank.

**Done when:**
- The rule sits once near the top of the skill, and sections 1, 5 and 9 point to it.
- In a fresh claude.ai thread, "what needs my attention in money?" gives each to-do with the meaning, the link and, where a tool exists, the offer. No to-do is a bare tool name or field.

### F2. wb-money: always read live data, and name the period (S25)

File: `.claude/skills/wb-money/SKILL.md`.

Before any money report or status, the skill reads live data with the tools. It never answers from an earlier read in the same chat, from the weekly cleanup inbox item or from memory. Each answer says the period its read covers: the dates, or "as of" with today's date for a point-in-time read.

**Done when:**
- The rule sits once near the top, and section 8 (Reports) points to it.
- In a fresh thread, asking the same status question twice makes two tool reads, and each answer names its period.
- An answer to an approved cleanup line re-reads the record first, rather than trusting the item's text.

### F3. get_wb_subscriptions gets `ids` and `offset` (S26 code, S27 deploy)

Files:
- `supabase/functions/_shared/tools/warren-buffet-p2.ts`, the handler.
- `supabase/functions/_shared/tools/warren-buffet-p2.test.mjs`, its tests.
- `supabase/functions/mcp/index.ts`, the input schema. zod strips keys it doesn't know, so the handler never sees `ids` without this.
- `supabase/functions/mcp/index.test.mjs`.
- `.claude/skills/wb-money/SKILL.md`, the section 4 line "It has no ids option yet".

The view `wb_subscription_overview` is not a registered table, so `readTable` can't serve it. The tool keeps its own query and takes the two shared options with the shared rules from `_shared/platform-read.ts`:
- **`ids`:** a non-empty array of at most 50 subscription uuids, duplicates dropped. It returns just those rows, and the other filters still apply. A bad value is refused with the shared wording, and nothing is read.
- **`offset`:** a whole number of 0 or more, applied after the order (status, name). The result gives `next_offset` when more rows remain, as `listResult` already does for its count.
- `include_prices` and `include_reviews` work with both.
- The schema advertises `ids` and `offset` with the same descriptions as the shared read options. Use `readOptions(...)`, or its `ids` and `offset` parts if the full set doesn't fit a view with no archive or context column.

**Done when:**
- The new tests pass: ids returns only those rows; ids plus status filters both ways; a bad ids value is refused; offset pages with the right `next_offset`; prices and reviews attach on an ids read.
- `node --test supabase/functions/mcp/tables.test.mjs` and `index.test.mjs` pass.
- The skill line says to use `ids` when the id is known, and `search` on the name otherwise.
- After the S27 deploy, a fresh thread can read one subscription by its id.

## 2. Out of scope, and why

- **Revoking anon on the 18 Phase 1 and 2 wb_ functions and on `wb_subscription_overview`, and the default-privileges change (old fix 4).** Migration 161 (2026-10-23) already did both, across every public object.
  - Checked live at s23 with get_sql_read: anon can execute 0 public functions and select from 0 public tables or views.
  - All 57 wb_ functions have PUBLIC revoked.
  - postgres's default privileges give nothing to public (globally) or to anon (in public).
  - The note in `docs/history/technical-spec-warren_buffet_p3-q5k.md` §6 predates 161. No app screen or scheduled task calls a wb_ function as anon.
- **supabase_admin's default privileges**, which still grant anon on objects supabase_admin creates in public. Migrations run as postgres and can't change them, and the gap covers every app. It belongs to the Platform health project, where it is already logged in Alfred.

## 3. Database items

- `db:deploy` at S27 only, for the mcp function deploy. It is claimed at that step, and released by gitpush Checkpoint.
- No SQL, no migrations and no `db:table:` or `db:fn:` items.
