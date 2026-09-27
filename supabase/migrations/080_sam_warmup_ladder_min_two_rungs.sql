-- Purpose: A warm-up ladder needs 2 to 6 rungs, not 1 to 6. Replaces sam_warmup_ladder_is_valid and re-adds the three check constraints so existing rows are re-checked.
-- Kind: schema change (function body + three constraints dropped and re-added)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.

-- ============================================================================
-- SAM Warm-up Ladder — minimum two rungs
-- supabase/migrations/080_sam_warmup_ladder_min_two_rungs.sql
-- Spec: docs/technical-spec-sam-warmup-ladder.md §5.1
-- Supersedes the rung-count rule in supabase/migrations/078_sam_warmup_ladder.sql
--
-- WHY. A one-rung ladder is not a ladder: its only rung must be 100% (the last
-- rung rule), so it is a pass count at target tempo with a warm-up label on it —
-- which is what a plan item already is. It also cannot be counted properly.
-- sam_plan_item_progress recognises a restart by the recorded rung DROPPING, and
-- with one rung it never drops, so pressing Warm up twice in a sitting is
-- indistinguishable from continuing to loop and counts once. That limitation is
-- named in the function's own comment, and this is the fix for it: two rungs
-- means at least one warm-up rung below the target, e.g. 80% then 100%.
--
-- RUN THE WHOLE FILE IN ONE PASTE. The DROP CONSTRAINT statements and the CREATE
-- OR REPLACE belong together: between them the column has no validation at all.
--
-- THE THREE CONSTRAINTS ARE DROPPED AND RE-ADDED ON PURPOSE. Postgres does not
-- re-validate existing rows when the body of a function used by a CHECK
-- constraint changes — the caveat written into 078's own comment. Replacing the
-- body alone would leave a one-rung ladder already stored as a row that no longer
-- satisfies its own constraint and that nothing would ever complain about.
-- Re-adding each constraint re-checks every existing row, so if a one-rung ladder
-- exists the ADD fails loudly and names the table. Part 0 below tells you that
-- before you try.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- PART 0 — Look first (read-only). Expect all three counts to be 0.
-- ---------------------------------------------------------------------------
-- A row listed here will make PART 2 fail. Fix it by hand (add a rung, or set
-- the column back to null) and run PART 2 again.
select json_build_object(
  'one_rung_ladders_that_will_block_part_2', (select json_agg(t) from (
     select 'sam_snippets' as tbl, id, warmup_ladder from sam_snippets
      where jsonb_typeof(warmup_ladder) = 'array' and jsonb_array_length(warmup_ladder) = 1
     union all
     select 'sam_songs', id, warmup_ladder from sam_songs
      where jsonb_typeof(warmup_ladder) = 'array' and jsonb_array_length(warmup_ladder) = 1
     union all
     select 'sam_practice_plan_items', id, warmup_ladder from sam_practice_plan_items
      where jsonb_typeof(warmup_ladder) = 'array' and jsonb_array_length(warmup_ladder) = 1
  ) t),
  'ladders_stored_anywhere', (select json_agg(t) from (
     select (select count(*) from sam_snippets where warmup_ladder is not null)            as snippets,
            (select count(*) from sam_songs where warmup_ladder is not null)               as songs,
            (select count(*) from sam_practice_plan_items where warmup_ladder is not null) as items
  ) t)
) as result;


-- ---------------------------------------------------------------------------
-- PART 1 — The new rule
-- ---------------------------------------------------------------------------
-- Identical to 078 except for the length test, which is called out below. The
-- whole body is restated rather than patched, because a validator that has to be
-- read in two files is a validator nobody reads.
create or replace function public.sam_warmup_ladder_is_valid(p_ladder jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = public
as $$
declare
  v_len  integer;
  v_rung jsonb;
  v_pct  integer;
  v_prev integer := null;
  v_keys integer;
  i      integer;
begin
  -- NULL means "fall through to the next level" (spec §5.1). It is not a ladder
  -- and there is nothing to check.
  if p_ladder is null then
    return true;
  end if;

  if jsonb_typeof(p_ladder) <> 'array' then
    return false;
  end if;

  v_len := jsonb_array_length(p_ladder);

  -- The empty array is how a song or an item opts OUT of a ladder it would
  -- otherwise inherit (spec §5.1). It is valid and means "no warm-up here".
  if v_len = 0 then
    return true;
  end if;

  -- TWO TO SIX RUNGS (changed 2026-09-27; was one to six).
  --
  -- A single rung must be 100% by the last-rung rule, so it is a pass count at
  -- target tempo, not a ramp — and sam_plan_item_progress cannot tell a restart
  -- from continued looping without a rung that drops. Two rungs is the smallest
  -- real ladder: one below target, then target.
  --
  -- Six is still the ceiling: a ramp longer than six is a practice session, and
  -- the strip in the player has no room for it.
  if v_len < 2 or v_len > 6 then
    return false;
  end if;

  for i in 0 .. v_len - 1 loop
    v_rung := p_ladder -> i;

    if jsonb_typeof(v_rung) <> 'object' then
      return false;
    end if;

    -- Exactly the four known keys, nothing else. A rung written with
    -- "target_pass" or "percent" would otherwise be accepted and then silently
    -- ignored by every reader, which is worse than a rejected write.
    select count(*) into v_keys
      from jsonb_object_keys(v_rung) k
     where k not in ('target_percent', 'accuracy_target', 'target_passes', 'consecutive');
    if v_keys > 0 then
      return false;
    end if;

    -- target_percent, target_passes and consecutive are required on every rung.
    -- accuracy_target must be present but may be null, which means "use the
    -- item's accuracy target" (spec §3).
    -- jsonb_exists() rather than the `?` operator: identical meaning, and no
    -- client that rewrites `?` as a bind placeholder can mangle it.
    if not (jsonb_exists(v_rung, 'target_percent')
            and jsonb_exists(v_rung, 'target_passes')
            and jsonb_exists(v_rung, 'consecutive')
            and jsonb_exists(v_rung, 'accuracy_target')) then
      return false;
    end if;

    if jsonb_typeof(v_rung -> 'target_percent') <> 'number' then
      return false;
    end if;
    v_pct := (v_rung ->> 'target_percent')::numeric::integer;
    if (v_rung ->> 'target_percent')::numeric <> v_pct then
      return false;                      -- whole percents only
    end if;
    if v_pct < 10 or v_pct > 100 then
      return false;
    end if;

    -- STRICTLY ascending, which is stronger than the spec's "ascending order".
    -- Two rungs at the same percent are two rungs at the same tempo, and the
    -- recorded warmup_target_percent would then no longer identify which rung a
    -- pass belonged to — which is exactly what the progress function reads it
    -- for. A rung that exists only to tighten the accuracy bar at the same
    -- tempo belongs in the rung below it.
    if v_prev is not null and v_pct <= v_prev then
      return false;
    end if;
    v_prev := v_pct;

    -- The last rung is the target. A ladder that stops short of 100% would
    -- leave the player looping below target tempo with nothing to finish.
    if i = v_len - 1 and v_pct <> 100 then
      return false;
    end if;

    if jsonb_typeof(v_rung -> 'accuracy_target') not in ('null', 'number') then
      return false;
    end if;
    if jsonb_typeof(v_rung -> 'accuracy_target') = 'number' then
      if (v_rung ->> 'accuracy_target')::numeric < 1
         or (v_rung ->> 'accuracy_target')::numeric > 100 then
        return false;
      end if;
    end if;

    if jsonb_typeof(v_rung -> 'target_passes') <> 'number' then
      return false;
    end if;
    if (v_rung ->> 'target_passes')::numeric < 1
       or (v_rung ->> 'target_passes')::numeric > 32767 then
      return false;
    end if;

    if jsonb_typeof(v_rung -> 'consecutive') <> 'boolean' then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.sam_warmup_ladder_is_valid(jsonb) is
'SAM: the ONE definition of a valid warm-up ladder (spec §5.1), used by the CHECK constraint on
sam_snippets, sam_songs and sam_practice_plan_items. True for NULL (inherit) and for [] (no warm-up
here). Otherwise: 2-6 rungs — one rung is not a ladder, since its only rung would have to be 100%
and a restart cannot be told from continued looping without a rung that drops; every rung an object
with exactly the keys target_percent, accuracy_target, target_passes, consecutive; percents whole,
10-100, STRICTLY ascending, last rung exactly 100; accuracy_target null or 1-100; target_passes >= 1;
consecutive a boolean. NOTE: Postgres does not re-check existing rows when this body changes — drop
and re-add the three constraints if the rules ever change, as
supabase/migrations/080_sam_warmup_ladder_min_two_rungs.sql does.';


-- ---------------------------------------------------------------------------
-- PART 2 — Re-check every existing row against the new rule
-- ---------------------------------------------------------------------------
-- Each ADD scans the table. If one fails, PART 0 has already told you which row
-- and why; nothing else in this file needs re-running afterwards.
alter table public.sam_snippets
  drop constraint if exists sam_snippets_warmup_ladder_valid;
alter table public.sam_snippets
  add constraint sam_snippets_warmup_ladder_valid
  check (public.sam_warmup_ladder_is_valid(warmup_ladder));

alter table public.sam_songs
  drop constraint if exists sam_songs_warmup_ladder_valid;
alter table public.sam_songs
  add constraint sam_songs_warmup_ladder_valid
  check (public.sam_warmup_ladder_is_valid(warmup_ladder));

alter table public.sam_practice_plan_items
  drop constraint if exists sam_practice_plan_items_warmup_ladder_valid;
alter table public.sam_practice_plan_items
  add constraint sam_practice_plan_items_warmup_ladder_valid
  check (public.sam_warmup_ladder_is_valid(warmup_ladder));


-- ---------------------------------------------------------------------------
-- PART 3 — Conformance
-- ---------------------------------------------------------------------------
-- No table, column or policy changed, so nothing is registered. Expected:
-- CONFORMANT, plus a table count.
select platform.check_conformance();
-- If the platform schema is not exposed to your session, the public wrapper is
-- equivalent:
--   select public.platform_check_conformance();


-- ---------------------------------------------------------------------------
-- PART 4 — Verification (read-only)
-- ---------------------------------------------------------------------------
-- Every line must come back as its comment says. This is the rule, stated as
-- data.
select json_build_object(
  'one_rung_now_rejected_expect_false',
    public.sam_warmup_ladder_is_valid(
      '[{"target_percent":100,"accuracy_target":null,"target_passes":2,"consecutive":true}]'),
  'two_rungs_accepted_expect_true',
    public.sam_warmup_ladder_is_valid(
      '[{"target_percent":80,"accuracy_target":null,"target_passes":2,"consecutive":true},
        {"target_percent":100,"accuracy_target":null,"target_passes":2,"consecutive":true}]'),
  'the_app_default_still_valid_expect_true',
    public.sam_warmup_ladder_is_valid(public.sam_default_warmup_ladder()),
  'null_still_means_inherit_expect_true',
    public.sam_warmup_ladder_is_valid(null),
  'empty_still_means_no_warmup_expect_true',
    public.sam_warmup_ladder_is_valid('[]'),
  'seven_rungs_rejected_expect_false',
    public.sam_warmup_ladder_is_valid(
      '[{"target_percent":40,"accuracy_target":null,"target_passes":1,"consecutive":true},
        {"target_percent":50,"accuracy_target":null,"target_passes":1,"consecutive":true},
        {"target_percent":60,"accuracy_target":null,"target_passes":1,"consecutive":true},
        {"target_percent":70,"accuracy_target":null,"target_passes":1,"consecutive":true},
        {"target_percent":80,"accuracy_target":null,"target_passes":1,"consecutive":true},
        {"target_percent":90,"accuracy_target":null,"target_passes":1,"consecutive":true},
        {"target_percent":100,"accuracy_target":null,"target_passes":1,"consecutive":true}]'),
  'last_rung_must_be_100_expect_false',
    public.sam_warmup_ladder_is_valid(
      '[{"target_percent":70,"accuracy_target":null,"target_passes":2,"consecutive":true},
        {"target_percent":90,"accuracy_target":null,"target_passes":2,"consecutive":true}]'),
  'percents_must_ascend_expect_false',
    public.sam_warmup_ladder_is_valid(
      '[{"target_percent":90,"accuracy_target":null,"target_passes":2,"consecutive":true},
        {"target_percent":70,"accuracy_target":null,"target_passes":2,"consecutive":true},
        {"target_percent":100,"accuracy_target":null,"target_passes":2,"consecutive":true}]')
) as result;
