-- 011 - add the `utility` playlist kind
--
-- ============================================================================
-- WHY. FIFTEEN REAL PLAYLISTS HAD NOWHERE TO GO.
-- ============================================================================
-- The library holds 41 owned playlists. kind was concert | artist | jazz |
-- discovery, and fifteen of them fit none of those: General Running (223),
-- Yoga (156), Elise's fun list (379), Family party (123), Massage (83), 5K (88),
-- New 10K (45), Half Marathon (43), Old Half Marathon (43), Awesome (95),
-- Nightmare before Christmas (29), Sex education (18), Alex Running (16),
-- Alex 2019 5K (13), sleep (1).
--
-- ⚠️ THE TEMPTING WORKAROUND IS THE DAMAGING ONE. Filing them under `discovery`
-- would have typechecked and broken nothing visibly - and it would have quietly
-- destroyed the one category DJ uses to FIND NEW ARTISTS. A "discovery" set that
-- is 60% running playlists is not a weaker signal, it is a wrong one, and
-- nothing downstream would report the corruption.
--
-- ============================================================================
-- WHAT `utility` MEANS: RECORDED, NEVER PROPOSED AGAINST
-- ============================================================================
-- kind now decides how much of DJ applies to a playlist:
--
--   concert                    full weekly treatment - setlist diff, cram list,
--                              linked to a dj_concerts row
--   artist / jazz / discovery  engagement metrics, occasional proposals
--   utility                    recorded and measured, never suggested against
--
-- Recording them is still worth it, for two reasons that have nothing to do with
-- proposals. Engagement numbers need a baseline - "you ran this 3 times" means
-- nothing without knowing what normal looks like across the library. And track
-- resolution is cumulative and shared: seeding the 30-track Foo Fighters
-- playlist on 2026-09-01 created ZERO new dj_tracks rows, because plays had
-- already populated every one. Recording 379 tracks of Elise's fun list pays
-- into every future resolution, concert playlists included.
--
-- ============================================================================
-- WHAT THIS DOES NOT CHANGE
-- ============================================================================
-- dj_playlists_concert_link is `kind = 'concert' OR concert_id IS NULL`, so a
-- utility playlist already cannot carry a concert_id. No edit needed, and that
-- is checked below rather than assumed - "unchanged by inspection" is how a
-- constraint quietly stops meaning what it says.
--
-- ⚠️ THE TOOLS DO NOT KNOW ABOUT THIS YET. record_dj_playlist and
-- get_dj_managed_playlists both declare kind as a four-value enum in their
-- input_schema. Until those are redeployed, the database accepts `utility` and
-- the only tool that could write it refuses. Widening the CHECK without shipping
-- the tools is a half-done change - see the deploy note at the end of this file.

alter table public.dj_playlists
  drop constraint if exists dj_playlists_kind_check;

alter table public.dj_playlists
  add constraint dj_playlists_kind_check
  check (kind = any (array['concert', 'artist', 'jazz', 'discovery', 'utility']));

comment on column public.dj_playlists.kind is
  'concert | artist | jazz | discovery | utility. Only kind=concert has a setlist '
  'body and therefore a cram block; the rest are flat. '
  'utility means RECORDED BUT NEVER PROPOSED AGAINST - running, yoga, massage, '
  'sleep, party and soundtrack playlists that DJ measures for engagement but '
  'never suggests changes to. It exists so those do not have to be mislabelled '
  '`discovery`, which is a category DJ actually uses to find new artists and '
  'which fifteen activity playlists would have swamped. '
  '⚠️ kind is what decides how much of DJ applies to a playlist, so choosing it '
  'is a semantic act, not a label: concert gets the weekly setlist diff and cram '
  'list, artist/jazz/discovery get metrics and occasional proposals, utility '
  'gets metrics only.';

-- ---------------------------------------------------------------------------
-- VERIFY - the new value is accepted, an invalid one is still refused, and the
-- concert-link rule still holds for the new kind.
-- ---------------------------------------------------------------------------
do $$
declare
  utility_ok       boolean := false;
  nonsense_refused boolean := false;
  link_refused     boolean := false;
  why              text;
begin
  -- ⚠️ Each probe RECORDS its outcome and the verdicts are passed afterwards.
  -- A `raise exception` inside one of these blocks would be caught by its own
  -- `when others` and downgraded to a notice (spec 11.19).
  --
  -- All three write inside a plpgsql BEGIN/EXCEPTION subtransaction, so the two
  -- that are meant to fail undo themselves; the one that succeeds is deleted
  -- explicitly. No playlist row survives this migration.
  --
  -- ⚠️ THE AUDIT LOG DOES KEEP A TRACE, AND THAT IS NOT A BUG TO FIX SILENTLY.
  -- dj_playlists is audited => true, so the successful probe's INSERT and DELETE
  -- both write audit rows that outlive the playlist row. Anyone reading the
  -- audit trail later will see a '__migration_probe__' playlist appear and
  -- vanish. The name is deliberately unmistakable for exactly that moment.
  -- Suppressing the trigger to keep the log tidy would mean a migration that
  -- writes to an audited table without being audited, which is a worse trade.
  begin
    insert into public.dj_playlists (user_id, name, kind)
    values (gen_random_uuid(), '__migration_probe__', 'utility');
    utility_ok := true;
    -- Undo the row that WORKED. The failing probes undo themselves.
    delete from public.dj_playlists where name = '__migration_probe__';
  exception
    when others then why := sqlerrm;
  end;

  -- The negative control: the CHECK must still REJECT something, or it is not a
  -- CHECK. Widening a constraint by dropping and re-adding it is exactly where a
  -- typo produces `check (true)` and nothing ever complains again.
  begin
    insert into public.dj_playlists (user_id, name, kind)
    values (gen_random_uuid(), '__migration_probe_bad__', 'not_a_kind');
    delete from public.dj_playlists where name = '__migration_probe_bad__';
  exception
    when check_violation then nonsense_refused := true;
    when others          then null;
  end;

  -- And the untouched rule, exercised rather than eyeballed: a non-concert
  -- playlist may not carry a concert_id.
  begin
    insert into public.dj_playlists (user_id, name, kind, concert_id)
    values (gen_random_uuid(), '__migration_probe_link__', 'utility',
            gen_random_uuid());
    delete from public.dj_playlists where name = '__migration_probe_link__';
  exception
    when check_violation   then link_refused := true;
    when foreign_key_violation then link_refused := true;  -- also a refusal
    when others            then null;
  end;

  if not utility_ok then
    raise exception 'dj_playlists_kind_check still rejects ''utility'' (%). The '
      'import cannot record activity playlists.', coalesce(why, 'unknown');
  end if;
  if not nonsense_refused then
    raise exception 'dj_playlists_kind_check ACCEPTED ''not_a_kind''. The '
      'constraint was widened into a constraint that checks nothing.';
  end if;
  if not link_refused then
    raise exception 'a utility playlist was allowed to carry a concert_id - '
      'dj_playlists_concert_link is no longer enforcing the concert-only rule.';
  end if;

  -- Belt and braces: no probe row survived any path.
  if exists (select 1 from public.dj_playlists
              where name like '__migration_probe%') then
    raise exception 'a migration probe row was left behind in dj_playlists.';
  end if;

  if exists (select 1 from platform.conformance_failures) then
    raise exception 'platform.conformance_failures is not empty after this '
      'migration. Run: select * from platform.conformance_failures;';
  end if;

  raise notice 'dj_playlists kind check verified: utility accepted, nonsense '
    'refused, concert-link rule intact.';
end $$;

-- Belt and braces, from a tool call rather than SQL:
--   check_platform_conformance   ->  must report CONFORMANT (28 tables)
--
-- ⚠️ THEN DEPLOY THE TOOLS, OR THIS MIGRATION IS INERT:
--   _shared/alfred-tools/  record_dj_playlist        kind enum + 'utility'
--                          get_dj_managed_playlists  kind filter enum + 'utility'
--                          create_dj_concert         starts_on no longer required
--                                                    (migration 010)
--   npx supabase functions deploy mcp --no-verify-jwt
