-- Purpose: Homer slice 1 (homer-h4k, phase F). The Homer tab exists at /homer, so the existing apps row 'homer'
-- (migration 181) gets its path and button name. Overwatch and the pickers then treat Homer as an app with a screen.
-- Kind: data change (1 row in public.apps). No schema change.
-- Applied: NO
--
-- Spec: docs/homer-spec-homer-h4k.md phase F. Safe to re-run: it sets the same two values.
-- Note: the nav tabs are a list in src/shared/AppChrome.jsx and don't read apps.button_name yet (migration 116).
-- supabase/migrations/230_homer_screen.sql

begin;

update public.apps
   set path = '/homer', button_name = 'Homer'
 where id = 'homer';

commit;

select public.platform_check_conformance() as conformance;
