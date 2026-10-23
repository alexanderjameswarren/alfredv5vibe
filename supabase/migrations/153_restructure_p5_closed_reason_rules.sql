-- Purpose: Restructure P5 Step 13 follow-up (restructure_p5-h7m). closed_reason belongs to Closed only, on items, intents and item_groups. Rule 1: status_guard clears closed_reason whenever status moves out of closed. Rule 2: CHECK (closed_reason is null or status = 'closed') on each table.
-- Kind: schema change (one function replaced, three constraints, three comments)
-- Applied: NO
--
-- Run as one block in the SQL editor, then supabase/tests/restructure_p5-h7m/step13_closed_reason_rules_verify.sql.
-- Safe to re-run. No new table, so no register_table call; conformance is unaffected.
-- Rule 1 lives IN status_guard, not a trigger beside it: status_guard is already the one
-- BEFORE UPDATE trigger on all three tables that decides the final status (it can undo a
-- move to someday), so the clear must run after that decision, in the same function.
-- A second trigger would depend on alphabetical firing order to see the final status.
-- Every existing behaviour is kept, including the Undo-of-close exception (closed -> someday
-- within 10 minutes of the close).
-- Rule 2 validates existing rows; Alex's 2026-10-23 production check found none in breach.
-- The app writes a reason only together with status 'closed' (Close, and an Undo back to
-- Closed via statusPatch), so both rules hold for every app path.

begin;

create or replace function public.status_guard() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  -- Nothing returns to someday; this also defeats a stale whole-record write.
  -- Restructure P4: except the Undo of a close, within 10 minutes of it.
  if new.status = 'someday' and old.status is distinct from 'someday' then
    if not (old.status = 'closed'
            and old.status_written_at is not null
            and old.status_written_at > now() - interval '10 minutes') then
      new.status := old.status;
    end if;
  end if;

  if new.status is distinct from old.status then
    new.status_written_at := now();
    -- Restructure P4: a value the app supplies with the change (Closed on, or an
    -- Undo putting the earlier one back) is kept, if it is not in the future.
    if new.status_changed_at is distinct from old.status_changed_at
       and new.status_changed_at is not null
       and new.status_changed_at <= now() then
      null;
    else
      new.status_changed_at := now();
    end if;
    -- Restructure P5: the reason belongs to Closed. Leaving it, by any path, clears it.
    if old.status = 'closed' and new.status is distinct from 'closed' then
      new.closed_reason := null;
    end if;
  else
    new.status_written_at := old.status_written_at;
    new.status_changed_at := old.status_changed_at;
  end if;

  return new;
end;
$$;

comment on function public.status_guard() is
  'Restructure P1, P4, P5. BEFORE UPDATE on items, intents and item_groups. Keeps the old status when an update would move it back to someday, except closed -> someday within 10 minutes of the close by status_written_at (Undo). On a status change, stamps status_written_at now(), keeps an app-supplied status_changed_at that is no later than now() and otherwise stamps now(), and (P5) clears closed_reason when the status leaves closed; an update that does not change status keeps both stored dates.';

alter table public.items drop constraint if exists items_closed_reason_only_closed;
alter table public.items add constraint items_closed_reason_only_closed
  check (closed_reason is null or status = 'closed');
alter table public.intents drop constraint if exists intents_closed_reason_only_closed;
alter table public.intents add constraint intents_closed_reason_only_closed
  check (closed_reason is null or status = 'closed');
alter table public.item_groups drop constraint if exists item_groups_closed_reason_only_closed;
alter table public.item_groups add constraint item_groups_closed_reason_only_closed
  check (closed_reason is null or status = 'closed');

comment on column public.items.closed_reason is
  'Restructure P4. Why it was closed: done (Completed) | wont_do (Won''t do). Null = unknown (closed before P4, or never recorded), and always null when not closed (P5: status_guard clears it on reopen; items_closed_reason_only_closed). Written by the app''s Close pop-up.';
comment on column public.intents.closed_reason is
  'Restructure P4. Why it was closed: done (Completed) | wont_do (Won''t do). Null = unknown (closed before P4, or never recorded), and always null when not closed (P5: status_guard clears it on reopen; intents_closed_reason_only_closed). Written by the app''s Close pop-up and by the automatic close of a one-time intention on completion.';
comment on column public.item_groups.closed_reason is
  'Why it was closed: done | wont_do, as on items. Null = unknown, and always null when not closed (status_guard clears it on reopen; item_groups_closed_reason_only_closed).';

commit;
