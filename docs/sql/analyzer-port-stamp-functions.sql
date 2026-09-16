-- Analyzer port — what are bump_parent_edited_at and stamp_song_edited?
-- Read-only. One query, one JSON result.
--
-- triggers_calling_them checks EVERY table, not just the two SAM tables:
-- no stamp_song_edited entry there means it is attached to nothing.

select json_build_object(

  'functions', (select json_agg(t) from (
    select p.proname                         as function,
           pg_get_function_result(p.oid)     as returns,
           p.prosecdef                       as security_definer,
           obj_description(p.oid, 'pg_proc') as comment,
           pg_get_functiondef(p.oid)         as definition
    from pg_proc p
    where p.proname in ('bump_parent_edited_at', 'stamp_song_edited')
  ) t),

  'triggers_calling_them', (select json_agg(t) from (
    select c.relname                 as "table",
           tg.tgname                 as trigger,
           p.proname                 as function,
           pg_get_triggerdef(tg.oid) as definition
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_proc p on p.oid = tg.tgfoid
    where p.proname in ('bump_parent_edited_at', 'stamp_song_edited')
  ) t),

  'callers_of_stamp_song_edited', (select json_agg(t) from (
    select proname as function
    from pg_proc
    where prosrc ilike '%stamp_song_edited%' and proname <> 'stamp_song_edited'
  ) t)

) as result;
