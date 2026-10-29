-- Purpose: gmail_capture-h3w step 4. email_capture_senders: who may send or auto-forward mail into a capture
-- address (alfred@, recipes@, alex.warren+alfred@, alfred+<tag>@). Read by the email-capture Edge Function's Gmail
-- branch with the service role; replaces the hard-coded FROM_ALLOWLIST once Postmark is removed. Separate from
-- allowed_emails on purpose: a row there grants Alfred sign-in, and a forwarder must never get a login.
-- Kind: schema change (one new table, registered) plus three seed rows
-- Applied: NO — not yet run.
--
-- Spec: docs/technical-spec-gmail-capture.md, "Table email_capture_senders". Run as one block in the SQL editor.
-- Safe to re-run: table, constraints, trigger, registration and seed rows are idempotent.
-- supabase/migrations/185_gmail_capture_email_capture_senders.sql

begin;

-- The seed rows are owned by Alex; stop rather than seed nothing.
do $$
begin
  if not exists (select 1 from auth.users where lower(email) = 'alexanderjameswarren@gmail.com') then
    raise exception 'email_capture_senders: no auth user alexanderjameswarren@gmail.com to own the seed rows';
  end if;
end $$;

-- ============================================================================
-- 1. email_capture_senders
-- ============================================================================
create table if not exists public.email_capture_senders (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null default auth.uid() references auth.users (id),
  email              text        not null,
  safe_sender        boolean     not null default false,
  approved_forwarder boolean     not null default false,
  label              text        not null,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint email_capture_senders_email_key unique (email),
  constraint email_capture_senders_email_lower check (email = lower(btrim(email)) and email like '%_@_%'),
  constraint email_capture_senders_has_role check (safe_sender or approved_forwarder),
  constraint email_capture_senders_label_present check (length(btrim(label)) > 0)
);

comment on table public.email_capture_senders is
  'EMAIL CAPTURE. Who may get mail into Alfred through a capture address (alfred@, recipes@, alex.warren+alfred@, '
  'alfred+<tag>@secorus.com). One row per address. safe_sender: mail FROM this address to a capture address is '
  'accepted when Google''s Authentication-Results pass (DMARC, or aligned DKIM). approved_forwarder: mail '
  'auto-forwarded BY this account into a capture address is accepted, whoever the original sender. To add one: '
  'insert a row with the lower-case address, at least one role, and a label saying whose it is. Mail labelled alfred '
  'that was not sent to a capture address does not need a row. Read by the email-capture Edge Function (service '
  'role). Not allowed_emails, which grants sign-in. Spec: docs/technical-spec-gmail-capture.md.';
comment on column public.email_capture_senders.id is 'Row id.';
comment on column public.email_capture_senders.user_id is 'Owner (the Alfred user who maintains the list). Owner RLS.';
comment on column public.email_capture_senders.email is 'The address, lower-case and trimmed. Unique.';
comment on column public.email_capture_senders.safe_sender is
  'True: mail From this address to a capture address is accepted if Google''s sender checks pass.';
comment on column public.email_capture_senders.approved_forwarder is
  'True: mail this account auto-forwards into a capture address is accepted (Gmail +caf_ envelope or X-Forwarded-For).';
comment on column public.email_capture_senders.label is 'Whose address this is, e.g. "Alex (secorus)", "Elise".';
comment on column public.email_capture_senders.notes is 'Free text: why the row exists, when it was added.';
comment on column public.email_capture_senders.created_at is 'Row creation.';
comment on column public.email_capture_senders.updated_at is 'Last change. Stamped by the set_updated_at trigger.';

drop trigger if exists set_updated_at on public.email_capture_senders;
create trigger set_updated_at before update on public.email_capture_senders
  for each row execute function public.update_updated_at();

-- ============================================================================
-- 2. Register: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table('public.email_capture_senders', p_policy_mode => 'owner', p_audited => true,
  p_exempt => false,
  p_notes => 'App: Alfred (email capture). Safe senders and approved forwarders for capture addresses; read by email-capture.');

-- ============================================================================
-- 3. Seed rows
-- ============================================================================
insert into public.email_capture_senders (user_id, email, safe_sender, approved_forwarder, label, notes)
select u.id, s.email, true, true, s.label, s.notes
  from auth.users u
 cross join (values
   ('alex.warren@secorus.com', 'Alex (secorus)', 'Seeded by migration 185.'),
   ('alexanderjameswarren@gmail.com', 'Alex (gmail)', 'Seeded by migration 185.'),
   ('enhdesigns@gmail.com', 'Elise', 'Seeded by migration 185. Hand forwards and auto-forwards.')
 ) as s (email, label, notes)
 where lower(u.email) = 'alexanderjameswarren@gmail.com'
on conflict (email) do nothing;

commit;

-- ============================================================================
-- 4. Result: columns and comments, registration, grants, seed rows, conformance (CONFORMANT)
-- ============================================================================
select json_build_object(
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as columns,
             count(*) filter (where col_description(a.attrelid, a.attnum) is null) as without_comment
        from pg_attribute a
       where a.attrelid = 'public.email_capture_senders'::regclass and a.attnum > 0 and not a.attisdropped
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read from platform.registry
       where table_name = 'public.email_capture_senders'
    ) t),
  'grants', (select coalesce(json_agg(t), '[]'::json) from (
      select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'email_capture_senders'
       group by grantee order by grantee
    ) t),
  'seed_rows', (select coalesce(json_agg(t), '[]'::json) from (
      select email, safe_sender, approved_forwarder, label from public.email_capture_senders order by email
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
