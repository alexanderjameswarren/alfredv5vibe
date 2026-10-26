-- Purpose: Overwatch Step 35f. Three new apps (switchboard, monty_don, sports) and app tags on 29 Alfred items and
-- intentions, so the /overwatch tab's Ideas section can group them by app.
-- Kind: one-off data change (three apps rows; tags appended to existing items and intentions; no schema change)
-- Applied: YES, by hand in the Supabase SQL editor on 2026-10-26 (result: 3 apps added; 11 items and 18 intentions
-- tagged). This file is the record. Do not run it again; it is idempotent if it is run (the inserts do nothing on
-- conflict, and a tag is appended only when the row does not already carry it).
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 9 (Ideas).
-- supabase/migrations/179_apps_switchboard_monty_don_sports_and_idea_app_tags.sql

begin;

-- ============================================================================
-- 1. The apps
-- ============================================================================
insert into public.apps (id, name, description, icon, path, button_name) values
  ('switchboard', 'Switchboard',
   'The desktop panel that monitors parallel Claude Code CLI sessions and pairs each with its claude.ai window: its features, bugs and workflow.',
   'Cable', null, null),
  ('monty_don', 'Monty Don',
   'Gardening assistant: balcony container garden, plants, care and seasonal tasks.',
   'Sprout', null, null),
  ('sports', 'Sports',
   'Sports following: games to watch, teams, schedules and a daily sports update.',
   'Trophy', null, null)
on conflict do nothing;

-- ============================================================================
-- 2. App tags, appended only when absent (an id may be an item or an intention)
-- ============================================================================
with tagged (tag, ids) as (values
  ('alfred', array['mtu5zrzmjhyw84l3ren', 'mtu60uyr0zr6gysefkel', 'mtu6awbfta0uea5vzlq', 'mtu6b07bazqx0kdyaz',
                   'mu1hik6212ytper92y4j', 'mufmsv94o5v1dbenbd', 'muh9uw9as8m0k93rp5', 'muh9vl7pc9u8pmnsuqi',
                   'muk23pbqxbokqkbjah', 'mvmlv6eftryndmkal4g', 'mpblyozzfp72gwpb80l', 'mufmsvt0myzmltifwk',
                   'muogfoprxwqwjrwnwxo', 'mv46c24t18jzh4t8vae', 'mvil0r9sdwxd9sde63c', 'mvil0vc6qxub6ojs6u',
                   'mvl0cm81qk1ifabwey', 'mvl1vspnz949jdfcjwp', 'mvmluwh8pgi0ss22ve', 'mvmlv1pcem4ebg1n2is',
                   'mvmlv6eftl6m096725e']),
  ('overwatch', array['mpblyaylwfi6j22dx0k', 'mvk8s1ookd3m37u947h']),
  ('switchboard', array['mvdudugv221h68vrul2', 'mvjiutzlfpdwaehg8t7', 'mvjivadog6y1y1l8aqr']),
  ('monty_don', array['mvl1vhdb6b6dgf1ax4j', 'mvl1vhdbvjy9nhmlfc']),
  ('sports', array['mvjiuzj64klp82mbmho'])
)
update public.items i
   set tags = array_append(i.tags, t.tag)
  from tagged t
 where i.id = any (t.ids) and not (t.tag = any (i.tags));

with tagged (tag, ids) as (values
  ('alfred', array['mtu5zrzmjhyw84l3ren', 'mtu60uyr0zr6gysefkel', 'mtu6awbfta0uea5vzlq', 'mtu6b07bazqx0kdyaz',
                   'mu1hik6212ytper92y4j', 'mufmsv94o5v1dbenbd', 'muh9uw9as8m0k93rp5', 'muh9vl7pc9u8pmnsuqi',
                   'muk23pbqxbokqkbjah', 'mvmlv6eftryndmkal4g', 'mpblyozzfp72gwpb80l', 'mufmsvt0myzmltifwk',
                   'muogfoprxwqwjrwnwxo', 'mv46c24t18jzh4t8vae', 'mvil0r9sdwxd9sde63c', 'mvil0vc6qxub6ojs6u',
                   'mvl0cm81qk1ifabwey', 'mvl1vspnz949jdfcjwp', 'mvmluwh8pgi0ss22ve', 'mvmlv1pcem4ebg1n2is',
                   'mvmlv6eftl6m096725e']),
  ('overwatch', array['mpblyaylwfi6j22dx0k', 'mvk8s1ookd3m37u947h']),
  ('switchboard', array['mvdudugv221h68vrul2', 'mvjiutzlfpdwaehg8t7', 'mvjivadog6y1y1l8aqr']),
  ('monty_don', array['mvl1vhdb6b6dgf1ax4j', 'mvl1vhdbvjy9nhmlfc']),
  ('sports', array['mvjiuzj64klp82mbmho'])
)
update public.intents n
   set tags = array_append(n.tags, t.tag)
  from tagged t
 where n.id = any (t.ids) and not (t.tag = any (n.tags));

commit;

-- ============================================================================
-- 3. Check
-- ============================================================================
select json_build_object(
  'new_apps', (select coalesce(json_agg(t), '[]'::json) from (
      select id, name, icon from public.apps where id in ('switchboard', 'monty_don', 'sports') order by id) t),
  'tagged', (select coalesce(json_agg(t), '[]'::json) from (
      select tag, (select count(*) from public.items where tag = any (tags)) as items,
             (select count(*) from public.intents where tag = any (tags)) as intents
        from unnest(array['alfred', 'overwatch', 'switchboard', 'monty_don', 'sports']) as tag) t),
  'conformance', public.platform_check_conformance()
) as result;
