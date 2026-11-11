-- Switchboard 2.0 s87b: public.switchboard_claim_state, the current claim state of each repo: who holds which file,
-- folder and db: item, under which project code and since when, and the waiting requests. One row per user and repo,
-- replaced whole each time a claim changes (claim, release, yield, cleanup, gitpush checkpoint or finish). Nothing
-- posts on a timer. Written only by overwatch-ingest (service role, s87d) from events the claims code queues (s87f);
-- read by the get_claim_state tool (s87e) through ctx.db with owner RLS. claim_blocks (167) keeps the history of
-- block episodes; this keeps only now.
-- Kind: schema change (new table, registered). Spec: docs/technical-spec-switchboard2-h8r.md 11.8.

create table if not exists public.switchboard_claim_state (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users (id),
  repo         text        not null,
  claims       jsonb       not null default '[]'::jsonb,
  blocks       jsonb       not null default '[]'::jsonb,
  posted_at    timestamptz not null,
  source_host  text,
  updated_at   timestamptz not null default now(),

  constraint switchboard_claim_state_repo_key unique (user_id, repo),
  constraint switchboard_claim_state_repo_length check (length(repo) between 1 and 300),
  constraint switchboard_claim_state_claims_array check (jsonb_typeof(claims) = 'array'),
  constraint switchboard_claim_state_blocks_array check (jsonb_typeof(blocks) = 'array'),
  constraint switchboard_claim_state_host_length check (source_host is null or length(source_host) between 1 and 100)
);

comment on table public.switchboard_claim_state is
  'SWITCHBOARD. The current claims of one repo, one row per user and repo, replaced whole on every claim change '
  '(claim, release, yield, cleanup, gitpush checkpoint or finish); never on a timer. Written only by overwatch-ingest '
  '(service role) from the claims code''s events; read by get_claim_state. History of blocks is in claim_blocks. '
  'Spec: docs/technical-spec-switchboard2-h8r.md 11.8.';
comment on column public.switchboard_claim_state.id is 'Row id.';
comment on column public.switchboard_claim_state.user_id is
  'Owner. Set explicitly by overwatch-ingest from CLIPBOARD_USER_ID, since it writes with the service role. Owner RLS '
  'scopes every read.';
comment on column public.switchboard_claim_state.repo is
  'The repo, as its repos.json key: the main checkout''s absolute path, e.g. C:\Users\Alex\projects\alfred-v5.';
comment on column public.switchboard_claim_state.claims is
  'Holdings, a json array of {item, owner, kind, claimed_at}: item is the repo-relative file or folder or a db: item, '
  'owner the holding project code (main for the main checkout), kind file, folder or db.';
comment on column public.switchboard_claim_state.blocks is
  'Waiting requests still in force, a json array of {waiter, holder, item, since}: the project refused, the project '
  'holding the item, the item, and when the first refusal was.';
comment on column public.switchboard_claim_state.posted_at is
  'When the claims code wrote this state (the change''s own time). An older post never replaces a newer one.';
comment on column public.switchboard_claim_state.source_host is
  'The computer the claims code ran on, when it knows it; null otherwise.';
comment on column public.switchboard_claim_state.updated_at is 'When overwatch-ingest last wrote the row.';

-- Not audited: every change is a full-state upsert, so the audit log would copy the whole state on each claim; the
-- row holds only now, and claim_blocks keeps the history that matters.
select platform.register_table(
  'public.switchboard_claim_state',
  p_audited => false
);
