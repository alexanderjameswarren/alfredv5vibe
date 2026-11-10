-- Purpose: Homer slice 1 (homer-h4k, phase C). homer_import_batch: the single implementation of the Kindle export
-- import. scripts/homer-import.mjs posts batches of up to 500 rows to it with Alex's token.
-- Kind: schema change (1 function). No data.
-- Applied: NO
--
-- Spec: docs/homer-spec-homer-h4k.md phase C. Test: supabase/tests/homer-h4k/3_queries_import_test.sql.
-- Security invoker: it writes the caller's own rows under RLS, so the token decides whose library it is.
-- supabase/migrations/226_homer_import.sql

begin;

create or replace function public.homer_import_batch(p_batch jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_kinds  constant text[] := array['readers', 'devices', 'series', 'books', 'reads'];
  v_uid    uuid := auth.uid();
  v_counts jsonb := '{}'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_total  int := 0;
  v_kind   text;
  r        jsonb;
  v_key    text;
  v_id     uuid;
  v_ref    uuid;
  v_ref2   uuid;
  v_series uuid;
  n        int;
  ins int; upd int; same int; bad int;
begin
  if v_uid is null then
    raise exception 'homer_import_batch: no signed-in user.' using errcode = '28000';
  end if;
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' then
    raise exception 'homer_import_batch: the batch must be a JSON object of arrays keyed readers, devices, series, books, reads.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_batch) k where k <> all(c_kinds)) then
    raise exception 'homer_import_batch: unknown key in the batch; allowed: readers, devices, series, books, reads.'
      using errcode = '22023';
  end if;
  foreach v_kind in array c_kinds loop
    if p_batch ? v_kind then
      if jsonb_typeof(p_batch -> v_kind) <> 'array' then
        raise exception 'homer_import_batch: % must be an array.', v_kind using errcode = '22023';
      end if;
      v_total := v_total + jsonb_array_length(p_batch -> v_kind);
    end if;
  end loop;
  if v_total > 500 then
    raise exception 'homer_import_batch: % rows in one batch; the limit is 500.', v_total using errcode = '22023';
  end if;

  -- Everything below runs in one block. A dry run raises at the end, which undoes every write but keeps the counts.
  begin
    -- Kinds are processed in dependency order, so a batch may hold a book and the series it points to.
    foreach v_kind in array c_kinds loop
      ins := 0; upd := 0; same := 0; bad := 0;
      for r in select value from jsonb_array_elements(coalesce(p_batch -> v_kind, '[]'::jsonb)) loop
        v_key := null;
        begin
          if v_kind = 'readers' then
            v_key := r ->> 'key';
            if coalesce(v_key, '') = '' or coalesce(btrim(r ->> 'name'), '') = '' then
              raise exception 'a reader needs key and name' using errcode = '22023';
            end if;
            select id into v_id from public.homer_readers where user_id = v_uid and key = v_key;
            if v_id is null then
              insert into public.homer_readers (key, name) values (v_key, r ->> 'name');
              ins := ins + 1;
            else
              update public.homer_readers set name = r ->> 'name' where id = v_id and name is distinct from r ->> 'name';
              get diagnostics n = row_count;
              if n > 0 then upd := upd + 1; else same := same + 1; end if;
            end if;

          elsif v_kind = 'devices' then
            v_key := r ->> 'device_id';
            if coalesce(v_key, '') = '' then raise exception 'a device needs device_id' using errcode = '22023'; end if;
            v_ref := null;
            if coalesce(r ->> 'owner', '') <> '' then
              select id into v_ref from public.homer_readers where user_id = v_uid and key = r ->> 'owner';
              if v_ref is null then raise exception 'owner % is not a reader', r ->> 'owner' using errcode = '22023'; end if;
            end if;
            select id into v_id from public.homer_devices where user_id = v_uid and device_id = v_key;
            if v_id is null then
              insert into public.homer_devices (device_id, family, friendly_name, reader_id, owner_reason,
                                                first_session, last_session, sessions, hours)
              values (v_key, r ->> 'family', r ->> 'friendly_name', v_ref, r ->> 'owner_reason',
                      (r ->> 'first_session')::date, (r ->> 'last_session')::date,
                      (r ->> 'sessions')::int, (r ->> 'hours')::numeric);
              ins := ins + 1;
            else
              -- An owner in the batch is set; a missing one never clears an owner Alex confirmed since.
              update public.homer_devices d
                 set family = r ->> 'family', friendly_name = r ->> 'friendly_name',
                     reader_id = coalesce(v_ref, d.reader_id),
                     owner_reason = case when v_ref is not null then r ->> 'owner_reason' else d.owner_reason end,
                     first_session = (r ->> 'first_session')::date, last_session = (r ->> 'last_session')::date,
                     sessions = (r ->> 'sessions')::int, hours = (r ->> 'hours')::numeric
               where d.id = v_id
                 and (d.family, d.friendly_name, d.reader_id, d.owner_reason, d.first_session, d.last_session, d.sessions, d.hours)
                     is distinct from
                     (r ->> 'family', r ->> 'friendly_name', coalesce(v_ref, d.reader_id),
                      case when v_ref is not null then r ->> 'owner_reason' else d.owner_reason end,
                      (r ->> 'first_session')::date, (r ->> 'last_session')::date,
                      (r ->> 'sessions')::int, (r ->> 'hours')::numeric(8,1));
              get diagnostics n = row_count;
              if n > 0 then upd := upd + 1; else same := same + 1; end if;
            end if;

          elsif v_kind = 'series' then
            v_key := coalesce(nullif(r ->> 'series_asin', ''), r ->> 'name');
            if coalesce(btrim(r ->> 'name'), '') = '' then raise exception 'a series needs a name' using errcode = '22023'; end if;
            if coalesce(r ->> 'series_asin', '') <> '' then
              select id into v_id from public.homer_series where user_id = v_uid and series_asin = r ->> 'series_asin';
            else
              select id into v_id from public.homer_series where user_id = v_uid and series_asin is null and lower(name) = lower(r ->> 'name');
            end if;
            if v_id is null then
              insert into public.homer_series (name, series_asin, author)
              values (r ->> 'name', nullif(r ->> 'series_asin', ''), r ->> 'author');
              ins := ins + 1;
            else
              update public.homer_series s set name = r ->> 'name', author = coalesce(r ->> 'author', s.author)
               where s.id = v_id and (s.name, s.author) is distinct from (r ->> 'name', coalesce(r ->> 'author', s.author));
              get diagnostics n = row_count;
              if n > 0 then upd := upd + 1; else same := same + 1; end if;
            end if;

          elsif v_kind = 'books' then
            v_key := r ->> 'asin';
            if coalesce(v_key, '') = '' or coalesce(btrim(r ->> 'title'), '') = '' then
              raise exception 'a book needs asin and title' using errcode = '22023';
            end if;
            v_series := null;
            if coalesce(r ->> 'series_asin', '') <> '' then
              select id into v_series from public.homer_series where user_id = v_uid and series_asin = r ->> 'series_asin';
              if v_series is null then raise exception 'series % not found', r ->> 'series_asin' using errcode = '22023'; end if;
            elsif coalesce(r ->> 'series_name', '') <> '' then
              select id into v_series from public.homer_series
               where user_id = v_uid and series_asin is null and lower(name) = lower(r ->> 'series_name');
              if v_series is null then raise exception 'series "%" not found', r ->> 'series_name' using errcode = '22023'; end if;
            end if;
            select id into v_id from public.homer_books where user_id = v_uid and asin = v_key;
            if v_id is null then
              insert into public.homer_books (asin, title, author, series_id, series_position, acquired, content_type)
              values (v_key, r ->> 'title', r ->> 'author', v_series, (r ->> 'series_position')::numeric,
                      r ->> 'acquired', r ->> 'content_type');
              ins := ins + 1;
            else
              update public.homer_books b
                 set title = r ->> 'title', author = r ->> 'author', series_id = v_series,
                     series_position = (r ->> 'series_position')::numeric, acquired = r ->> 'acquired',
                     content_type = r ->> 'content_type'
               where b.id = v_id
                 and (b.title, b.author, b.series_id, b.series_position, b.acquired, b.content_type)
                     is distinct from
                     (r ->> 'title', r ->> 'author', v_series, (r ->> 'series_position')::numeric(6,2),
                      r ->> 'acquired', r ->> 'content_type');
              get diagnostics n = row_count;
              if n > 0 then upd := upd + 1; else same := same + 1; end if;
            end if;

          else -- reads
            v_key := r ->> 'import_key';
            if coalesce(v_key, '') = '' then raise exception 'a read needs import_key' using errcode = '22023'; end if;
            select id into v_ref from public.homer_books where user_id = v_uid and asin = r ->> 'asin';
            if v_ref is null then raise exception 'book % not found', r ->> 'asin' using errcode = '22023'; end if;
            v_ref2 := null;
            if coalesce(r ->> 'device_id', '') <> '' then
              select id into v_ref2 from public.homer_devices where user_id = v_uid and device_id = r ->> 'device_id';
              if v_ref2 is null then raise exception 'device % not found', r ->> 'device_id' using errcode = '22023'; end if;
            end if;
            select id into v_id from public.homer_reads where user_id = v_uid and import_key = v_key;
            if v_id is null then
              -- reader_id is left to homer_reads_fill_reader: the device's owner, or null.
              insert into public.homer_reads (book_id, device_id, started_on, finished_on, hours, completion, source, import_key)
              values (v_ref, v_ref2, (r ->> 'started_on')::date, (r ->> 'finished_on')::date, (r ->> 'hours')::numeric,
                      nullif(r ->> 'completion', ''), 'export', v_key);
              ins := ins + 1;
            else
              -- The reader is never touched here: it follows the device, or Alex set it by hand.
              update public.homer_reads x
                 set book_id = v_ref, device_id = v_ref2, started_on = (r ->> 'started_on')::date,
                     finished_on = (r ->> 'finished_on')::date, hours = (r ->> 'hours')::numeric,
                     completion = nullif(r ->> 'completion', '')
               where x.id = v_id
                 and (x.book_id, x.device_id, x.started_on, x.finished_on, x.hours, x.completion)
                     is distinct from
                     (v_ref, v_ref2, (r ->> 'started_on')::date, (r ->> 'finished_on')::date,
                      (r ->> 'hours')::numeric(7,1), nullif(r ->> 'completion', ''));
              get diagnostics n = row_count;
              if n > 0 then upd := upd + 1; else same := same + 1; end if;
            end if;
          end if;
        exception when others then
          bad := bad + 1;
          v_refused := v_refused || jsonb_build_object('kind', v_kind, 'key', v_key, 'reason', sqlerrm);
        end;
      end loop;
      if p_batch ? v_kind then
        v_counts := v_counts || jsonb_build_object(v_kind,
          jsonb_build_object('inserted', ins, 'updated', upd, 'unchanged', same, 'refused', bad));
      end if;
    end loop;

    if p_dry_run then
      raise exception 'homer_import_dry_run' using errcode = 'P0H01';
    end if;
  exception when sqlstate 'P0H01' then
    null;  -- dry run: the writes are undone; the counts are kept.
  end;

  return jsonb_build_object('dry_run', p_dry_run, 'rows', v_total, 'counts', v_counts, 'refused', v_refused);
end;
$$;

comment on function public.homer_import_batch(jsonb, boolean) is
  'Homer: the single implementation of the Kindle export import. p_batch is {readers, devices, series, books, reads}, '
  'arrays of at most 500 rows in all, processed in that order and upserted by natural key (reader key, device_id, '
  'series_asin or name, asin, import_key), so a second run changes nothing. A device owner in the batch is set; a '
  'missing one never clears an existing owner. A read''s reader comes from its device (homer_reads_fill_reader) and is '
  'never overwritten. A bad row is refused with its reason and the rest go on. p_dry_run (default true) does all the '
  'work and undoes it. Returns {dry_run, rows, counts: {kind: {inserted, updated, unchanged, refused}}, refused: '
  '[{kind, key, reason}]}. Called by scripts/homer-import.mjs.';
revoke all on function public.homer_import_batch(jsonb, boolean) from public, anon;
grant execute on function public.homer_import_batch(jsonb, boolean) to authenticated;

commit;

select public.platform_check_conformance() as conformance;
