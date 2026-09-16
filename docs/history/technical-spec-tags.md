# Technical Spec — Tags: spaces, autocomplete picker, collection tags, removals since midnight

Status: ready for implementation
Date: 2026-09-14
Supersedes nothing. Companion progress file: `docs/progress-tags.md`.
Source investigation: `docs/investigation-tags-and-collections.md`.

---

## 1. What we are building

Four connected changes, one project.

1. **Tags may contain spaces.** Today the tag rule is a rejection filter that
   silently discards anything outside `/^[a-z0-9_-]+$/`. It becomes a
   normaliser that accepts spaces. `"Whole Foods"` becomes `whole foods`
   instead of vanishing.
2. **Tag entry becomes an autocomplete picker** everywhere tags are typed.
   Type to search existing tags, select one, or create a new one from a row
   that is **always visible at the bottom of the list**. Matching ignores case
   and punctuation.
3. **Collection items carry tags.** Ephemeral per-trip tags (`tjs`,
   `whole foods`) on the shopping list, filterable, surviving remove-and-restore,
   never applied on a fresh add.
4. **"Recently removed" shows everything removed since local midnight**
   (America/Los_Angeles), uncapped, instead of the last five.

Plus one cleanup: **`contexts.tags` is deleted.** It is a jsonb column with a
GIN index, two rows of data (`home`, `remodel`), and no user interface. It has
never been reachable from the app. Contexts keep their `keywords` column, which
is the field that actually does work during inbox triage.

## 2. Decisions already made

| Question | Decision |
|---|---|
| Spaces in tags? | Yes. Normalise rather than reject. |
| Existing `stir_fry`-style tags? | Underscores become spaces, one-time, in the migration. |
| `contexts.tags`? | Dropped entirely. |
| Tag merge when an already-tagged collection item is re-added? | Leave existing tags alone. |
| Where does normalisation happen? | **On write only, never on load.** See §4. |
| Create-new placement? | Always visible at the bottom of the results. |
| Suggestion pools? | Separate. Collection tags never mix with item/intent tags. |
| Sequencing? | One project, seven phases, verification gate after each. |

## 3. The canonical tag rule

A single function, `normaliseTag`, is the only definition. Applied on every
write path, never on read.

Given raw input:

1. Lowercase.
2. Replace any character that is not a letter, digit, space, hyphen or
   underscore with a space. (So `tj's` becomes `tj s`… see the note below.)
3. Replace underscores **and hyphens** with spaces.
4. Collapse runs of whitespace to one space, then trim.
5. Reject if empty or longer than 50 characters.

A record holds at most 20 tags, deduplicated. Both limits carry over from the
current `TagInput`.

> **Apostrophes.** Step 2 as written turns `tj's` into `tj s`, which is wrong.
> Strip apostrophes (`'` and `’`) with no replacement *before* step 2, so
> `tj's` becomes `tjs`. Every other punctuation mark becomes a space.

> **Hyphens fold too** _(amended 2026-09-14, after Phase 2)._ Step 3 originally
> converted underscores only, and hyphens survived into storage — so `stir-fry`
> stored as `stir-fry` and sat beside `stir fry` as a separate tag forever.
>
> The picker's loose matcher hid this from anyone typing, because it folds both
> to `stirfry`. But the AI write paths never touch the picker, so a model
> returning `stir-fry` created the duplicate regardless. Hyphens are now treated
> exactly as underscores, before the whitespace collapse, leaving exactly one
> canonical spelling of any multi-word tag. A leading or trailing hyphen leaves
> no stray space, because step 4 trims afterwards.
>
> Migration A folds hyphens in the same statement, so stored data matches.
> The loose matcher (§5.1) is unaffected — it already ignored hyphens.

**Matching is looser than storage.** When comparing what the user typed against
existing tags, both sides are folded further: punctuation, spaces, hyphens and
underscores all removed. So typing `tjs`, `TJ's` or `tj-s` all match a stored
`tjs`, and typing `wholefoods` matches a stored `whole foods`. This is the
loose matcher from §5.1, and it is used **only for search inside the picker**,
never for storage or for filtering a list.

## 4. The rule that keeps the dirty-checks working

Alfred has four "you have unsaved changes" checks that compare tags exactly as
stored, using `JSON.stringify`. They work today only because normalisation
happens inside the tag input on the way in, so component state always holds
already-normalised values.

**That property must be preserved.** Normalise when the user commits a tag and
when a tag is written by any non-UI path. Never normalise when a record loads.

If normalisation ever moves to load time, those four comparisons become the
"twin site" pattern — two copies of the same logic that must change together —
and any record holding a non-canonical tag will report itself permanently
edited, blocking navigation with an unsaved-changes prompt about changes that
do not exist.

The four comparisons, which this project **does not touch**:

- `ItemDetail`, around `Alfred.jsx:10187`
- `IntentionDetail`, around `Alfred.jsx:11466`
- inbox intention section, around `Alfred.jsx:7051`
- inbox item section, around `Alfred.jsx:7056`

This is why the migration normalises existing data (§6) and why the AI
enrichment path gets fixed (§8). Once every write path is canonical, load-time
normalisation is unnecessary and the raw comparisons stay correct.

## 5. Utilities

### 5.1 The loose matcher

`src/utils/search.js` already exports `matchesQuery`, which lowercases and does
a plain substring test. It is used by `ItemPicker` and `CollectionAddItems`, and
`search.test.js` pins the fact that inner whitespace is significant.

**Do not widen `matchesQuery`.** Leave it and its test untouched.

`src/utils/ingredientMatch.js` has a private `normalize` (around line 337) that
lowercases, drops punctuation and collapses whitespace — exactly the semantics
needed. Extract it to `src/utils/search.js` and export a second matcher,
`matchesLoosely(query, ...fields)`, built on it. Update `ingredientMatch.js` to
import the extracted helper rather than keeping its own copy.

### 5.2 The tag normaliser

New file `src/utils/tags.js`:

- `normaliseTag(raw)` → canonical string, or `null` if it does not survive.
- `normaliseTags(rawList)` → array, normalised, deduplicated, capped at 20.

This replaces the `processTags` function currently living inside `TagInput`
around `Alfred.jsx:688`.

### 5.3 The Pacific day boundary

New file `src/utils/localDay.js`. Alfred has no such helper; SAM has a Pacific
date toolkit but it returns date strings, not instants, and lives under
`src/sam/`. Alfred importing from SAM's internals would create a new cross-app
dependency, so this is a separate, small, tested function. SAM is not touched.

```js
const TZ = "America/Los_Angeles";

function zoneOffsetMs(instant) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(instant).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(
    +p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second,
  );
  return asUTC - instant.getTime();
}

/** The instant at which the current Pacific calendar day began. */
export function startOfPacificDay(now = new Date()) {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const naive = Date.parse(`${key}T00:00:00Z`);
  const firstPass = naive - zoneOffsetMs(new Date(naive));
  return new Date(naive - zoneOffsetMs(new Date(firstPass)));
}
```

The two passes handle the case where the first offset guess lands on the wrong
side of a daylight-saving transition.

**Required tests**, each with the system clock and the browser timezone forced
to something that is not Pacific:

- A time just after Pacific midnight returns that same day's boundary.
- A time just before Pacific midnight returns the *previous* day's boundary.
- Spring forward, 2026-03-08.
- Fall back, 2026-11-01.

## 6. Migration A — the tag format change

Run manually in the Supabase SQL editor. **The Edge Function changes in Phase 2
must be deployed before this runs**, because `get_contexts` currently selects
`contexts.tags` and would break the moment the column disappears.

The type change uses add-column, populate, drop, rename. PostgreSQL rejects
subqueries inside an `ALTER COLUMN … TYPE … USING` clause, so converting a
jsonb array in place is not available.

```sql
begin;

-- items -------------------------------------------------------------
drop index if exists idx_items_tags;

alter table items add column tags_new text[] not null default '{}'::text[];

update items set tags_new = coalesce(
  (select array_agg(distinct btrim(regexp_replace(replace(lower(v), '_', ' '),
                                                  '\s+', ' ', 'g')))
     from jsonb_array_elements_text(tags) as v
    where btrim(v) <> ''),
  '{}'::text[]);

alter table items drop column tags;
alter table items rename column tags_new to tags;
create index idx_items_tags on items using gin (tags);

-- intents -----------------------------------------------------------
drop index if exists idx_intents_tags;

alter table intents add column tags_new text[] not null default '{}'::text[];

update intents set tags_new = coalesce(
  (select array_agg(distinct btrim(regexp_replace(replace(lower(v), '_', ' '),
                                                  '\s+', ' ', 'g')))
     from jsonb_array_elements_text(tags) as v
    where btrim(v) <> ''),
  '{}'::text[]);

alter table intents drop column tags;
alter table intents rename column tags_new to tags;
create index idx_intents_tags on intents using gin (tags);

-- contexts: delete the column outright ------------------------------
drop index if exists idx_contexts_tags;
alter table contexts drop column tags;

-- the search function: ?| becomes && --------------------------------
create or replace function public.platform_search_items(
  p_context_id text default null,
  p_search_text text default null,
  p_tags text[] default null,
  p_limit integer default 20)
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with filtered as (
    select id, name, description, context_id, tags, is_capture_target, created_at
      from items
     where user_id = auth.uid()
       and archived = false
       and (p_context_id  is null or context_id = p_context_id)
       and (p_search_text is null or
            (name ilike '%' || p_search_text || '%' or
             description ilike '%' || p_search_text || '%'))
       and (p_tags is null
            or array_length(p_tags, 1) is null
            or tags && p_tags)
  )
  select jsonb_build_object(
    'rows',
      coalesce(
        (select jsonb_agg(row_to_json(x) order by x.name)
           from (select * from filtered order by name limit p_limit) x),
        '[]'::jsonb),
    'total',
      (select count(*) from filtered)
  );
$function$;

commit;
```

Notes on what this does and does not do:

- The `update` folds in the underscore-to-space fix, so `nervous_system`
  becomes `nervous system` in the same statement that changes the type.
- `array_agg(distinct …)` guards against a record ending up with the same tag
  twice after the underscore conversion. It also sorts each record's tags
  alphabetically, which is harmless.
- Dropping and recreating the GIN indexes is mandatory, not cosmetic. A GIN
  index on jsonb uses a different operator class than one on a text array; the
  type change alone will not convert it.
- There are no check constraints on any tags column, confirmed by
  introspection, so nothing else needs relaxing.
- The tables are already registered with the platform layer. No
  `register_table` call is needed, but per house rules the migration is not done
  until `check_platform_conformance` returns CONFORMANT.

**Rollback is not clean.** The old column is dropped, so recovering the
original jsonb values means a point-in-time restore. Take the backup Supabase
offers before running this.

## 7. Migration B — tags on collection items

Run manually, after Phase 4 is verified.

```sql
begin;

alter table collection_items
  add column tags text[] not null default '{}'::text[];

alter table collection_item_removals
  add column tags text[] not null default '{}'::text[];

commit;
```

No index. Tag filtering on a collection happens client-side over an
already-loaded list of at most a few dozen rows; an index would earn nothing.
Run `check_platform_conformance` afterwards.

## 8. The AI enrichment path

`supabase/functions/ai-enrich/index.ts` asks the model for suggested tags with a
prompt-level hint only, and writes whatever comes back straight to
`inbox.suggested_tags`. Those values flow into `items.tags` and `intents.tags`
verbatim on triage if the user never touches the tag box. Nothing validates
them.

Your stored data is clean today — the audit found zero violations — but once
spaces are legal the model will start returning capitals and punctuation, and a
non-canonical stored tag is exactly what breaks §4.

Two changes:

1. **Normalise on write.** Run the enrichment function's output through the
   same canonical rule before it is stored. The Edge Function cannot import
   from `src/`, so the rule needs a small Deno-side copy in
   `supabase/functions/_shared/`. This is a deliberate second copy of a
   normaliser — note it in the file header of both, since Alfred has been bitten
   by unsynchronised duplicate normalisers before.
2. **Update the instructions** so future suggestions arrive in the right shape.
   Three places currently say underscores:
   - the prompt inside `supabase/functions/ai-enrich/index.ts`
   - `/mnt/skills/user/alfred-enrich/SKILL.md`
   - any MCP tool description mentioning tag format, in
     `supabase/functions/_shared/alfred-tools/`

   All three become: lowercase, spaces between words, no punctuation.

## 9. The tag picker

### 9.1 What exists

Two pickers, neither of which is right as-is.

`CollectionAddItems` (`Alfred.jsx:803-940`) has the create-new affordance, but
it only renders when the search returns **zero** results — it replaces the empty
list rather than sitting under matches. The component is also welded to items
and collections: quantity inputs per row, multi-select checkboxes, a maximum
item count, a context line. It is not reusable.

`ItemPicker` (`src/ItemPicker.jsx`, 205 lines) is the shared, extracted,
single-select picker, with three display variants, blur handling with a 200 ms
grace period, a result cap with an overflow note, and distinct empty-versus-no-
match states. It has no create-new affordance.

### 9.2 What to build

`src/TagPicker.jsx`, taking `ItemPicker`'s structure and adding a create-new row
that is **always rendered at the bottom of the list**, not only when results are
empty. This is the fix for the case that has already bitten you: typing `bread`
when `breadcrumbs` exists currently offers no way to create `bread`.

Behaviour:

- Filter the suggestion pool with `matchesLoosely` from §5.1.
- The create row reads `Create "<normalised form>"` and shows the **normalised**
  text, so typing `Whole Foods` offers `Create "whole foods"`. It is hidden only
  when the typed text normalises to something already in the list, or
  normalises to nothing.
- Selecting an existing tag and creating a new one both append a normalised tag
  to the chip list.
- ~~**Preserve commit-on-blur.**~~ **REVERSED — see the note below. Blur must
  NOT commit.**
- Chip removal, the 20-tag cap and the 50-character cap all carry over.
- Selection is single per commit; the chip list is the multi-value part.
- **Adding a tag closes the list and drops focus**, so the chip row underneath
  is visible and the phone keyboard gets out of the way.

> **Commit-on-blur is gone** _(reversed 2026-09-14, after Phase 4 verification)._
>
> This bullet originally said the blur commit was load-bearing and must be kept.
> **It is not, and it must not be.** Do not restore it by reading the older
> wording.
>
> A tag is created by an explicit act and nothing else: tapping the Create row,
> tapping a suggestion, or pressing Enter. Blurring the field leaves the typed
> text sitting in the input, uncommitted and still visible.
>
> **Why the original reasoning expired.** It was sound while typing was the ONLY
> way to add a tag — losing half-typed text on blur was worse than the odd
> accidental one. The always-visible Create row removes that premise, and once
> it existed the failure ran the other way: typing `wo`, tapping anywhere else,
> and silently acquiring a tag called `wo`.
>
> **The accepted cost, decided deliberately:** type a complete tag, tap Save
> without committing it, and the tag is not saved. This does not need
> mitigating. Creating a tag should be something you did on purpose.
>
> What stays: the `onMouseDown` handlers that stop focus leaving the control
> when a row or a chip's × is tapped. They were introduced to prevent a double
> commit, and they are still needed — on a phone, releasing focus mid-tap
> dismisses the keyboard and reflows the page under the finger.

### 9.3 Where it goes

Replace `TagInput` at all four sites:

| Site | Location |
|---|---|
| Inbox, intention section | `Alfred.jsx:7738-7742` |
| Inbox, item section | `Alfred.jsx:8008-8012` |
| Item detail / add | `Alfred.jsx:10427-10429` |
| Intention detail / add | `Alfred.jsx:11608-11610` |

The old `TagInput` and its `processTags` are deleted once all four are migrated.

### 9.4 Suggestion pools

Two pools, never mixed.

**Items and intentions** draw from tags currently in use across the loaded items
and intents — the same client-side derivation `TagFilter` already does at
`Alfred.jsx:766-775`. No new query.

**Collections** draw from the current collection's members *and* that
collection's removal history. This second half matters: without it, the moment
the shopping list is emptied, `tjs` and `whole foods` stop existing and get
retyped from scratch next week, which is the duplicate problem this project
exists to prevent.

New function in `src/utils/collectionMembers.js`: `loadCollectionTagPool(collectionId)`,
selecting only the `tags` column from `collection_item_removals` for that
collection, most recent 500 rows, flattened and deduplicated, unioned with the
tags on current members.

## 10. Collection tags — data layer

All in `src/utils/collectionMembers.js`.

| # | Function | Change |
|---|---|---|
| 1 | `removeMembers` (~:528) | Add `tags: member.tags ?? []` to the snapshot written to the removals table |
| 2 | `addMembers` (~:201) | Accept `entry.tags`, defaulting to `[]` |
| 3 | `addMember` (~:597) | Pass `options.tags` through |
| 4 | `reAddRemoval` (~:658) | Pass `tags: removal.tags` |
| 5 | new | `updateMemberTags(collectionId, itemId, tags)` — a targeted `.update({ tags })` |

**Do not widen `updateMemberQuantity`** to also write tags. It is called in a
loop by `addOrMergeMembers`, and doing so would overwrite tags during a merge.

**The merge policy is: leave existing tags alone.** When `addOrMergeMembers`
finds an item already on the list, quantity merges as it does today and tags are
untouched. Nothing to implement — just do not add tag handling there.

**Required regression test.** Item tags must not leak into collection rows.
Today `collapseEntries` (~:469) rebuilds every entry as `{itemId, quantity}`,
discarding anything else, which is the only thing standing between an item's
`vegetarian` tag and its collection row. Once `addMembers` learns to accept
`entry.tags` (edit 2 above), that guard becomes load-bearing and easy to
"helpfully" widen. `collectionMembers.test.js` is the home for this.

## 11. Collection tags — UI

On the collection detail view:

- Each member row gains a tag control. Tags render as chips, consistent with the
  item and intention cards. Tapping opens the `TagPicker` with the collection
  pool from §9.4.
- A tag filter appears above the list, reusing the existing `TagFilter`
  component (`Alfred.jsx:765-800`), which derives its pills and counts from
  whatever entity array it is handed.
- **The filter needs its own state variable.** `filterTag` at `Alfred.jsx:1423`
  is a single value shared across the Intentions, Memories and Context Detail
  views. Adding a fourth consumer with a *different* tag pool would leak — a
  `tjs` filter set on the shopping list would still be set when you open a
  context. Add `collectionFilterTag` alongside it, reset on view change.
- Tags are **not** applied when an item is added to a collection. A fresh add
  gets `'{}'`, always.

One known limitation, accepted: collection membership has no realtime channel,
only a five-second poll while the detail view is open. If Elise tags an item on
her phone while you have the list open, you will see it within five seconds, not
instantly. No change proposed.

## 12. Removals since midnight

Three separate caps currently hide old removals, and **all three must move** or
the change will appear to work while silently keeping a ceiling:

| Cap | Location |
|---|---|
| `MAX_REMOVALS = 200` | `collectionMembers.js:53-55` |
| `limit: 25` on the panel fetch | `Alfred.jsx:3957-3960` |
| `.slice(0, 5)` on render | `Alfred.jsx:6029-6032` |

Changes:

- `loadRemovals` gains a `since` option that adds `.gte("removed_at", iso)`, and
  allows the limit to be omitted entirely. The table already has an index on
  `(collection_id, removed_at DESC)`, so this is efficient with no new index.
- `loadCollectionRemovals` passes `since: startOfPacificDay().toISOString()` and
  no limit.
- The render drops `.slice(0, 5)`.

**Keep two things unchanged.** The `reason: 'manual'` filter stays, so bulk
completions do not flood the panel. And the filter that drops removals whose
item is currently back in the collection stays — it is how "Put back" clears a
row without its own optimistic update.

`removed_at` is a server timestamp, populated by column default inside a single
insert per bulk removal. So the comparison is a server instant against a
computed Pacific midnight, with no trust in the device clock anywhere. A phone
with a wrong clock or a different timezone still sees the right list.

## 13. Phases

Each ends with a verification gate. Do not start the next until the previous is
confirmed.

| Phase | What | Kind |
|---|---|---|
| 1 | Utilities: loose matcher, tag normaliser, Pacific day helper, all tested | Code |
| 2 | Edge Function: stop selecting `contexts.tags`, normalise AI tags on write, update the three instruction sites. Deploy. | Code + deploy |
| 3 | Migration A | Manual SQL |
| 4 | `TagPicker`, replacing all four `TagInput` sites | Code |
| 5 | Migration B | Manual SQL |
| 6 | Collection tags: data layer, UI, filter, regression test | Code |
| 7 | Removals since midnight | Code |

Phase 2 must precede Phase 3. Phase 3 must precede Phase 4 — the picker should
be built against the final storage format, not the jsonb one. Phase 5 must
precede Phase 6.

## 14. What is deliberately not in scope

- The full schema snapshot. It remains missing and remains a real problem for
  the repo, but it is a separate errand; this project pulled the five
  definitions it needed by hand and they are recorded in §6 and §7.
- Migrating SAM's Pacific date toolkit into shared utilities.
- Junk tag cleanup (`test`, `test_tag`, `testing`, `another_tag`, `book` versus
  `books`, `recipe` on 13 items). Hand editing, not project work.
- Realtime sync for collection membership.
- Backfilling test coverage beyond the specific tests named in this spec. There
  is currently zero test coverage on tags anywhere in the app.
