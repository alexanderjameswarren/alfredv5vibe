-- schema snapshot 2026-10-20 15:44, through migration 142 (supabase db dump --linked --schema public,platform)



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE SCHEMA IF NOT EXISTS "platform";


ALTER SCHEMA "platform" OWNER TO "postgres";


COMMENT ON SCHEMA "platform" IS 'Platform contract v1 — shared infrastructure for all MCP-backed apps (Alfred, SAM, Ken, ...).

RULES FOR ANY NEW TABLE:
  1. Every migration that creates a table MUST end with a schema-qualified call:
       select platform.register_table(''public.my_table'');
     This enables RLS, creates the owner policy, issues the grants required by
     Supabase from Oct-2026 onward, strips all privileges from anon, attaches the
     audit trigger, and records the table in platform.registry.
  2. Full signature (all params p_-prefixed):
       select platform.register_table(
         ''public.my_table'',
         p_policy_mode => ''owner'',  -- ''none'' when the table has no user_id column
         p_audited     => true,       -- false ONLY for high-volume append-only telemetry
         p_exempt      => false,      -- true only for contract-exempt tables (e.g. allowed_emails)
         p_notes       => ''App: what this table is''
       );
     Pass ''public.'' explicitly — the param is regclass and an unqualified name
     resolves via search_path, which works in the SQL editor but drifts elsewhere.
  3. p_policy_mode => ''owner'' generates a user_id = auth.uid() policy, type-aware
     (uuid vs text). Use ''none'' in two cases: (a) the table has custom RLS such as
     Alfred''s shared contexts, or (b) the table has NO user_id column and reaches
     ownership through a parent (SAM''s per-song child tables). For (b), register with
     ''none'' then write the parent-scoped policy yourself, mirroring sam_song_lyrics:
       exists (select 1 from parent p where p.id = child.parent_id and p.user_id = auth.uid())
     register_table still enables RLS, grants, anon-strip, and audit — only the
     policy is yours.

RULES FOR ANY NEW MCP TOOL:
  1. Build it with defineTool() from _shared/platform.ts. Never import the Supabase
     client directly in a tool file — ctx.db is the only DB path.
  2. Declare a write tier (blast radius, not read-vs-write):
       tier 1 = append-only insert, or update to own progress/state  -> no gate, audited
       tier 2 = update to an existing row                            -> audited, reversible
       tier 3 = destructive, superseding, or semantically significant-> requires confirmed=true
  3. Every list tool clamps limit (default 20, cap 50) with schema/handler param parity.
     Push every filter into the query before LIMIT. Exclude heavy jsonb from list reads.
     Tags are text[] (filter with .overlaps()); jsonb tags are legacy-Alfred only.
  4. Emit bare envelope.data as the MCP payload. Guardrail denials keep their verbatim
     do-not-retry wording; operational errors must not borrow it.
  5. Actor attribution rides the x-actor request header (PostgREST request.headers),
     NOT a set_config() RPC — supabase-js runs each call in its own transaction.

VERIFY WITH: select * from platform.conformance_failures;  -- empty = conformant
Run check_platform_conformance as the final step of every migration block.

When you mention any Alfred, SAM, Ken, DJ or Warren Buffet record, link it as https://alfredv5vibe.vercel.app/<id> using its id, instead of describing where to find it.';



CREATE OR REPLACE FUNCTION "platform"."audit_row"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'platform'
    AS $$
declare
  v_actor   text;
  v_headers text;
  v_old     jsonb;
  v_new     jsonb;
  v_user    text;
  v_rec     text;
begin
  -- 1. app.actor GUC, if something set it in this transaction
  v_actor := nullif(current_setting('app.actor', true), '');

  -- 2. otherwise the x-actor HTTP header, via PostgREST
  if v_actor is null then
    v_headers := current_setting('request.headers', true);
    if v_headers is not null and v_headers <> '' then
      begin
        v_actor := nullif(v_headers::json ->> 'x-actor', '');
      exception when others then
        v_actor := null;   -- malformed header payload: fall through
      end;
    end if;
  end if;

  -- 3. default
  v_actor := coalesce(v_actor, 'ui');

  if TG_OP = 'DELETE' then
    v_old := to_jsonb(OLD);
  elsif TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    if v_old = v_new then
      return NEW;                      -- suppress no-op updates
    end if;
  else
    v_new := to_jsonb(NEW);
  end if;

  v_rec  := coalesce(v_new ->> 'id',      v_old ->> 'id');
  v_user := coalesce(v_new ->> 'user_id', v_old ->> 'user_id');

  insert into platform.audit_log
    (user_id, table_name, record_id, op, old_row, new_row, actor)
  values
    (v_user, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_rec, TG_OP, v_old, v_new, v_actor);

  return coalesce(NEW, OLD);
end;
$$;


ALTER FUNCTION "platform"."audit_row"() OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."audit_row"() IS 'Generic audit trigger, attached by platform.register_table(). Captures before/after
images and attributes the write.

ACTOR RESOLUTION, in order:
  1. current_setting(''app.actor'') — for direct Postgres connections or a
     SECURITY DEFINER wrapper that sets it inside the same transaction.
  2. the x-actor HTTP header via PostgREST''s request.headers GUC — THIS is the
     path MCP tools use. A separate set_config() RPC does NOT work with
     supabase-js: each call is its own HTTP request and its own transaction, so
     the GUC is gone before the next query runs.
  3. ''ui'' by default.

MCP clients must be constructed with global.headers[''x-actor''] = ''claude''.

THREAT MODEL: the header is client-supplied and therefore spoofable by anyone
holding a valid token. Acceptable against a two-person email allowlist — this is
attribution for debugging and rollback, not an authentication boundary.';



CREATE OR REPLACE FUNCTION "platform"."check_call_budget"("p_user_id" "text", "p_tool" "text", "p_args_hash" "text" DEFAULT NULL::"text", "p_window_seconds" integer DEFAULT 300, "p_max_calls" integer DEFAULT 60, "p_loop_threshold" integer DEFAULT 3, "p_loop_window_seconds" integer DEFAULT 60) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_calls   int;
  v_repeats int := 0;
begin
  -- total volume in the window, INCLUDING previously blocked attempts
  select count(*) into v_calls
    from platform.mcp_call_log
   where user_id = p_user_id
     and called_at > now() - make_interval(secs => p_window_seconds);

  -- identical-argument repeats, EXCLUDING blocked attempts
  if p_args_hash is not null then
    select count(*) into v_repeats
      from platform.mcp_call_log
     where user_id   = p_user_id
       and tool_name = p_tool
       and args_hash = p_args_hash
       and not blocked
       and called_at > now() - make_interval(secs => p_loop_window_seconds);
  end if;

  -- (a) volume budget first — it is the harder stop
  if v_calls >= p_max_calls then
    insert into platform.mcp_call_log (user_id, tool_name, args_hash, blocked, block_reason)
    values (p_user_id, p_tool, p_args_hash, true, 'budget_exceeded');

    return jsonb_build_object(
      'allowed', false,
      'reason', 'budget_exceeded',
      'calls_in_window', v_calls + 1,
      'repeat_count', v_repeats,
      'message', format(
        'CALL BUDGET EXCEEDED — %s calls in the last %s seconds (limit %s). '
        'This call is blocked and all further calls will be blocked until the window clears. '
        'Do NOT retry. Stop immediately, report to the user what you were attempting, '
        'and ask how they want to proceed.',
        v_calls, p_window_seconds, p_max_calls)
    );
  end if;

  -- (b) loop detection
  if v_repeats >= p_loop_threshold then
    insert into platform.mcp_call_log (user_id, tool_name, args_hash, blocked, block_reason)
    values (p_user_id, p_tool, p_args_hash, true, 'loop_detected');

    return jsonb_build_object(
      'allowed', false,
      'reason', 'loop_detected',
      'calls_in_window', v_calls + 1,
      'repeat_count', v_repeats,
      'message', format(
        'LOOP DETECTED. You have called %s with identical arguments %s times in %s seconds. '
        'This call is blocked. Do NOT retry — retrying will not change the result. '
        'Stop, summarize what you have learned so far, and report the situation to the user.',
        p_tool, v_repeats, p_loop_window_seconds)
    );
  end if;

  -- (c) allowed
  insert into platform.mcp_call_log (user_id, tool_name, args_hash, blocked)
  values (p_user_id, p_tool, p_args_hash, false);

  return jsonb_build_object(
    'allowed', true,
    'reason', null,
    'calls_in_window', v_calls + 1,
    'repeat_count', v_repeats,
    'message', null
  );
end;
$$;


ALTER FUNCTION "platform"."check_call_budget"("p_user_id" "text", "p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer, "p_loop_threshold" integer, "p_loop_window_seconds" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."check_call_budget"("p_user_id" "text", "p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer, "p_loop_threshold" integer, "p_loop_window_seconds" integer) IS 'Called at the top of EVERY MCP tool via defineTool(). Two independent guards:
volume budget (60 calls / 5min, counting blocked attempts) and loop detection
(same tool + same args 3x in 60s, counting successful calls only). Logs every
call, allowed or refused.

Returns calls_in_window (total) and repeat_count (identical args) as separate
fields — they are different quantities and were previously conflated.

The `message` field is deliberately written in terminal, do-not-retry language.
Models retry on ambiguous failures like "429" — they stop on explicit instructions
to stop. Do not soften this wording.';



CREATE OR REPLACE FUNCTION "platform"."check_conformance"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_fail  int;
  v_total int;
  v_out   text;
begin
  perform platform.maybe_prune();   -- opportunistic housekeeping, ~1% of calls

  select count(*) into v_total from platform.conformance where not exempt;
  select count(*) into v_fail  from platform.conformance_failures;

  if v_fail = 0 then
    return format('CONFORMANT — all %s non-exempt public tables satisfy platform contract v1.', v_total);
  end if;

  select string_agg(
           format('  %s: %s', table_name,
             concat_ws('; ', issue_registry, issue_rls, issue_policy,
                             issue_grant, issue_audit, issue_docs)),
           E'\n' order by table_name)
    into v_out
    from platform.conformance_failures;

  return format('NON-CONFORMANT — %s of %s tables violate platform contract v1:%s%s',
                v_fail, v_total, E'\n', v_out);
end;
$$;


ALTER FUNCTION "platform"."check_conformance"() OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."check_conformance"() IS 'Human/model-readable conformance report. Surfaced as the check_platform_conformance
MCP tool and run as the final step of every migration block.';



CREATE OR REPLACE FUNCTION "platform"."maybe_prune"("p_probability" numeric DEFAULT 0.01, "p_keep_days" integer DEFAULT 7) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
declare
  v_deleted int := 0;
begin
  if random() < p_probability then
    v_deleted := platform.prune_call_log(p_keep_days);
  end if;
  return v_deleted;
end;
$$;


ALTER FUNCTION "platform"."maybe_prune"("p_probability" numeric, "p_keep_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."maybe_prune"("p_probability" numeric, "p_keep_days" integer) IS 'Probabilistic housekeeping. Runs platform.prune_call_log() ~p_probability of the
time (default 1%), otherwise an instant no-op. Called from low-traffic functions
(check_conformance, schema reads) so the call log self-trims to p_keep_days with
no external scheduler. Deliberately not tied to pg_cron — no dashboard state to
silently reset.';



CREATE OR REPLACE FUNCTION "platform"."prune_call_log"("p_keep_days" integer DEFAULT 7) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
declare v_deleted int;
begin
  delete from platform.mcp_call_log
   where called_at < now() - make_interval(days => p_keep_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


ALTER FUNCTION "platform"."prune_call_log"("p_keep_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."prune_call_log"("p_keep_days" integer) IS 'Housekeeping. Call log is operational telemetry, not history — 7 days is plenty.
Schedule via pg_cron or call opportunistically from a low-traffic tool.';



CREATE OR REPLACE FUNCTION "platform"."register_table"("p_table" "regclass", "p_policy_mode" "text" DEFAULT 'owner'::"text", "p_audited" boolean DEFAULT true, "p_exempt" boolean DEFAULT false, "p_notes" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_schema   text;
  v_name     text;
  v_full     text;
  v_uid_type text;
  v_expr     text;
  v_policy   text;
begin
  if p_policy_mode not in ('owner', 'none') then
    raise exception 'register_table: policy_mode must be ''owner'' or ''none'', got %', p_policy_mode;
  end if;

  select n.nspname, c.relname
    into v_schema, v_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;

  if v_schema is null then
    raise exception 'register_table: could not resolve %', p_table;
  end if;

  v_full := v_schema || '.' || v_name;

  -- (a) RLS always on
  execute format('alter table %I.%I enable row level security', v_schema, v_name);

  -- (b) Standard owner policy, type-aware
  if p_policy_mode = 'owner' then
    select atttypid::regtype::text
      into v_uid_type
      from pg_attribute
     where attrelid = p_table and attname = 'user_id'
       and attnum > 0 and not attisdropped;

    if v_uid_type is null then
      raise exception
        'register_table: % has no user_id column. Use policy_mode => ''none'' and write RLS by hand.',
        v_full;
    end if;

    v_expr := case when v_uid_type = 'uuid'
                   then 'user_id = auth.uid()'
                   else 'user_id = (auth.uid())::text' end;
    v_policy := v_name || '_owner_access';

    execute format('drop policy if exists %I on %I.%I', v_policy, v_schema, v_name);
    execute format(
      'create policy %I on %I.%I for all to authenticated using (%s) with check (%s)',
      v_policy, v_schema, v_name, v_expr, v_expr);
  end if;

  -- (c) Grants: authenticated gets DML; anon is explicitly stripped so a table
  --     can never ship publicly writable even if default privileges drift.
  execute format(
    'grant select, insert, update, delete on %I.%I to authenticated', v_schema, v_name);
  execute format('revoke all on %I.%I from anon', v_schema, v_name);

  -- (d) Audit trigger
  execute format('drop trigger if exists audit_trigger on %I.%I', v_schema, v_name);
  if p_audited then
    execute format(
      'create trigger audit_trigger after insert or update or delete on %I.%I
         for each row execute function platform.audit_row()', v_schema, v_name);
  end if;

  -- (e) Record it
  insert into platform.registry
    (table_name, policy_mode, audited, exempt, contract_version, notes, registered_at)
  values
    (v_full, p_policy_mode, p_audited, p_exempt, 1, p_notes, now())
  on conflict (table_name) do update set
    policy_mode      = excluded.policy_mode,
    audited          = excluded.audited,
    exempt           = excluded.exempt,
    contract_version = excluded.contract_version,
    notes            = coalesce(excluded.notes, platform.registry.notes),
    registered_at    = now();

  return format('registered %s (policy=%s, audited=%s, exempt=%s, anon stripped)',
                v_full, p_policy_mode, p_audited, p_exempt);
end;
$$;


ALTER FUNCTION "platform"."register_table"("p_table" "regclass", "p_policy_mode" "text", "p_audited" boolean, "p_exempt" boolean, "p_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."register_table"("p_table" "regclass", "p_policy_mode" "text", "p_audited" boolean, "p_exempt" boolean, "p_notes" "text") IS 'THE PAVED PATH. Every new table''s migration must end with a call to this.
Enables RLS, creates the type-aware owner policy, grants DML to authenticated,
STRIPS ALL privileges from anon, attaches the audit trigger, and records the
table in platform.registry.

  select platform.register_table(''public.ken_items'');
  select platform.register_table(''public.items'', ''none'');
  select platform.register_table(''public.allowed_emails'', ''none'', false, true);

If a table genuinely needs pre-auth anon SELECT (like allowed_emails), grant it
explicitly AFTER registering — register_table always removes anon access first.

Table name is resolved from pg_class/pg_namespace, never regclass::text (which
drops the schema when it is on the search_path).';



CREATE OR REPLACE FUNCTION "platform"."rollback_audit_entry"("p_audit_id" bigint) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  a platform.audit_log%rowtype;
  v_sql text;
begin
  select * into a from platform.audit_log where id = p_audit_id;
  if not found then
    raise exception 'rollback: audit entry % not found', p_audit_id;
  end if;

  if a.op = 'INSERT' then
    v_sql := format('delete from %s where id = %L', a.table_name, a.record_id);
  elsif a.op = 'DELETE' then
    v_sql := format('insert into %s select * from jsonb_populate_record(null::%s, %L)',
                    a.table_name, a.table_name, a.old_row);
  else -- UPDATE
    v_sql := format('update %s set (%s) = (select %s from jsonb_populate_record(null::%s, %L)) where id = %L',
                    a.table_name,
                    (select string_agg(quote_ident(key), ', ') from jsonb_object_keys(a.old_row) key),
                    (select string_agg(quote_ident(key), ', ') from jsonb_object_keys(a.old_row) key),
                    a.table_name, a.old_row, a.record_id);
  end if;

  execute v_sql;
  return format('rolled back audit #% (%s on %s)', p_audit_id, a.op, a.table_name);
end;
$$;


ALTER FUNCTION "platform"."rollback_audit_entry"("p_audit_id" bigint) OWNER TO "postgres";


COMMENT ON FUNCTION "platform"."rollback_audit_entry"("p_audit_id" bigint) IS 'Reverses a single audited change. INSERT -> delete, DELETE -> reinsert old_row,
UPDATE -> restore old_row values. Intentionally NOT exposed as an MCP tool —
rollback is a human operation run from the SQL editor or the app UI.

Find candidates with:
  select id, table_name, op, occurred_at from platform.audit_log
   where actor = ''claude'' and occurred_at > now() - interval ''1 hour''
   order by id desc;';



CREATE OR REPLACE FUNCTION "public"."alfred_recent_completions"("p_item_id" "text" DEFAULT NULL::"text", "p_intent_id" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 3) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(jsonb_agg(row_to_json(y) order by y.completed_at desc), '[]'::jsonb)
    from (
      select x.id as execution_id,
             x.intent_id,
             i.text as intent_text,
             coalesce(x.closed_at, x.started_at) as completed_at,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', n.id, 'user_id', n.user_id, 'body', n.body,
                        'created_at', n.created_at, 'updated_at', n.updated_at)
                      order by n.created_at), '[]'::jsonb)
                from notes n where n.execution_id = x.id) as notes
        from executions x
        left join intents i on i.id = x.intent_id
       where x.status = 'closed' and x.outcome = 'done'
         and ((p_intent_id is not null and x.intent_id = p_intent_id)
              or (p_item_id is not null and (x.item_ids ? p_item_id or i.item_id = p_item_id)))
       order by coalesce(x.closed_at, x.started_at) desc nulls last
       limit least(greatest(coalesce(p_limit, 3), 1), 50)
    ) y;
$$;


ALTER FUNCTION "public"."alfred_recent_completions"("p_item_id" "text", "p_intent_id" "text", "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."alfred_recent_completions"("p_item_id" "text", "p_intent_id" "text", "p_limit" integer) IS 'Alfred: the latest completed (closed + done) executions for an item (through item_ids or its intentions) or for one intention, newest first, each with its notes. Default 3, cap 50. SECURITY INVOKER: executions and notes RLS apply. Restructure P2, detail pages only.';



CREATE OR REPLACE FUNCTION "public"."apps_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."apps_touch_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."apps_touch_updated_at"() IS 'Alfred: stamps apps.updated_at.';



CREATE OR REPLACE FUNCTION "public"."bump_song_edited_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE public.sam_songs
  SET measures_edited_at = now()
  WHERE id = NEW.song_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."bump_song_edited_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "text" "text" NOT NULL,
    "due_at" timestamp with time zone NOT NULL,
    "state" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "cancel_reason" "text",
    "sent_at" timestamp with time zone,
    "inbox_id" "text",
    "intent_id" "text",
    "created_by" "text" DEFAULT 'app'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reminders_cancel_reason_check" CHECK ((("cancel_reason" IS NULL) OR ("cancel_reason" = ANY (ARRAY['manual'::"text", 'inbox_discarded'::"text", 'intent_status'::"text", 'intent_archived'::"text"])))),
    CONSTRAINT "reminders_cancel_reason_needs_cancelled" CHECK ((("cancel_reason" IS NULL) OR ("state" = 'cancelled'::"text"))),
    CONSTRAINT "reminders_created_by_check" CHECK (("created_by" = ANY (ARRAY['app'::"text", 'claude'::"text"]))),
    CONSTRAINT "reminders_one_link" CHECK (("num_nonnulls"("inbox_id", "intent_id") <= 1)),
    CONSTRAINT "reminders_state_check" CHECK (("state" = ANY (ARRAY['scheduled'::"text", 'sent'::"text", 'cancelled'::"text", 'no_subscription'::"text"])))
);


ALTER TABLE "public"."reminders" OWNER TO "postgres";


COMMENT ON TABLE "public"."reminders" IS 'ALFRED. Standalone reminders: one push notification at a fixed time, independent of any execution. Separate from notification_steps on purpose, which is chain-shaped (seq, offsets, waiting). Every reminder should be backed by something visible in Alfred, an inbox item or an intention, because Android notifications are easily suppressed or dismissed; create_reminder creates the inbox item when no link is given. Sent by the notify-dispatch Edge Function once a minute.';



COMMENT ON COLUMN "public"."reminders"."id" IS 'Surrogate key. Machine-generated, so uuid rather than Alfred''s legacy text ids.';



COMMENT ON COLUMN "public"."reminders"."user_id" IS 'Owner. The service-role dispatcher finds push_subscriptions by this column, and it is the whole of the authorisation there. Set explicitly when inserting from the SQL editor, where auth.uid() is null.';



COMMENT ON COLUMN "public"."reminders"."text" IS 'Notification body. Copied at creation, so the reminder still fires with sensible text if the linked inbox item or intention changes or disappears.';



COMMENT ON COLUMN "public"."reminders"."due_at" IS 'Absolute time to fire. The dispatcher sends a scheduled row once due_at <= now(). Changing it resets state to scheduled and clears sent_at and cancel_reason.';



COMMENT ON COLUMN "public"."reminders"."state" IS 'scheduled -> sent, or no_subscription when the user has no push_subscriptions row at due time. cancelled by update_reminder, the app, discarding the linked inbox item, or its intention leaving active or being archived (see cancel_reason). Same meanings as notification_steps.state, minus the chain-only states.';



COMMENT ON COLUMN "public"."reminders"."cancel_reason" IS 'Why a cancelled reminder was cancelled: manual (update_reminder or the app), inbox_discarded (the linked inbox item was binned), intent_status (its intention moved to background or closed and the person chose to cancel), or intent_archived (its intention was archived; reminders_follow_intent_archive). Null unless state is cancelled. Each undo restores only its own reason''s rows still in the future, which is what this column exists to tell apart.';



COMMENT ON COLUMN "public"."reminders"."sent_at" IS 'Set by the dispatcher on delivery. With state sent, it is what stops the row firing again on the next pass.';



COMMENT ON COLUMN "public"."reminders"."inbox_id" IS 'The inbox item backing this reminder, or null. ON DELETE SET NULL like source_inbox_id on items/intents/events: inbox rows are archived on triage, not deleted, so the link normally survives processing. Cleared when the item is processed into an intention (intent_id takes over). At most one of inbox_id and intent_id is set.';



COMMENT ON COLUMN "public"."reminders"."intent_id" IS 'The intention backing this reminder, or null. text, matching Alfred''s legacy ids. No FK: intents is a legacy table, as with notification_steps.execution_id. At most one of inbox_id and intent_id is set.';



COMMENT ON COLUMN "public"."reminders"."created_by" IS 'Who created the row: app or claude (through the create_reminder MCP tool).';



COMMENT ON COLUMN "public"."reminders"."created_at" IS 'Row creation.';



COMMENT ON COLUMN "public"."reminders"."updated_at" IS 'Last change. Stamped by the reminders_touch_updated_at trigger.';



CREATE OR REPLACE FUNCTION "public"."create_reminder"("p_text" "text", "p_due_at" timestamp with time zone, "p_inbox_id" "text" DEFAULT NULL::"text", "p_intent_id" "text" DEFAULT NULL::"text", "p_created_by" "text" DEFAULT 'app'::"text") RETURNS "public"."reminders"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_uid      uuid := auth.uid();
  v_text     text := btrim(coalesce(p_text, ''));
  v_inbox_id text := p_inbox_id;
  v_row      public.reminders;
begin
  if v_uid is null then
    raise exception 'create_reminder: not authenticated';
  end if;
  if v_text = '' then
    raise exception 'create_reminder: text is required';
  end if;
  if p_due_at is null then
    raise exception 'create_reminder: due_at is required';
  end if;
  if p_due_at <= now() then
    raise exception 'create_reminder: due_at % is in the past', p_due_at;
  end if;
  if p_inbox_id is not null and p_intent_id is not null then
    raise exception 'create_reminder: give inbox_id or intent_id, not both';
  end if;

  -- Under RLS a row the caller cannot see is simply absent; say so rather than
  -- link to nothing.
  if p_inbox_id is not null
     and not exists (select 1 from public.inbox where id = p_inbox_id) then
    raise exception 'create_reminder: inbox item % not found', p_inbox_id
      using errcode = 'P0002';
  end if;
  if p_intent_id is not null
     and not exists (select 1 from public.intents where id = p_intent_id) then
    raise exception 'create_reminder: intention % not found', p_intent_id
      using errcode = 'P0002';
  end if;

  if p_inbox_id is null and p_intent_id is null then
    insert into public.inbox (id, captured_text, source_type)
    values (
      gen_random_uuid()::text,
      v_text,
      case when p_created_by = 'claude' then 'mcp' else 'manual' end
    )
    returning id into v_inbox_id;
  end if;

  insert into public.reminders (user_id, text, due_at, inbox_id, intent_id, created_by)
  values (v_uid, v_text, p_due_at, v_inbox_id, p_intent_id, p_created_by)
  returning * into v_row;

  return v_row;
end;
$$;


ALTER FUNCTION "public"."create_reminder"("p_text" "text", "p_due_at" timestamp with time zone, "p_inbox_id" "text", "p_intent_id" "text", "p_created_by" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_reminder"("p_text" "text", "p_due_at" timestamp with time zone, "p_inbox_id" "text", "p_intent_id" "text", "p_created_by" "text") IS 'Alfred: create a standalone reminder. With neither p_inbox_id nor p_intent_id, first creates a backing inbox item (captured_text = text) in the same transaction, so every reminder is visible in Alfred. Rejects blank text, a past due_at, both links at once, and links the caller cannot see. Returns the reminders row.';



CREATE OR REPLACE FUNCTION "public"."dj_album_coverage"("p_status" "text" DEFAULT NULL::"text", "p_tag" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 20, "p_album_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("album_id" "uuid", "yt_album_id" "text", "title" "text", "artist" "text", "release_year" smallint, "status" "text", "tags" "text"[], "suggested_on" "date", "notes" "text", "tracks_total" integer, "tracks_playable" integer, "tracks_heard" integer, "first_heard_on" "date", "last_heard_on" "date")
    LANGUAGE "sql" STABLE
    AS $$
  with picked as (
    select a.*
    from public.dj_albums a
    where (p_album_id is not null and a.id = p_album_id)
       or (p_album_id is null
           and (p_status is null or a.status = p_status)
           and (p_tag is null or a.tags @> array[p_tag]))
  ),
  at_grp as (
    select at.album_id,
           at.position,
           at.video_id,
           coalesce(t.canonical_track_id, t.id) as grp
    from public.dj_album_tracks at
    left join public.dj_tracks t on t.video_id = at.video_id
    where at.video_id is not null
  ),
  grp_track as (
    select distinct g.album_id, g.grp, t2.id as track_id
    from at_grp g
    join public.dj_tracks t2
      on coalesce(t2.canonical_track_id, t2.id) = g.grp
    where g.grp is not null
  ),
  heard as (
    select gt.album_id,
           count(distinct gt.grp)::int as tracks_heard,
           min(p.played_on) as first_heard_on,
           max(p.played_on) as last_heard_on
    from grp_track gt
    join public.dj_plays p on p.track_id = gt.track_id
    group by gt.album_id
  ),
  sized as (
    select at.album_id,
           count(*)::int as tracks_total,
           count(at.video_id)::int as tracks_playable
    from public.dj_album_tracks at
    group by at.album_id
  )
  select pk.id, pk.yt_album_id, pk.title, pk.artist, pk.release_year,
         pk.status, pk.tags, pk.suggested_on, pk.notes,
         -- ⚠️ §14.12's control still applies: these come from a GROUPED
         -- subquery with coalesce, never count(*) over the left join.
         coalesce(s.tracks_total, 0),
         coalesce(s.tracks_playable, 0),
         coalesce(h.tracks_heard, 0),
         h.first_heard_on,
         h.last_heard_on
  from picked pk
  left join sized s on s.album_id = pk.id
  left join heard h on h.album_id = pk.id
  order by pk.status, coalesce(h.last_heard_on, '1900-01-01'::date) desc, pk.title
  limit case when p_album_id is not null then 1 else p_limit end;
$$;


ALTER FUNCTION "public"."dj_album_coverage"("p_status" "text", "p_tag" "text", "p_limit" integer, "p_album_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_album_coverage"("p_status" "text", "p_tag" "text", "p_limit" integer, "p_album_id" "uuid") IS 'Albums with "how much of this have I heard" as a FRACTION. 🛑 REPORT tracks_heard / tracks_playable, NOT a boolean. A boolean needs a threshold and then a paragraph to read correctly, which §12.12 says means printing a different number. ⚠️ TWO DENOMINATORS AND THEY DIFFER FOR A REASON. tracks_total is what the record IS; tracks_playable is what CAN be measured — YouTube gives no videoId for region-blocked tracks. Counting them caps coverage below 100 per cent forever; dropping them makes a short album look finished. SAY SO when they differ. ⚠️ COUNTS CANONICAL GROUPS, so a play of any upload counts — this measures the MUSIC, not the RECORD. It does NOT answer "have I sat through this album as an album" and would answer that confidently and wrongly. ⚠️ p_album_id (025) returns ONE album and ignores the other filters. It exists so record_dj_album can set status from coverage immediately after writing the track list — coverage is zero until the tracks exist, so the derivation cannot happen before the write.';



CREATE OR REPLACE FUNCTION "public"."dj_artist_activity"("p_window_days" integer DEFAULT 90, "p_limit" integer DEFAULT 20, "p_tag" "text" DEFAULT NULL::"text") RETURNS TABLE("artist" "text", "distinct_days" integer, "play_rows" integer, "distinct_groups" integer, "first_played_on" "date", "last_played_on" "date", "in_any_playlist" boolean, "tags" "text"[])
    LANGUAGE "sql" STABLE
    AS $$
  with active_tags as (
    select at.artist, at.tag
    from public.dj_artist_tags at
    where at.status = 'active'
  ),
  tagged as (
    select a.artist, array_agg(distinct a.tag order by a.tag) as tags
    from active_tags a
    group by a.artist
  ),
  played as (
    select t.id, t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null
      and t.artist <> ''
      and (
        p_tag is null
        or public.dj_fold_artist(t.artist) in (
          select public.dj_fold_artist(a2.artist) from active_tags a2
          where a2.tag = p_tag
        )
      )
  ),
  in_pl as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         min(pl.played_on)                 as first_played_on,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         coalesce((select tg.tags from tagged tg
                   where public.dj_fold_artist(tg.artist)
                       = public.dj_fold_artist(pl.artist)),
                  '{}'::text[])            as tags
  from played pl
  group by pl.artist
  order by count(distinct pl.played_on) desc, count(*) desc, pl.artist
  limit p_limit;
$$;


ALTER FUNCTION "public"."dj_artist_activity"("p_window_days" integer, "p_limit" integer, "p_tag" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_artist_activity"("p_window_days" integer, "p_limit" integer, "p_tag" "text") IS 'THE artist-level definition. Sections 3 and 4 of the weekly item are both this function: Section 4 unfiltered, Section 3 with p_tag => ''jazz''. 🛑 ONE FUNCTION, ONE DEFINITION, DECIDED 2026-09-02. dj_jazz_activity is dropped. Two overlapping definitions produced §14.19 — `in_playlist` and `in_any_playlist` reading opposite ways for Wes Montgomery, both correct — and would produce another one. ⚠️ Only status=''active'' tags filter or appear in `tags`. A ''rejected'' row means the artist was considered and declined; it is a decision about him, not a property of him, and it must never filter him in. ⚠️ A TAG-FILTERED READ CANNOT SEE WHAT IS UNTAGGED. Pair it with dj_tag_coverage / dj_tag_candidates or the section silently reports only what someone remembered to tag. 🛑 STILL NOT AN ARTIST IDENTITY (§14.1). Exact-string grouping on dj_tracks.artist: "Oscar Peterson Trio" and "Oscar Peterson" do not unify, collaborations appear under their full joined billing, and §14.9''s scraped byline is in the population.';



CREATE OR REPLACE FUNCTION "public"."dj_fold_artist"("p_artist" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select lower(btrim(coalesce(p_artist, '')))
$$;


ALTER FUNCTION "public"."dj_fold_artist"("p_artist" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_fold_artist"("p_artist" "text") IS 'Case/whitespace fold for comparing artist DISPLAY strings against dj_artist_tags.artist. Mirrors what normalisePart() already does inside match_key, so the two agree by construction. 🛑 NOT an artist identity — it folds spelling, never semantics: "Oscar Peterson" and "Oscar Peterson Trio" remain distinct and need a human (§14.1). ⚠️ USE IT ON BOTH SIDES OF A COMPARISON. A raw left side against a folded list never matches, so a half-applied fold silently excludes nothing — worse than no fold at all.';



CREATE OR REPLACE FUNCTION "public"."dj_playlist_engagement"("p_playlist_ids" "uuid"[], "p_window_days" integer DEFAULT 90, "p_recent_days" integer DEFAULT 30) RETURNS TABLE("playlist_id" "uuid", "distinct_groups" integer, "threshold" integer, "window_days" integer, "recent_days" integer, "runs" integer, "last_run_on" "date", "last_touched_on" "date", "touch_days" integer, "touch_days_recent" integer, "touch_days_prior" integer, "went_quiet" boolean)
    LANGUAGE "sql" STABLE
    AS $$
  with member as (
    select distinct pt.playlist_id,
           coalesce(t.canonical_track_id, t.id) as grp
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where pt.playlist_id = any(p_playlist_ids)
  ),
  sized as (
    select m.playlist_id, count(*)::int as distinct_groups
    from member m group by m.playlist_id
  ),
  thresh as (
    select s.playlist_id, s.distinct_groups,
           greatest(4, least(20, ceil(s.distinct_groups::numeric / 2)::int)) as threshold
    from sized s
  ),
  grp_track as (
    select distinct m.playlist_id, m.grp, t.id as track_id
    from member m
    join public.dj_tracks t on coalesce(t.canonical_track_id, t.id) = m.grp
  ),
  day_hits as (
    select gt.playlist_id, p.played_on,
           count(distinct gt.grp)::int as groups_played
    from grp_track gt
    join public.dj_plays p on p.track_id = gt.track_id
    where p.played_on >= current_date - p_window_days
    group by gt.playlist_id, p.played_on
  )
  select th.playlist_id,
         th.distinct_groups,
         th.threshold,
         p_window_days as window_days,
         p_recent_days as recent_days,
         -- Already correct: a null groups_played satisfies no comparison, so
         -- the filter excludes the synthesised row.
         count(*) filter (where dh.groups_played >= th.threshold)::int as runs,
         max(dh.played_on) filter (where dh.groups_played >= th.threshold) as last_run_on,
         max(dh.played_on) as last_touched_on,
         -- ⚠️ FIXED 016: count(dh.played_on), NOT count(*).
         --
         -- count(*) counts ROWS and the left join always supplies at least one,
         -- so a never-touched playlist read 1. count(<column>) counts NON-NULL
         -- VALUES and returns 0 for the same row, which is the true answer.
         --
         -- ⚠️ THE `coalesce` WAS NEVER LOAD-BEARING AND IS DROPPED, DELIBERATELY.
         -- count() never returns null, so coalesce(count(...), 0) is dead code
         -- that READS like a null guard. Leaving it would suggest the null case
         -- had been considered here, which is precisely the belief that made
         -- this defect survive a review.
         count(dh.played_on)::int as touch_days,
         count(*) filter (
           where dh.played_on >= current_date - p_recent_days)::int as touch_days_recent,
         count(*) filter (
           where dh.played_on <  current_date - p_recent_days)::int as touch_days_prior,
         -- Unchanged. `went_quiet` reads the filtered counts, which were right
         -- throughout — stated so nobody re-derives whether the fix moved it.
         (count(*) filter (
            where dh.played_on <  current_date - p_recent_days) >= 3
          and count(*) filter (
            where dh.played_on >= current_date - p_recent_days) = 0) as went_quiet
  from thresh th
  left join day_hits dh on dh.playlist_id = th.playlist_id
  group by th.playlist_id, th.distinct_groups, th.threshold;
$$;


ALTER FUNCTION "public"."dj_playlist_engagement"("p_playlist_ids" "uuid"[], "p_window_days" integer, "p_recent_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_playlist_engagement"("p_playlist_ids" "uuid"[], "p_window_days" integer, "p_recent_days" integer) IS 'Spec §12.9 plus migration 015''s rotation metrics, with 016''s count fix. runs = DAYS in the window on which at least `threshold` distinct canonical groups from the playlist were played; threshold = clamp(ceil(0.5 * distinct_groups), 4, 20). runs answers "have I LEARNED this set" and is the CONCERT metric. ⚠️ touch_days answers a different question — "is this still in ROTATION" — and counts days with ANY track, no threshold. Report the one that matches the question, never both as if they were the same idea. ⚠️ FIXED 016: touch_days is count(dh.played_on), not count(*). Over the LEFT JOIN, count(*) counted the synthesised null row and returned 1 for twelve playlists that have never been touched — indistinguishable from a playlist touched exactly once, which is the one distinction this metric exists to draw. INVARIANT, now asserted: touch_days = touch_days_recent + touch_days_prior on every row. ⚠️ went_quiet is a CHANGE, not a level: warm before the last `recent_days` (3+ touch days) and silent within them. A silence shorter than recent_days cannot fire it, deliberately. It reads the FILTERED counts and was never affected by the 015 defect. ⚠️ DAYS, NOT SESSIONS: dj_plays buckets by UTC day. ⚠️ A track in two playlists counts toward both — named, not solved.';



CREATE OR REPLACE FUNCTION "public"."dj_tag_candidates"("p_window_days" integer DEFAULT 90, "p_limit" integer DEFAULT 20) RETURNS TABLE("artist" "text", "distinct_days" integer, "play_rows" integer, "distinct_groups" integer, "last_played_on" "date", "in_any_playlist" boolean, "derivable_as" "text"[])
    LANGUAGE "sql" STABLE
    AS $$
  with kind_tag as (
    -- The whole map, in one place. See the header for why the other three
    -- playlist kinds derive nothing.
    select * from (values ('jazz', 'jazz'), ('concert', 'concert')) as m(kind, tag)
  ),
  derivable as (
    select distinct t.artist, k.tag
    from public.dj_playlists pl
    join kind_tag k on k.kind = pl.kind
    join public.dj_playlist_tracks pt on pt.playlist_id = pl.id
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  -- ⚠️ ANY TAG, ANY STATUS. An artist tagged 'concert' is categorised; an artist
  -- whose jazz tag was REJECTED is decided. Both are answers, and neither should
  -- be asked about again.
  decided as (
    select distinct at.artist from public.dj_artist_tags at
  ),
  in_pl as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  played as (
    select t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
      and public.dj_fold_artist(t.artist) not in (
            select public.dj_fold_artist(artist) from decided)
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         -- Non-null means a tag can be DERIVED rather than judged. After this
         -- migration's seed it should be empty for everyone: the seed and this
         -- expression read the same map, so a non-null here means drift.
         (select array_agg(distinct d.tag order by d.tag)
            from derivable d where d.artist = pl.artist) as derivable_as
  from played pl
  group by pl.artist
  order by (exists (select 1 from derivable d where d.artist = pl.artist)) desc,
           count(*) desc,
           count(distinct pl.played_on) desc,
           count(distinct pl.grp) desc,
           pl.artist
  limit p_limit;
$$;


ALTER FUNCTION "public"."dj_tag_candidates"("p_window_days" integer, "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_tag_candidates"("p_window_days" integer, "p_limit" integer) IS 'Played artists carrying NO tag of any kind — the weekly item''s "what are these?" proposal. 🛑 UNCATEGORISED, NOT "UNTAGGED FOR JAZZ" (changed 020). The old version excluded only artists decided for one tag, so it proposed Weezer as a jazz candidate: correct under "who lacks a jazz tag", nonsense under the heading the item actually printed. ⚠️ THE ASK IS "WHAT IS THIS?", NOT "IS THIS JAZZ?" — an open vocabulary. "Weezer -> rock" is an answer; a jazz-rejection against a question nobody would ask is not. Any answer removes the artist permanently. ⚠️ `derivable_as` NON-NULL MEANS NO JUDGEMENT IS NEEDED: playlist membership implies the tag. Write it with record_dj_artist_tag and do not ask. It should be empty in normal operation — the seeds keep it so — and a non-null row means a playlist changed since the last seed. ⚠️ ORDERED BY play_rows, the unit coverage is measured in, so the top N are the N answers that categorise the most listening.';



CREATE OR REPLACE FUNCTION "public"."dj_tag_coverage"("p_tag" "text" DEFAULT 'jazz'::"text", "p_window_days" integer DEFAULT 90) RETURNS TABLE("tag" "text", "window_days" integer, "played_artists" integer, "played_rows" integer, "tagged_active" integer, "tagged_rejected" integer, "tagged_rows" integer, "categorised_artists" integer, "categorised_rows" integer, "uncategorised_artists" integer, "uncategorised_rows" integer, "uncategorised_derivable" integer, "tagged_single_track" integer)
    LANGUAGE "sql" STABLE
    AS $$
  with rows_by_artist as (
    select t.artist, count(*)::int as play_rows
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  kind_tag as (
    select * from (values ('jazz', 'jazz'), ('concert', 'concert')) as m(kind, tag)
  ),
  derivable as (
    select distinct t.artist
    from public.dj_playlists pl
    join kind_tag k on k.kind = pl.kind
    join public.dj_playlist_tracks pt on pt.playlist_id = pl.id
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  tracks_by_artist as (
    select t.artist, count(*)::int as n
    from public.dj_tracks t
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  for_tag as (
    select at.artist, at.status
    from public.dj_artist_tags at
    where at.tag = p_tag
  ),
  categorised as (
    select distinct at.artist from public.dj_artist_tags at where at.status = 'active'
  ),
  decided as (
    select distinct at.artist from public.dj_artist_tags at
  ),
  uncategorised as (
    select r.artist, r.play_rows,
           (public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from derivable)) as is_derivable
    from rows_by_artist r
    where public.dj_fold_artist(r.artist) not in (
            select public.dj_fold_artist(artist) from decided)
  )
  select p_tag,
         p_window_days,
         (select count(*) from rows_by_artist)::int,
         (select coalesce(sum(play_rows), 0) from rows_by_artist)::int,
         (select count(*) from for_tag where status = 'active')::int,
         (select count(*) from for_tag where status = 'rejected')::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from for_tag
             where status = 'active'))::int,
         (select count(*) from rows_by_artist r
           where public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from categorised))::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where public.dj_fold_artist(r.artist) in (
             select public.dj_fold_artist(artist) from categorised))::int,
         (select count(*) from uncategorised)::int,
         (select coalesce(sum(play_rows), 0) from uncategorised)::int,
         (select count(*) from uncategorised where is_derivable)::int,
         (select count(*) from for_tag f
            join tracks_by_artist tb on tb.artist = f.artist
           where f.status = 'active' and tb.n = 1)::int;
$$;


ALTER FUNCTION "public"."dj_tag_coverage"("p_tag" "text", "p_window_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_tag_coverage"("p_tag" "text", "p_window_days" integer) IS '🛑 TWO DIFFERENT SHARES AND THEY ARE NOT INTERCHANGEABLE. CATEGORISATION (categorised_rows / played_rows) answers "how much of my listening does the system know anything about" — it moves whatever answer is given, so it is the backlog metric and the ONLY one a tagging projection may use. THE TAG SHARE (tagged_rows / played_rows) answers "how much of my listening is jazz" — a listening FACT, not a progress bar. ⚠️ A REJECTED-ONLY ARTIST IS DECIDED BUT NOT CATEGORISED, so the buckets do not sum to played_rows. ⚠️ tagged_single_track (021) COUNTS ACTIVE TAGS WHOSE ARTIST STRING APPEARS ON EXACTLY ONE TRACK. It is where the junk is: the 018/020 playlist seeds tagged "Dec 29, 2023" and "Cavendish Music" as jazz, both true as membership and false as claims about an act (§14.9). It is a fact about EVIDENCE and not a verdict — quote it as a caveat on tagged_rows, and send anyone who wants to look to dj_tag_review. ⚠️ uncategorised_derivable should be 0 in normal operation.';



CREATE OR REPLACE FUNCTION "public"."dj_tag_review"("p_tag" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT NULL::"text", "p_window_days" integer DEFAULT 90, "p_limit" integer DEFAULT 20) RETURNS TABLE("artist" "text", "tag" "text", "status" "text", "source" "text", "note" "text", "distinct_tracks" integer, "distinct_playlists" integer, "play_rows" integer, "distinct_days" integer, "last_played_on" "date")
    LANGUAGE "sql" STABLE
    AS $$
  with tracks_by_artist as (
    select t.artist, count(*)::int as n
    from public.dj_tracks t
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  playlists_by_artist as (
    select t.artist, count(distinct pt.playlist_id)::int as n
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  plays_by_artist as (
    select t.artist,
           count(*)::int as play_rows,
           count(distinct p.played_on)::int as distinct_days,
           max(p.played_on) as last_played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
    group by t.artist
  )
  select at.artist,
         at.tag,
         at.status,
         at.source,
         at.note,
         coalesce(tb.n, 0),
         coalesce(pb.n, 0),
         coalesce(pl.play_rows, 0),
         coalesce(pl.distinct_days, 0),
         pl.last_played_on
  from public.dj_artist_tags at
  left join tracks_by_artist    tb on public.dj_fold_artist(tb.artist)
                                  = public.dj_fold_artist(at.artist)
  left join playlists_by_artist pb on public.dj_fold_artist(pb.artist)
                                  = public.dj_fold_artist(at.artist)
  left join plays_by_artist     pl on public.dj_fold_artist(pl.artist)
                                  = public.dj_fold_artist(at.artist)
  where (p_tag is null or at.tag = p_tag)
    and (p_source is null or at.source = p_source)
  -- 🛑 WEAKEST EVIDENCE FIRST. This is an ORDERING FOR A HUMAN, not a ruling.
  -- A one-track, one-playlist, never-played string is the cheapest thing to
  -- check; a 94-song artist is not worth anyone's attention. Nothing here
  -- inspects the text.
  order by coalesce(tb.n, 0) asc,
           coalesce(pl.play_rows, 0) asc,
           coalesce(pb.n, 0) asc,
           at.artist
  limit p_limit;
$$;


ALTER FUNCTION "public"."dj_tag_review"("p_tag" "text", "p_source" "text", "p_window_days" integer, "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."dj_tag_review"("p_tag" "text", "p_source" "text", "p_window_days" integer, "p_limit" integer) IS 'Review surface for dj_artist_tags, ordered WEAKEST EVIDENCE FIRST. 🛑 IT MAKES NO CLAIM ABOUT WHICH STRINGS ARE REAL ARTISTS AND MUST NOT BE READ AS ONE. It reports four facts already in the database — distinct_tracks, distinct_playlists, play_rows, distinct_days — and orders by them. NOTHING HERE INSPECTS THE TEXT. ⚠️ WHY NO RULE: after the 018/020 seeds, jazz tags included "Dec 29, 2023", "Anything_F_744", "aron!" and "Cavendish Music" — all TRUE as membership statements and all false as claims about an act (§14.9). Any regex that catches a date also catches a band with a number in its name, and would delete a curated row silently — §14.7 records what text rules cost here. ⚠️ A real act accumulates tracks, playlists and plays; a byline scraped onto one upload accumulates one track and stops. That asymmetry is factual, and it is an ordering for a human, never a verdict. ⚠️ THE CLEANUP IS A SEPARATE, UNSTARTED JOB. Do not reject rows from inside the weekly item.';



CREATE OR REPLACE FUNCTION "public"."drive_mix_pick"("p_date" "date" DEFAULT CURRENT_DATE, "p_count" integer DEFAULT 50, "p_artist_cap" integer DEFAULT NULL::integer, "p_quotas" "jsonb" DEFAULT NULL::"jsonb", "p_cooldown_days" integer DEFAULT 2, "p_new_share" numeric DEFAULT 0.25, "p_familiar_days" integer DEFAULT 5, "p_familiar_gap_days" integer DEFAULT 7, "p_familiar_slices_exempt" "text"[] DEFAULT '{1980s-and-earlier}'::"text"[], "p_familiar_breaks_cooldown" boolean DEFAULT true, "p_recency" "jsonb" DEFAULT NULL::"jsonb", "p_last_serving" "jsonb" DEFAULT NULL::"jsonb", "p_play_days" "jsonb" DEFAULT NULL::"jsonb") RETURNS TABLE("position" integer, "song_id" "uuid", "video_id" "text", "title" "text", "artist" "text", "artist_key" "text", "slice" "text", "song_slice" "text", "carried" boolean, "cooling" boolean, "last_heard" "date", "distinct_days" integer, "familiar" boolean, "new_over_cap" boolean)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $_$
#variable_conflict use_column
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  c_shape  constant jsonb  := '{"country_rap": 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22}';
  v_uid       uuid := auth.uid();
  v_exempt    text[] := coalesce(p_familiar_slices_exempt, '{}');
  v_rec       jsonb;           -- song_id -> last heard before p_date
  v_pdays     jsonb;           -- song_id -> distinct days heard before p_date
  v_since     jsonb;           -- song_id -> first serving of its current run; only songs in the last serving
  v_raw       jsonb;
  v_q         jsonb;           -- effective quotas, summing to p_count
  v_nq        jsonb;           -- new-song share per slice, summing to v_new_cap
  v_new_cap   int;
  v_cap       int;
  v_ids       uuid[];
  v_keys      text[];
  v_slice     text[];
  v_last      date[];
  v_elig      boolean[];
  v_days      int[];
  v_fam       boolean[];
  v_n         int;
  v_taken     boolean[];
  v_cand      boolean[];       -- carry-over candidates
  v_carried   boolean[];
  v_cooled    boolean[];
  v_over      boolean[];
  v_from      text[];
  v_sel       int[] := '{}';
  v_ord       int[];
  v_ac        jsonb := '{}';   -- artist_key -> songs in today's list
  v_sc        jsonb := '{}';   -- slice -> songs in today's list
  v_sf        jsonb := '{}';   -- slice -> familiar songs in today's list
  v_nc        jsonb := '{}';   -- slice -> new songs counted for new_over_cap
  v_heard     jsonb;           -- artist_key -> last day any of its pool songs was heard
  v_cool      date;
  v_gap       date;            -- a familiar song heard after this is too recent
  v_s         text;
  v_quota     int;
  v_lim       int;
  v_pass      int;
  v_passes    int[];
  v_want_fam  boolean;
  v_is_cool   boolean;
  v_is_recent boolean;
  v_tmp       int;
  x           int;
  i           int;
  j           int;
  d           int;
begin
  if v_uid is null then
    raise exception 'drive_mix_pick: no signed-in user. Call it through get_drive_mix_pick, or in the SQL editor after "set local role authenticated" and request.jwt.claims.';
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'drive_mix_pick: p_count must be between 1 and 200, got %', p_count;
  end if;
  if p_artist_cap is not null and p_artist_cap < 1 then
    raise exception 'drive_mix_pick: p_artist_cap must be at least 1, got %', p_artist_cap;
  end if;
  if p_cooldown_days is null or p_cooldown_days < 0 or p_cooldown_days > 30 then
    raise exception 'drive_mix_pick: p_cooldown_days must be between 0 and 30, got %', p_cooldown_days;
  end if;
  if p_new_share is null or p_new_share < 0 or p_new_share > 1 then
    raise exception 'drive_mix_pick: p_new_share must be between 0 and 1, got %', p_new_share;
  end if;
  if p_familiar_days is null or p_familiar_days < 1 or p_familiar_days > 365 then
    raise exception 'drive_mix_pick: p_familiar_days must be between 1 and 365, got %', p_familiar_days;
  end if;
  if p_familiar_gap_days is null or p_familiar_gap_days < 0 or p_familiar_gap_days > 60 then
    raise exception 'drive_mix_pick: p_familiar_gap_days must be between 0 and 60, got %', p_familiar_gap_days;
  end if;
  if not (v_exempt <@ c_slices) then
    raise exception 'drive_mix_pick: p_familiar_slices_exempt must name slices from %, got %', c_slices, v_exempt;
  end if;
  if p_familiar_breaks_cooldown is null then
    raise exception 'drive_mix_pick: p_familiar_breaks_cooldown must be true or false';
  end if;

  -- Quotas: proportions scaled to p_count by largest remainder (ties to the
  -- earlier slice). Counts that already sum to p_count come back unchanged.
  v_raw := coalesce(p_quotas, c_shape);
  if jsonb_typeof(v_raw) <> 'object' then
    raise exception 'drive_mix_pick: p_quotas must be a json object of slice -> share';
  end if;
  if exists (select 1 from jsonb_each_text(v_raw) q
             where q.key <> all (c_slices) or q.value !~ '^\d+(\.\d+)?$') then
    raise exception 'drive_mix_pick: p_quotas keys must be % with non-negative numbers, got %', c_slices, v_raw;
  end if;
  if coalesce((select sum(q.value::numeric) from jsonb_each_text(v_raw) q), 0) = 0 then
    raise exception 'drive_mix_pick: p_quotas must not all be zero, got %', v_raw;
  end if;
  with raw as (
    select u.k, u.o, coalesce((v_raw ->> u.k)::numeric, 0) as v
    from unnest(c_slices) with ordinality as u(k, o)
  ),
  fl as (
    select raw.k, raw.o,
           floor(raw.v * p_count / (select sum(r2.v) from raw r2))::int as f,
           raw.v * p_count / (select sum(r2.v) from raw r2)
             - floor(raw.v * p_count / (select sum(r2.v) from raw r2)) as rem
    from raw
  ),
  rk as (
    select fl.k, fl.f, row_number() over (order by fl.rem desc, fl.o) as rn,
           p_count - sum(fl.f) over () as spare
    from fl
  )
  select jsonb_object_agg(rk.k, rk.f + case when rk.rn <= rk.spare then 1 else 0 end)
    into v_q
  from rk;

  -- New-song cap, split by largest remainder over the slices that count new
  -- songs, in proportion to their quotas. Exempt slices get 0. At 50 with the
  -- 1980s exempt: 12 split 2 / 0 / 4 / 6.
  v_new_cap := floor(p_new_share * p_count)::int;
  with raw as (
    select u.k, u.o,
           case when u.k = any (v_exempt) then 0 else (v_q ->> u.k)::numeric end as v
    from unnest(c_slices) with ordinality as u(k, o)
  ),
  tot as (select nullif(sum(raw.v), 0) as t from raw),
  fl as (
    select raw.k, raw.o,
           coalesce(floor(raw.v * v_new_cap / tot.t), 0)::int as f,
           coalesce(raw.v * v_new_cap / tot.t - floor(raw.v * v_new_cap / tot.t), 0) as rem,
           raw.v
    from raw, tot
  ),
  rk as (
    select fl.k, fl.f, fl.v, row_number() over (order by fl.rem desc, fl.o) as rn,
           case when (select t from tot) is null then 0 else v_new_cap - sum(fl.f) over () end as spare
    from fl
  )
  select jsonb_object_agg(rk.k, rk.f + case when rk.rn <= rk.spare and rk.v > 0 then 1 else 0 end)
    into v_nq
  from rk;

  v_cap := coalesce(p_artist_cap, ceil(p_count / 25.0)::int);

  -- Recency and play days, once per call: last day and number of distinct days
  -- each pool song's canonical group was heard before p_date. One aggregate over
  -- dj_plays, not a subquery per song. The simulator passes its own maps instead.
  if p_recency is not null then
    v_rec   := p_recency;
    v_pdays := coalesce(p_play_days, '{}');
  else
    select coalesce(jsonb_object_agg(s.id::text, h.m), '{}'),
           coalesce(jsonb_object_agg(s.id::text, h.n), '{}')
      into v_rec, v_pdays
    from public.drive_mix_songs s
    join public.dj_tracks t0
      on t0.user_id = v_uid and t0.video_id = s.video_id
    join (select coalesce(t.canonical_track_id, t.id) as g,
                 max(p.played_on) as m,
                 count(distinct p.played_on)::int as n
          from public.dj_plays p
          join public.dj_tracks t on t.id = p.track_id
          where p.user_id = v_uid and t.user_id = v_uid and p.played_on < p_date
          group by 1) h
      on h.g = coalesce(t0.canonical_track_id, t0.id)
    where s.user_id = v_uid;
  end if;

  -- Every pool song, any status (a retired song's plays still cool its artist),
  -- oldest-heard first, never-heard before all. Only v_elig songs are picked;
  -- a thumbs down is never eligible. Familiar = heard on p_familiar_days days,
  -- or in an exempt slice. A thumbs up does not make a song familiar.
  select array_agg(c.id         order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.artist_key order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.slice      order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.last_heard order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.elig       order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.days       order by c.last_heard asc nulls first, c.tiebreak),
         array_agg(c.fam        order by c.last_heard asc nulls first, c.tiebreak)
    into v_ids, v_keys, v_slice, v_last, v_elig, v_days, v_fam
  from (
    select b.id, b.artist_key, b.elig, b.slice, b.last_heard, b.days, b.tiebreak,
           (b.days >= p_familiar_days or coalesce(b.slice = any (v_exempt), false)) as fam
    from (
      select s.id,
             s.artist_key,
             (s.status = 'active' and s.decade is not null and s.genre is not null
              and s.thumbs is distinct from 'down') as elig,
             case when s.genre in ('country', 'rap')   then 'country_rap'
                  when s.decade <= 1980                then '1980s-and-earlier'
                  when s.decade between 1990 and 2000 then '1990s-2000s'
                  when s.decade is not null            then '2010s-2020s'
             end as slice,
             (v_rec ->> s.id::text)::date as last_heard,
             coalesce((v_pdays ->> s.id::text)::int, 0) as days,
             md5(p_date::text || ':' || s.id::text) as tiebreak
      from public.drive_mix_songs s
      where s.user_id = v_uid
    ) b
  ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    return;
  end if;

  -- Cooldown: an artist heard on any of the p_cooldown_days days before p_date.
  select coalesce(jsonb_object_agg(u.k, u.m), '{}')
    into v_heard
  from (select xx.k, max(xx.l) as m
        from unnest(v_keys, v_last) as xx(k, l)
        where xx.l is not null
        group by xx.k) u;
  v_cool := p_date - p_cooldown_days;
  v_gap  := p_date - p_familiar_gap_days;

  -- Run start for each song in the most recent serving before p_date: the first
  -- serving of its unbroken run of consecutive servings ending there. Serving
  -- ranks k = 1 (latest), 2, ...; a song present at ranks 1..n has k - row_number = 0.
  -- The simulator passes p_last_serving {served_on, song_ids, since}; a song
  -- missing from since starts its run on served_on.
  if p_recency is not null then
    if p_last_serving is not null then
      select coalesce(jsonb_object_agg(e, coalesce(p_last_serving -> 'since' ->> e, p_last_serving ->> 'served_on')), '{}')
        into v_since
      from jsonb_array_elements_text(p_last_serving -> 'song_ids') e;
    end if;
  else
    with dd as (
      select x.served_on, row_number() over (order by x.served_on desc) as k
      from (select distinct sv.served_on from public.drive_mix_servings sv
            where sv.user_id = v_uid and sv.served_on < p_date) x
    ),
    m as (
      select sv.song_id, dd.served_on,
             dd.k - row_number() over (partition by sv.song_id order by dd.k) as grp
      from public.drive_mix_servings sv
      join dd on dd.served_on = sv.served_on
      where sv.user_id = v_uid
    )
    select coalesce(jsonb_object_agg(r.song_id::text, r.run_start), '{}')
      into v_since
    from (select m.song_id, min(m.served_on) as run_start from m where m.grp = 0 group by m.song_id) r;
  end if;
  v_since := coalesce(v_since, '{}');

  v_taken   := array_fill(false, array[v_n]);
  v_cand    := array_fill(false, array[v_n]);
  v_carried := array_fill(false, array[v_n]);
  v_cooled  := array_fill(false, array[v_n]);
  v_over    := array_fill(false, array[v_n]);
  v_from    := array_fill(null::text, array[v_n]);

  -- 1. Carry-over candidates: in the last serving, still eligible, not heard
  -- since the run start. They are not taken here; see step 2.
  for i in 1 .. v_n loop
    if v_elig[i] and v_since ? v_ids[i]::text
       and (v_last[i] is null or v_last[i] < (v_since ->> v_ids[i]::text)::date) then
      v_cand[i] := true;
    end if;
  end loop;

  -- 2. Slices in spec order, each topped up to its quota, in recency order,
  -- under the cap, never past p_count. Passes per slice:
  --   1 familiar, not cooling, to the familiar share;
  --   5 familiar by cooling artists, to the familiar share (p_familiar_breaks_cooldown);
  --   2 new, not cooling, to the new share;
  --   3 more familiar, not cooling, if new ran short;
  --   4 more new, not cooling, if familiar ran short.
  -- Each pass takes its side's carry-over candidates first (carried = true),
  -- exempt from the cap, the cooldown and the familiar gap but inside the pass's
  -- limit. A candidate that does not fit is an ordinary pool song from then on.
  -- A familiar song heard within p_familiar_gap_days is skipped throughout.
  v_passes := case when p_familiar_breaks_cooldown then array[1, 5, 2, 3, 4] else array[1, 2, 3, 4] end;
  foreach v_s in array c_slices loop
    v_quota := coalesce((v_q ->> v_s)::int, 0);
    foreach v_pass in array v_passes loop
      v_want_fam := v_pass in (1, 3, 5);
      v_lim := case
                 when v_pass in (1, 5) then least(v_quota, (v_q ->> v_s)::int - (v_nq ->> v_s)::int
                                                  - coalesce((v_sf ->> v_s)::int, 0))
                 when v_pass = 2 then least(v_quota, (v_nq ->> v_s)::int
                                            - (coalesce((v_sc ->> v_s)::int, 0) - coalesce((v_sf ->> v_s)::int, 0)))
                 else v_quota
               end;
      i := 1;
      while v_lim > 0 and coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
        if v_cand[i] and not v_taken[i] and v_slice[i] = v_s and v_fam[i] = v_want_fam then
          v_taken[i]   := true;
          v_carried[i] := true;
          v_from[i]    := v_s;
          v_sel        := v_sel || i;
          v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
          v_sc := v_sc || jsonb_build_object(v_s, coalesce((v_sc ->> v_s)::int, 0) + 1);
          if v_fam[i] then
            v_sf := v_sf || jsonb_build_object(v_s, coalesce((v_sf ->> v_s)::int, 0) + 1);
          end if;
          v_lim   := v_lim - 1;
          v_quota := v_quota - 1;
        end if;
        i := i + 1;
      end loop;
      i := 1;
      while v_lim > 0 and coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
        v_is_cool := p_cooldown_days > 0 and coalesce((v_heard ->> v_keys[i])::date >= v_cool, false);
        if v_elig[i] and v_slice[i] = v_s and not v_taken[i] and v_fam[i] = v_want_fam
           and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap
           and (v_pass = 5 or not v_is_cool)
           and not (v_fam[i] and p_familiar_gap_days > 0 and coalesce(v_last[i] > v_gap, false)) then
          v_taken[i]  := true;
          v_from[i]   := v_s;
          v_cooled[i] := v_is_cool;
          v_sel       := v_sel || i;
          v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
          v_sc := v_sc || jsonb_build_object(v_s, coalesce((v_sc ->> v_s)::int, 0) + 1);
          if v_fam[i] then
            v_sf := v_sf || jsonb_build_object(v_s, coalesce((v_sf ->> v_s)::int, 0) + 1);
          end if;
          v_lim   := v_lim - 1;
          v_quota := v_quota - 1;
        end if;
        i := i + 1;
      end loop;
    end loop;
  end loop;

  -- 3-4. Still short: any slice (slice = fill). Passes: 1 familiar, not
  -- cooling; 2 new, not cooling; 3 familiar by cooling artists; 4 new by cooling
  -- artists; 5 familiar songs inside the familiar gap. With
  -- p_familiar_breaks_cooldown, 3 runs before 2. The cap applies throughout.
  v_passes := case when p_familiar_breaks_cooldown then array[1, 3, 2, 4, 5] else array[1, 2, 3, 4, 5] end;
  foreach v_pass in array v_passes loop
    v_want_fam := v_pass in (1, 3, 5);
    i := 1;
    while coalesce(array_length(v_sel, 1), 0) < p_count and i <= v_n loop
      v_is_cool   := p_cooldown_days > 0 and coalesce((v_heard ->> v_keys[i])::date >= v_cool, false);
      v_is_recent := v_fam[i] and p_familiar_gap_days > 0 and coalesce(v_last[i] > v_gap, false);
      if v_elig[i] and not v_taken[i] and v_fam[i] = v_want_fam
         and coalesce((v_ac ->> v_keys[i])::int, 0) < v_cap
         and (v_pass >= 3 or not v_is_cool)
         and (v_pass = 5 or not v_is_recent) then
        v_taken[i]  := true;
        v_from[i]   := 'fill';
        v_cooled[i] := v_is_cool;
        v_sel       := v_sel || i;
        v_ac := v_ac || jsonb_build_object(v_keys[i], coalesce((v_ac ->> v_keys[i])::int, 0) + 1);
      end if;
      i := i + 1;
    end loop;
  end loop;

  if coalesce(array_length(v_sel, 1), 0) = 0 then
    return;
  end if;

  -- new_over_cap: every new song past its natural slice's new share, counted in
  -- selection order, whatever path chose it.
  foreach x in array v_sel loop
    if not v_fam[x] then
      v_nc := v_nc || jsonb_build_object(v_slice[x], coalesce((v_nc ->> v_slice[x])::int, 0) + 1);
      v_over[x] := (v_nc ->> v_slice[x])::int > coalesce((v_nq ->> v_slice[x])::int, 0);
    end if;
  end loop;

  -- Spread: songs are grouped by natural slice and familiar/new. Song r of a
  -- group of k aims at position (r - 0.5) * n / k, plus a seeded jitter of up
  -- to a quarter of the group's spacing either way, and the list is sorted by aim.
  -- So every slice, and its new songs, are spaced through the whole list.
  v_n := array_length(v_sel, 1);
  select array_agg(g.x order by g.aim, g.h)
    into v_ord
  from (
    select q.x, q.h,
           (q.rn - 0.5) * v_n / q.k + (q.frac - 0.5) * 0.5 * v_n / q.k as aim
    from (
      select u.x,
             md5(p_date::text || ':order:' || v_ids[u.x]::text) as h,
             row_number() over (partition by v_slice[u.x], v_fam[u.x]
                                order by md5(p_date::text || ':order:' || v_ids[u.x]::text)) as rn,
             count(*) over (partition by v_slice[u.x], v_fam[u.x]) as k,
             ('x' || substr(md5(p_date::text || ':jitter:' || v_ids[u.x]::text), 1, 8))::bit(32)::bigint
               / 4294967296.0 as frac
      from unnest(v_sel) as u(x)
    ) q
  ) g;

  -- Break up adjacent same-artist pairs by swapping with the nearest position
  -- that leaves both spots clean, so the spread survives. Out-of-range array
  -- reads are null, so the edge checks need no guards.
  for i in 2 .. v_n loop
    if v_keys[v_ord[i]] = v_keys[v_ord[i - 1]] then
      <<seek>>
      for d in 1 .. v_n loop
        foreach j in array array[i + d, i - d] loop
          continue when j < 1 or j > v_n or j = i - 1;
          v_tmp := v_ord[i]; v_ord[i] := v_ord[j]; v_ord[j] := v_tmp;
          if (i = 1    or v_keys[v_ord[i]] <> v_keys[v_ord[i - 1]])
             and (i = v_n or v_keys[v_ord[i]] <> v_keys[v_ord[i + 1]])
             and (j = 1    or v_keys[v_ord[j]] <> v_keys[v_ord[j - 1]])
             and (j = v_n or v_keys[v_ord[j]] <> v_keys[v_ord[j + 1]]) then
            exit seek;
          end if;
          v_tmp := v_ord[i]; v_ord[i] := v_ord[j]; v_ord[j] := v_tmp;
        end loop;
      end loop;
    end if;
  end loop;

  return query
  select u.pos::int, s.id, s.video_id, s.title, s.artist, s.artist_key,
         v_from[u.idx], v_slice[u.idx], v_carried[u.idx], v_cooled[u.idx], v_last[u.idx],
         v_days[u.idx], v_fam[u.idx], v_over[u.idx]
  from unnest(v_ord) with ordinality as u(idx, pos)
  join public.drive_mix_songs s on s.id = v_ids[u.idx]
  order by u.pos;
end;
$_$;


ALTER FUNCTION "public"."drive_mix_pick"("p_date" "date", "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean, "p_recency" "jsonb", "p_last_serving" "jsonb", "p_play_days" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."drive_mix_pick"("p_date" "date", "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean, "p_recency" "jsonb", "p_last_serving" "jsonb", "p_play_days" "jsonb") IS 'DJ: choose the Drive Mix playlist for a date, any length from 1 to 200. Writes nothing; the same date and count give the same list while no new plays, servings or thumbs land. Needs a signed-in user. Quotas: p_quotas (default shape country_rap 6, 1980s-and-earlier 10, 2010s-2020s 12, 1990s-2000s 22) are proportions scaled to p_count by largest remainder. Artist cap: p_artist_cap, default ceil(p_count / 25). Thumbs down is never picked. Familiar = canonical group heard on at least p_familiar_days (5) distinct days, or in a p_familiar_slices_exempt slice (default 1980s-and-earlier); a thumbs up does not count. The rest are new. New songs fill at most floor(p_new_share (0.25) x p_count), split across the non-exempt slices like the quotas; within a slice familiar songs come first and each side backfills the other. new_over_cap marks every new song past its natural slice''s share. A familiar song heard in the last p_familiar_gap_days (7) days is skipped. 1. Carry-over: songs in the most recent serving before p_date, still eligible and not heard since the first serving of their current unbroken run of servings, go first within their own side (familiar or new) of their slice (carried = true), exempt from the cap, the cooldown and the gap but never past that side''s share; the rest go back to the pool. 2. Slices in order country_rap, 1980s-and-earlier, 2010s-2020s, 1990s-2000s, in last-heard order. 3. Fill (slice = fill), familiar first. Artists heard in the p_cooldown_days days before p_date are skipped, except that with p_familiar_breaks_cooldown (default true) a familiar song by a cooling artist is taken before any new song (cooling = true); the cap is never broken. 4. Last resort: cooling artists, then familiar songs inside the gap. Order: each natural slice (song_slice) and familiar/new group is spaced evenly through the list with a seeded jitter; no adjacent same artist where a swap can avoid it. p_recency (song_id -> last heard), p_play_days (song_id -> distinct days) and p_last_serving ({served_on, song_ids, since: song_id -> run start}) are for drive_mix_simulate only: given, they replace dj_plays and drive_mix_servings.';



CREATE OR REPLACE FUNCTION "public"."drive_mix_simulate"("p_start" "date" DEFAULT CURRENT_DATE, "p_days" integer DEFAULT 60, "p_heard_per_day" integer DEFAULT NULL::integer, "p_count" integer DEFAULT 50, "p_artist_cap" integer DEFAULT NULL::integer, "p_quotas" "jsonb" DEFAULT NULL::"jsonb", "p_cooldown_days" integer DEFAULT 2, "p_new_share" numeric DEFAULT 0.25, "p_familiar_days" integer DEFAULT 5, "p_familiar_gap_days" integer DEFAULT 7, "p_familiar_slices_exempt" "text"[] DEFAULT '{1980s-and-earlier}'::"text"[], "p_familiar_breaks_cooldown" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $$
declare
  c_slices constant text[] := array['country_rap', '1980s-and-earlier', '2010s-2020s', '1990s-2000s'];
  c_shape  constant jsonb  := '{"country_rap": 6, "1980s-and-earlier": 10, "2010s-2020s": 12, "1990s-2000s": 22}';
  v_uid       uuid := auth.uid();
  v_raw       jsonb;
  v_q         jsonb;
  v_rec       jsonb;
  v_pdays     jsonb;
  v_ls        jsonb;
  v_today     jsonb;
  v_today_since jsonb;
  v_day       date;
  v_got       jsonb;
  v_total     int;
  v_cooling   int;
  v_new       int;
  v_over      int;
  v_carried   int := 0;
  v_cool_days jsonb := '[]';
  v_new_days  jsonb := '[]';
  v_short     jsonb := '[]';
  v_srv_day   date[] := '{}';
  v_srv_song  uuid[] := '{}';
  v_srv_heard boolean[] := '{}';
  v_srv_pos   int[] := '{}';
  v_srv_slice text[] := '{}';
  v_srv_fam   boolean[] := '{}';
  v_srv_cool  boolean[] := '{}';
  v_pool      int;
  v_result    jsonb;
  r           record;
  d           int;
begin
  if v_uid is null then
    raise exception 'drive_mix_simulate: no signed-in user. Call it through get_drive_mix_simulation, or in the SQL editor after "set local role authenticated" and request.jwt.claims.';
  end if;
  if p_days is null or p_days < 1 or p_days > 120 then
    raise exception 'drive_mix_simulate: p_days must be between 1 and 120, got %', p_days;
  end if;
  if p_heard_per_day is not null and p_heard_per_day < 0 then
    raise exception 'drive_mix_simulate: p_heard_per_day must be 0 or more, got %', p_heard_per_day;
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'drive_mix_simulate: p_count must be between 1 and 200, got %', p_count;
  end if;

  -- Effective quotas, for the shortfall report. Same block as drive_mix_pick;
  -- invalid quotas are rejected by drive_mix_pick on day one.
  v_raw := coalesce(p_quotas, c_shape);
  with raw as (
    select u.k, u.o, coalesce((v_raw ->> u.k)::numeric, 0) as v
    from unnest(c_slices) with ordinality as u(k, o)
  ),
  fl as (
    select raw.k, raw.o,
           floor(raw.v * p_count / nullif((select sum(r2.v) from raw r2), 0))::int as f,
           raw.v * p_count / nullif((select sum(r2.v) from raw r2), 0)
             - floor(raw.v * p_count / nullif((select sum(r2.v) from raw r2), 0)) as rem
    from raw
  ),
  rk as (
    select fl.k, fl.f, row_number() over (order by fl.rem desc, fl.o) as rn,
           p_count - sum(fl.f) over () as spare
    from fl
  )
  select jsonb_object_agg(rk.k, rk.f + case when rk.rn <= rk.spare then 1 else 0 end)
    into v_q
  from rk;

  -- Real recency and play days before the start date for every pool song, once.
  -- Same query as drive_mix_pick; the loop below then advances both maps in memory.
  select coalesce(jsonb_object_agg(s.id::text, h.m), '{}'),
         coalesce(jsonb_object_agg(s.id::text, h.n), '{}')
    into v_rec, v_pdays
  from public.drive_mix_songs s
  join public.dj_tracks t0
    on t0.user_id = v_uid and t0.video_id = s.video_id
  join (select coalesce(t.canonical_track_id, t.id) as g,
               max(p.played_on) as m,
               count(distinct p.played_on)::int as n
        from public.dj_plays p
        join public.dj_tracks t on t.id = p.track_id
        where p.user_id = v_uid and t.user_id = v_uid and p.played_on < p_start
        group by 1) h
    on h.g = coalesce(t0.canonical_track_id, t0.id)
  where s.user_id = v_uid;

  -- The real last serving before the start date, with each song's run start,
  -- seeds the first day's carry-over. Same run-start query as drive_mix_pick.
  with dd as (
    select x.served_on, row_number() over (order by x.served_on desc) as k
    from (select distinct sv.served_on from public.drive_mix_servings sv
          where sv.user_id = v_uid and sv.served_on < p_start) x
  ),
  m as (
    select sv.song_id, dd.served_on, dd.k,
           dd.k - row_number() over (partition by sv.song_id order by dd.k) as grp
    from public.drive_mix_servings sv
    join dd on dd.served_on = sv.served_on
    where sv.user_id = v_uid
  ),
  runs as (
    select m.song_id, min(m.served_on) as run_start from m where m.grp = 0 group by m.song_id
  )
  select jsonb_build_object('served_on', (select dd.served_on from dd where dd.k = 1),
                            'song_ids', jsonb_agg(runs.song_id::text),
                            'since', jsonb_object_agg(runs.song_id::text, runs.run_start))
    into v_ls
  from runs
  having count(*) > 0;

  for d in 0 .. p_days - 1 loop
    v_day     := p_start + d;
    v_got     := '{}';
    v_total   := 0;
    v_cooling := 0;
    v_new     := 0;
    v_over    := 0;
    v_today   := '[]';
    v_today_since := '{}';
    for r in select * from public.drive_mix_pick(
               p_date => v_day, p_count => p_count, p_artist_cap => p_artist_cap,
               p_quotas => p_quotas, p_cooldown_days => p_cooldown_days,
               p_new_share => p_new_share, p_familiar_days => p_familiar_days,
               p_familiar_gap_days => p_familiar_gap_days,
               p_familiar_slices_exempt => p_familiar_slices_exempt,
               p_familiar_breaks_cooldown => p_familiar_breaks_cooldown,
               p_recency => v_rec, p_last_serving => v_ls, p_play_days => v_pdays) loop
      v_srv_day   := v_srv_day || v_day;
      v_srv_song  := v_srv_song || r.song_id;
      v_srv_heard := v_srv_heard || (p_heard_per_day is null or r."position" <= p_heard_per_day);
      v_srv_pos   := v_srv_pos || r."position";
      v_srv_slice := v_srv_slice || r.song_slice;
      v_srv_fam   := v_srv_fam || r.familiar;
      v_srv_cool  := v_srv_cool || r.cooling;
      v_total     := v_total + 1;
      v_today     := v_today || to_jsonb(r.song_id::text);
      -- A song also in yesterday's list continues its run; any other starts one today.
      v_today_since := v_today_since || jsonb_build_object(r.song_id::text,
        case when v_ls is not null and (v_ls -> 'song_ids') ? r.song_id::text
             then coalesce(v_ls -> 'since' ->> r.song_id::text, v_ls ->> 'served_on')
             else v_day::text end);
      if r.carried then
        v_carried := v_carried + 1;
      end if;
      if r.cooling then
        v_cooling := v_cooling + 1;
      end if;
      if not r.familiar then
        v_new := v_new + 1;
      end if;
      if r.new_over_cap then
        v_over := v_over + 1;
      end if;
      v_got := v_got || jsonb_build_object(r.slice, coalesce((v_got ->> r.slice)::int, 0) + 1);
      if p_heard_per_day is null or r."position" <= p_heard_per_day then
        v_rec   := v_rec || jsonb_build_object(r.song_id::text, v_day);
        v_pdays := v_pdays || jsonb_build_object(r.song_id::text,
                                                 coalesce((v_pdays ->> r.song_id::text)::int, 0) + 1);
      end if;
    end loop;
    v_ls := jsonb_build_object('served_on', v_day, 'song_ids', v_today, 'since', v_today_since);

    v_new_days := v_new_days || jsonb_build_array(jsonb_build_object(
      'date', v_day, 'new', v_new, 'over_cap', v_over,
      'share', case when v_total > 0 then round(v_new::numeric / v_total, 2) end));

    if v_cooling > 0 then
      v_cool_days := v_cool_days || jsonb_build_array(jsonb_build_object('date', v_day, 'cooling_used', v_cooling));
    end if;

    select v_short || coalesce(jsonb_agg(jsonb_build_object(
             'date', v_day, 'slice', q.key, 'quota', q.value::int,
             'filled', coalesce((v_got ->> q.key)::int, 0))), '[]')
      into v_short
    from jsonb_each_text(v_q) q
    where coalesce((v_got ->> q.key)::int, 0) < q.value::int;

    if v_total < p_count then
      v_short := v_short || jsonb_build_array(jsonb_build_object(
        'date', v_day, 'slice', 'total', 'quota', p_count, 'filled', v_total));
    end if;
  end loop;

  select count(*) into v_pool
  from public.drive_mix_songs s
  where s.user_id = v_uid and s.status = 'active' and s.decade is not null and s.genre is not null
    and s.thumbs is distinct from 'down';

  with srv as (
    select u.day, u.song_id, u.heard, u.pos, u.slice, u.fam, u.cool
    from unnest(v_srv_day, v_srv_song, v_srv_heard, v_srv_pos, v_srv_slice, v_srv_fam, v_srv_cool)
           as u(day, song_id, heard, pos, slice, fam, cool)
  ),
  gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv
  ),
  heard_gaps as (
    select srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv where srv.heard
  ),
  fam_gaps as (
    select srv.slice, srv.day - lag(srv.day) over (partition by srv.song_id order by srv.day) as gap
    from srv where srv.fam
  ),
  per_slice as (
    select srv.slice,
           round(avg(srv.pos), 1) as avg_position,
           count(*) filter (where srv.fam)::int as familiar_served,
           count(*) filter (where not srv.fam)::int as new_served
    from srv group by srv.slice
  ),
  per_song as (
    select srv.song_id, count(*)::int as served, count(*) filter (where srv.heard)::int as heard
    from srv group by srv.song_id
  ),
  artist_days as (
    select s.artist_key, count(distinct srv.day)::int as days_appeared
    from srv join public.drive_mix_songs s on s.id = srv.song_id
    group by s.artist_key
  ),
  per_artist as (
    select s.artist_key,
           coalesce(sum(ps.served), 0)::int as served,
           count(*)::int as pool_songs,
           coalesce(max(ad.days_appeared), 0)::int as days_appeared
    from public.drive_mix_songs s
    left join per_song ps on ps.song_id = s.id
    left join artist_days ad on ad.artist_key = s.artist_key
    where s.user_id = v_uid and s.status = 'active' and s.decade is not null and s.genre is not null
      and s.thumbs is distinct from 'down'
    group by s.artist_key
  )
  select jsonb_build_object(
    'start', p_start,
    'days', p_days,
    'count', p_count,
    'artist_cap_used', coalesce(p_artist_cap, ceil(p_count / 25.0)::int),
    'cooldown_days', p_cooldown_days,
    'new_share', p_new_share,
    'familiar_days', p_familiar_days,
    'familiar_gap_days', p_familiar_gap_days,
    'familiar_slices_exempt', to_jsonb(coalesce(p_familiar_slices_exempt, '{}')),
    'familiar_breaks_cooldown', p_familiar_breaks_cooldown,
    'quotas_used', v_q,
    'heard_per_day', p_heard_per_day,
    'pool_eligible', v_pool,
    'expected_gap_days', round(v_pool::numeric / p_count, 1),
    'distinct_songs_served', (select count(*) from per_song),
    'distinct_songs_heard', (select count(*) from per_song where heard > 0),
    'carried_per_day_avg', round(v_carried::numeric / p_days, 1),
    'cooling_fills', jsonb_build_object(
                       'total', (select coalesce(sum((e ->> 'cooling_used')::int), 0)
                                 from jsonb_array_elements(v_cool_days) e),
                       'days', v_cool_days),
    'cooling_breaks', (select count(*) from srv where srv.fam and srv.cool),
    'new_songs', (select jsonb_build_object(
                    'cap_per_day', floor(p_new_share * p_count)::int,
                    'share_avg', round(avg((e ->> 'share')::numeric), 3),
                    'share_avg_from_day_2', round(avg((e ->> 'share')::numeric) filter (where o > 1), 3),
                    'share_min', min((e ->> 'share')::numeric),
                    'share_max', max((e ->> 'share')::numeric),
                    'over_cap_total', coalesce(sum((e ->> 'over_cap')::int), 0),
                    'days', v_new_days)
                  from jsonb_array_elements(v_new_days) with ordinality as w(e, o)),
    'slices', (select coalesce(jsonb_object_agg(ps.slice, jsonb_build_object(
                 'avg_position', ps.avg_position,
                 'familiar_served', ps.familiar_served,
                 'new_served', ps.new_served,
                 'familiar_min_repeat_gap', (select min(fg.gap) from fam_gaps fg where fg.slice = ps.slice)
               )), '{}')
               from per_slice ps),
    'ideal_avg_position', round((p_count + 1) / 2.0, 1),
    'repeat_gap', (select jsonb_build_object(
                     'min', min(g.gap),
                     'median', percentile_cont(0.5) within group (order by g.gap),
                     'repeats', count(g.gap))
                   from gaps g where g.gap is not null),
    'heard_gap', (select jsonb_build_object(
                    'min', min(g.gap),
                    'median', percentile_cont(0.5) within group (order by g.gap),
                    'repeats', count(g.gap))
                  from heard_gaps g where g.gap is not null),
    'songs', (select coalesce(jsonb_agg(jsonb_build_object(
                'song_id', ps.song_id, 'title', s.title, 'artist', s.artist,
                'served', ps.served, 'heard', ps.heard)
                order by ps.served desc, s.artist, s.title), '[]')
              from per_song ps join public.drive_mix_songs s on s.id = ps.song_id),
    'artists', (select coalesce(jsonb_agg(jsonb_build_object(
                  'artist_key', pa.artist_key, 'served', pa.served,
                  'days_appeared', pa.days_appeared, 'pool_songs', pa.pool_songs)
                  order by pa.days_appeared desc, pa.served desc, pa.artist_key), '[]')
                from per_artist pa),
    'shortfalls', v_short
  ) into v_result;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."drive_mix_simulate"("p_start" "date", "p_days" integer, "p_heard_per_day" integer, "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."drive_mix_simulate"("p_start" "date", "p_days" integer, "p_heard_per_day" integer, "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean) IS 'DJ: run drive_mix_pick for p_days consecutive days (cap 120) from p_start without writing anything, through the same code path as a real pick, at any count from 1 to 200. Needs a signed-in user. Starts from real recency and play days (one aggregate) and the real last serving before p_start, with each song''s run start. Each day the first p_heard_per_day songs (null = all) count as heard that day, for recency, play days (so new songs become familiar) and the artist cooldown; the rest carry over. Returns one json object: quotas_used, artist_cap_used, new_songs (cap_per_day, share avg, avg from day 2, min, max, over_cap_total, per day), cooling_breaks (familiar songs served by a cooling artist), slices (per natural slice: avg_position against ideal_avg_position, familiar_served, new_served, familiar_min_repeat_gap), repeat_gap, heard_gap, carried_per_day_avg, cooling_fills, per-song served/heard, per-artist served, days_appeared and pool_songs, expected_gap_days, and shortfalls.';



CREATE OR REPLACE FUNCTION "public"."drive_mix_songs_set_artist_key"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_key text;
begin
  if new.artist_key is null or btrim(new.artist_key) = '' then
    v_key := btrim((regexp_split_to_array(
      lower(btrim(new.artist)),
      '\s*(,|&|\+|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s)\s*'))[1]);
    if v_key is null or v_key = '' then
      v_key := lower(btrim(new.artist));
    end if;
    new.artist_key := v_key;
  else
    new.artist_key := lower(btrim(new.artist_key));
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."drive_mix_songs_set_artist_key"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."drive_mix_songs_set_artist_key"() IS 'DJ: fills drive_mix_songs.artist_key from artist when it is not supplied (first name of a collaboration, lower-cased), and lower-cases a supplied one.';



CREATE TABLE IF NOT EXISTS "public"."drive_mix_songs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "video_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "artist" "text" NOT NULL,
    "artist_key" "text" NOT NULL,
    "decade" smallint,
    "genre" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "source" "text" NOT NULL,
    "retired_reason" "text",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "thumbs" "text",
    "thumbs_at" timestamp with time zone,
    CONSTRAINT "drive_mix_songs_artist_key_check" CHECK (("btrim"("artist_key") <> ''::"text")),
    CONSTRAINT "drive_mix_songs_decade_check" CHECK ((("decade" IS NULL) OR ((("decade" >= 1900) AND ("decade" <= 2090)) AND ((("decade")::integer % 10) = 0)))),
    CONSTRAINT "drive_mix_songs_genre_check" CHECK ((("genre" IS NULL) OR ("genre" = ANY (ARRAY['pop'::"text", 'rock'::"text", 'alternative'::"text", 'country'::"text", 'rap'::"text", 'rnb'::"text", 'dance'::"text", 'other'::"text"])))),
    CONSTRAINT "drive_mix_songs_retired_reason_check" CHECK ((("retired_reason" IS NULL) OR ("status" = 'retired'::"text"))),
    CONSTRAINT "drive_mix_songs_source_check" CHECK (("source" = ANY (ARRAY['playlist_seed'::"text", 'artist_top'::"text", 'history_sweep'::"text", 'manual'::"text"]))),
    CONSTRAINT "drive_mix_songs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'retired'::"text"]))),
    CONSTRAINT "drive_mix_songs_thumbs_at_check" CHECK ((("thumbs" IS NULL) OR ("thumbs_at" IS NOT NULL))),
    CONSTRAINT "drive_mix_songs_thumbs_check" CHECK ((("thumbs" IS NULL) OR ("thumbs" = ANY (ARRAY['up'::"text", 'down'::"text"]))))
);


ALTER TABLE "public"."drive_mix_songs" OWNER TO "postgres";


COMMENT ON TABLE "public"."drive_mix_songs" IS 'DJ: Drive Mix song pool. Songs Alex knows, each tagged with decade and genre, from which drive_mix_pick chooses the daily Drive Mix playlist. Only status = active with decade and genre set is ever picked.';



COMMENT ON COLUMN "public"."drive_mix_songs"."id" IS 'Surrogate key.';



COMMENT ON COLUMN "public"."drive_mix_songs"."user_id" IS 'Owner. Set explicitly when inserting from the SQL editor, where auth.uid() is null.';



COMMENT ON COLUMN "public"."drive_mix_songs"."video_id" IS 'YouTube video id, unique per user. Recency is resolved through it: video_id -> dj_tracks -> coalesce(canonical_track_id, id) -> dj_plays. A video_id with no dj_tracks row counts as never heard.';



COMMENT ON COLUMN "public"."drive_mix_songs"."title" IS 'Track title as YouTube gives it.';



COMMENT ON COLUMN "public"."drive_mix_songs"."artist" IS 'Display billing as YouTube gives it. For swept songs, the canonical dj_tracks row''s artist.';



COMMENT ON COLUMN "public"."drive_mix_songs"."artist_key" IS 'Normalised primary artist for the per-artist cap: lower-cased, trimmed, first name of a collaboration. Filled by trigger from artist when not supplied; set it by hand when the default is wrong.';



COMMENT ON COLUMN "public"."drive_mix_songs"."decade" IS '1950, 1960 ... 2020. Null until tagged. Slices: 1980 and earlier -> 1980s-and-earlier; 1990, 2000 -> 1990s-2000s; 2010 and later -> 2010s-2020s; genre country or rap overrides the decade.';



COMMENT ON COLUMN "public"."drive_mix_songs"."genre" IS 'pop, rock, alternative, country, rap, rnb, dance or other. Null until tagged. country and rap always count in the country-and-rap slice.';



COMMENT ON COLUMN "public"."drive_mix_songs"."status" IS 'pending = pooled but not yet tagged and reviewed; active = pickable; retired = never picked.';



COMMENT ON COLUMN "public"."drive_mix_songs"."source" IS 'How the song entered the pool: playlist_seed, artist_top, history_sweep or manual.';



COMMENT ON COLUMN "public"."drive_mix_songs"."retired_reason" IS 'Why the song was retired. Only allowed when status is retired.';



COMMENT ON COLUMN "public"."drive_mix_songs"."added_at" IS 'When the song entered the pool.';



COMMENT ON COLUMN "public"."drive_mix_songs"."thumbs" IS 'Alex''s latest thumb: up, down, or null. down = never picked, whatever the status. up = always counts as familiar. Set by update_drive_mix_thumbs.';



COMMENT ON COLUMN "public"."drive_mix_songs"."thumbs_at" IS 'When the latest thumb (or its clearing) happened. A thumb older than this is ignored, so the latest thumb wins.';



CREATE OR REPLACE FUNCTION "public"."drive_mix_sweep"() RETURNS SETOF "public"."drive_mix_songs"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  r     public.drive_mix_songs;
begin
  if v_uid is null then
    raise exception 'drive_mix_sweep: no signed-in user. Run it through the create_drive_mix_sweep tool, not the SQL editor.';
  end if;

  for r in
    with played as (
      select coalesce(t.canonical_track_id, t.id) as grp
      from public.dj_plays p
      join public.dj_tracks t on t.id = p.track_id
      where p.user_id = v_uid
      group by 1
      having count(distinct p.played_on) >= 2
    ),
    pooled as (
      select distinct coalesce(t.canonical_track_id, t.id) as grp
      from public.drive_mix_songs s
      join public.dj_tracks t on t.user_id = s.user_id and t.video_id = s.video_id
      where s.user_id = v_uid
    ),
    candidates as (
      select c.video_id, c.title, c.artist
      from played g
      join public.dj_tracks c on c.id = g.grp
      where g.grp not in (select grp from pooled)
        and c.artist is not null
        and btrim(c.artist) <> ''
        and c.artist <> 'Release'
        -- Only ACTIVE jazz tags, matched on the exact dj_tracks.artist string of
        -- any track in the group. Rejected tags are decisions not to tag.
        and not exists (
          select 1
          from public.dj_tracks v
          join public.dj_artist_tags at on at.artist = v.artist
          where (v.id = g.grp or v.canonical_track_id = g.grp)
            and at.tag = 'jazz'
            and at.status = 'active'
        )
    )
    insert into public.drive_mix_songs (user_id, video_id, title, artist, status, source)
    select v_uid, cd.video_id, cd.title, cd.artist, 'pending', 'history_sweep'
    from candidates cd
    on conflict (user_id, video_id) do nothing
    returning *
  loop
    return next r;
  end loop;
end;
$$;


ALTER FUNCTION "public"."drive_mix_sweep"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."drive_mix_sweep"() IS 'DJ: add to the Drive Mix pool, as pending, every canonical track group played on at least two different days that is not already pooled (by group), has no track by an artist with an ACTIVE jazz tag (exact dj_tracks.artist match), and is not credited to Release. Inserts the canonical row''s video_id, title and artist; decade and genre stay null. Returns the rows added. Refuses without a signed-in user.';



CREATE OR REPLACE FUNCTION "public"."executions_last_completed"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_intents text[];
  v_items   text[];
  v_id      text;
begin
  -- Nothing to do unless a completed execution appears, changes or disappears.
  if not (coalesce(tg_op <> 'INSERT' and old.status = 'closed' and old.outcome = 'done', false)
          or coalesce(tg_op <> 'DELETE' and new.status = 'closed' and new.outcome = 'done', false)) then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and old.status     is not distinct from new.status
     and old.outcome    is not distinct from new.outcome
     and old.closed_at  is not distinct from new.closed_at
     and old.started_at is not distinct from new.started_at
     and old.intent_id  is not distinct from new.intent_id
     and old.item_ids   is not distinct from new.item_ids then
    return null;
  end if;

  v_intents := array_remove(array[
    case when tg_op <> 'INSERT' then old.intent_id end,
    case when tg_op <> 'DELETE' then new.intent_id end], null);

  select coalesce(array_agg(distinct v), '{}') into v_items from (
    select jsonb_array_elements_text(old.item_ids) as v
     where tg_op <> 'INSERT' and jsonb_typeof(old.item_ids) = 'array'
    union
    select jsonb_array_elements_text(new.item_ids)
     where tg_op <> 'DELETE' and jsonb_typeof(new.item_ids) = 'array'
    union
    select t.item_id from public.intents t
     where t.id = any(v_intents) and t.item_id is not null
  ) s;

  foreach v_id in array v_intents loop
    perform public.recalc_last_completed_intent(v_id);
  end loop;
  foreach v_id in array v_items loop
    perform public.recalc_last_completed_item(v_id);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."executions_last_completed"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."executions_last_completed"() IS 'Restructure P2. AFTER INSERT/UPDATE/DELETE on executions: recalculates last_completed_at on the intention(s) and item(s) touched by a completed execution — completing, reopening, editing or deleting one.';



CREATE OR REPLACE FUNCTION "public"."get_platform_contract"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'platform'
    AS $$
begin
  return jsonb_build_object(
    'platform_schema_comment',
      obj_description('platform'::regnamespace::oid, 'pg_namespace'),
    'registered_tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'table',       r.table_name,
                'policy_mode', r.policy_mode,
                'audited',     r.audited,
                'exempt',      r.exempt,
                'notes',       r.notes
              ) order by r.table_name), '[]'::jsonb)
        from platform.registry r
    ),
    'conformance', platform.check_conformance()
  );
end;
$$;


ALTER FUNCTION "public"."get_platform_contract"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_platform_contract"() IS 'The platform contract in one call: the COMMENT ON SCHEMA platform text (the
authoritative rules for new tables and tools), the registry roster, and a live
conformance report. A design chat should read this before proposing new tables.
Surfaced as the MCP get_platform_contract tool.';



CREATE OR REPLACE FUNCTION "public"."get_schema_info"("target_table" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'platform'
    AS $$
declare
  v_oid     oid;
  v_result  jsonb;
begin
  -- ALL-TABLES branch: contract first, then every table under "tables".
  if target_table is null or target_table = '' then
    select coalesce(jsonb_object_agg(t.relname, public.get_schema_info(t.relname)),
                    '{}'::jsonb)
      into v_result
      from pg_class t
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relkind = 'r';

    return jsonb_build_object(
      'platform_schema_comment',
        obj_description('platform'::regnamespace::oid, 'pg_namespace'),
      'conformance', platform.check_conformance(),
      'tables', v_result
    );
  end if;

  select c.oid into v_oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = target_table and c.relkind = 'r';

  if v_oid is null then
    return jsonb_build_object('error', format('table public.%s not found', target_table));
  end if;

  select jsonb_build_object(
    'table',         target_table,
    'table_comment', obj_description(v_oid, 'pg_class'),
    'columns', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'name', a.attname,
                'type', format_type(a.atttypid, a.atttypmod),
                'nullable', not a.attnotnull,
                'default', pg_get_expr(ad.adbin, ad.adrelid),
                'comment', col_description(v_oid, a.attnum)
              ) order by a.attnum), '[]'::jsonb)
        from pg_attribute a
        left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
       where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped
    ),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'name', ic.relname, 'definition', pg_get_indexdef(ix.indexrelid)
              ) order by ic.relname), '[]'::jsonb)
        from pg_index ix join pg_class ic on ic.oid = ix.indexrelid
       where ix.indrelid = v_oid
    ),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'name', conname,
                'type', case contype when 'p' then 'PRIMARY KEY' when 'f' then 'FOREIGN KEY'
                          when 'u' then 'UNIQUE' when 'c' then 'CHECK' else contype::text end,
                'definition', pg_get_constraintdef(oid)
              ) order by conname), '[]'::jsonb)
        from pg_constraint
       where conrelid = v_oid and conname not like '2200\_%'
    ),
    'rls_policies', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'name', polname,
                'command', case polcmd when '*' then 'ALL' when 'r' then 'SELECT'
                             when 'a' then 'INSERT' when 'w' then 'UPDATE'
                             when 'd' then 'DELETE' else polcmd::text end,
                'using', pg_get_expr(polqual, polrelid),
                'with_check', pg_get_expr(polwithcheck, polrelid)
              ) order by polname), '[]'::jsonb)
        from pg_policy where polrelid = v_oid
    ),
    'grants', (
      select coalesce(jsonb_object_agg(grantee, privs), '{}'::jsonb)
        from (
          select grantee, jsonb_agg(privilege_type order by privilege_type) as privs
            from information_schema.role_table_grants
           where table_schema = 'public' and table_name = target_table
             and grantee in ('authenticated', 'anon', 'service_role')
           group by grantee
        ) g
    ),
    'registry', (
      select to_jsonb(r) - 'table_name'
        from platform.registry r
       where r.table_name = 'public.' || target_table
    )
  )
  into v_result;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."get_schema_info"("target_table" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_schema_info"("target_table" "text") IS 'Full schema for one public table, or the whole public schema when called with no
argument. Single-table: columns (with comments), indexes, constraints, RLS, grants,
registry. All-tables: { platform_schema_comment, conformance, tables:{...} } so the
contract is the first thing a design chat sees. SECURITY DEFINER; structural metadata
only, never row data.';



CREATE OR REPLACE FUNCTION "public"."inbox_outcome_valid"("p_outcome" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select jsonb_typeof(p_outcome) = 'array'
     and not exists (
       select 1 from jsonb_array_elements(p_outcome) e
       where jsonb_typeof(e) <> 'object'
          or jsonb_typeof(e->'table') is distinct from 'string'
          or jsonb_typeof(e->'id') is distinct from 'string'
          or btrim(e->>'table') = ''
          or btrim(e->>'id') = ''
     );
$$;


ALTER FUNCTION "public"."inbox_outcome_valid"("p_outcome" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."inbox_outcome_valid"("p_outcome" "jsonb") IS 'Alfred: true when an inbox.outcome value is an array of {table, id} objects with non-empty string values.';



CREATE OR REPLACE FUNCTION "public"."inbox_set_source_app"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.source_app is null
     and new.source_metadata ? 'app'
     and exists (select 1 from public.apps a where a.id = new.source_metadata->>'app') then
    new.source_app := new.source_metadata->>'app';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."inbox_set_source_app"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."inbox_set_source_app"() IS 'Alfred: on inbox insert, copies source_metadata->>''app'' into source_app when source_app is null and the value names a row in apps (wb-sync sets app = warren_buffet).';



CREATE OR REPLACE FUNCTION "public"."intents_last_completed"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if old.item_id is not null then
    perform public.recalc_last_completed_item(old.item_id);
  end if;
  if tg_op = 'UPDATE' and new.item_id is not null and new.item_id is distinct from old.item_id then
    perform public.recalc_last_completed_item(new.item_id);
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."intents_last_completed"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."intents_last_completed"() IS 'Restructure P2. AFTER UPDATE OF item_id or DELETE on intents: recalculates the old and new item''s last_completed_at.';



CREATE OR REPLACE FUNCTION "public"."ken_record_attempts"("p_attempts" "jsonb") RETURNS TABLE("item_id" "uuid", "mastery" numeric)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_rate constant numeric := 0.3;   -- how far each attempt moves mastery toward its target
  v_n    integer;
begin
  if p_attempts is null or jsonb_typeof(p_attempts) <> 'array' then
    raise exception 'ken_record_attempts: p_attempts must be a json array';
  end if;

  v_n := jsonb_array_length(p_attempts);

  if v_n = 0 then
    return;
  end if;

  if v_n > 50 then
    raise exception 'ken_record_attempts: batch capped at 50 attempts, got %', v_n;
  end if;

  return query
  with incoming as (
    select *
    from jsonb_to_recordset(p_attempts)
      as x (item_id uuid, result text, user_answer text, ken_assessment text)
  ),
  inserted as (
    insert into public.ken_attempts (item_id, result, user_answer, ken_assessment)
    select i.item_id, i.result, i.user_answer, i.ken_assessment
    from incoming i
    returning 1
  ),
  agg as (
    -- Several attempts on the same item in one batch collapse into a single
    -- move: the closed form of applying the same exponential step n times toward
    -- the mean target. Exact when the results agree, a fair approximation when
    -- they differ, and it removes any dependence on the order within a batch.
    select
      i.item_id,
      count(*)::integer as n,
      avg(case i.result
            when 'hit'     then 1.0
            when 'partial' then 0.5
            else                0.0
          end)::numeric as avg_target
    from incoming i
    group by i.item_id
  )
  update public.ken_items it
  set mastery = round(
        least(1.0, greatest(0.0,
          it.mastery + (1 - power(1 - v_rate, agg.n)) * (agg.avg_target - it.mastery)
        ))::numeric, 4),
      last_seen  = now(),
      updated_at = now()
  from agg
  where it.id = agg.item_id
  returning it.id, it.mastery;
end;
$$;


ALTER FUNCTION "public"."ken_record_attempts"("p_attempts" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ken_record_attempts"("p_attempts" "jsonb") IS 'Writes a buffered batch of attempts and folds each item''s mastery forward in
place, in one round-trip. Mastery moves 30% of the remaining distance toward the
attempt''s target (hit 1.0, partial 0.5, miss 0.0), so it converges without any
single answer swinging it hard. Never aggregates ken_attempts — attempts exist to
reveal patterns, not to compute this number. Batch is capped at 50; anything
larger means the buffer was not being flushed at its natural seams.';



CREATE TABLE IF NOT EXISTS "public"."ken_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "area_id" "uuid" NOT NULL,
    "subtopic" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "mode" "text" NOT NULL,
    "accuracy" "text" NOT NULL,
    "volatility" "text",
    "prompt" "text" NOT NULL,
    "ground_truth" "text",
    "verified_at" timestamp with time zone,
    "tricky_fragments" "jsonb",
    "mastery" numeric DEFAULT 0 NOT NULL,
    "priority" numeric DEFAULT 1.0 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "superseded_by" "uuid",
    "last_seen" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ken_items_accuracy_check" CHECK (("accuracy" = ANY (ARRAY['strict'::"text", 'loose'::"text"]))),
    CONSTRAINT "ken_items_mastery_range" CHECK ((("mastery" >= (0)::numeric) AND ("mastery" <= (1)::numeric))),
    CONSTRAINT "ken_items_mode_check" CHECK (("mode" = ANY (ARRAY['recall'::"text", 'concept'::"text", 'lyric'::"text", 'procedure'::"text"]))),
    CONSTRAINT "ken_items_no_self_supersede" CHECK ((("superseded_by" IS NULL) OR ("superseded_by" <> "id"))),
    CONSTRAINT "ken_items_priority_positive" CHECK (("priority" > (0)::numeric)),
    CONSTRAINT "ken_items_procedure_has_no_ground_truth" CHECK ((("mode" <> 'procedure'::"text") OR ("ground_truth" IS NULL))),
    CONSTRAINT "ken_items_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'deprecated'::"text"]))),
    CONSTRAINT "ken_items_superseded_only_when_deprecated" CHECK ((("superseded_by" IS NULL) OR ("status" = 'deprecated'::"text"))),
    CONSTRAINT "ken_items_volatility_check" CHECK (((("accuracy" = 'strict'::"text") AND ("volatility" = ANY (ARRAY['stable'::"text", 'volatile'::"text"]))) OR (("accuracy" = 'loose'::"text") AND ("volatility" IS NULL))))
);


ALTER TABLE "public"."ken_items" OWNER TO "postgres";


COMMENT ON TABLE "public"."ken_items" IS 'The atomic unit: one fact, concept, lyric line, or procedure. Never updated to
carry a new value — when a strict-volatile fact changes, the new value is a NEW
row and the old row flips to deprecated with superseded_by pointing at it.
Deprecated rows are Ken''s history and are what let him actively un-teach a
drilled-in-wrong answer.';



COMMENT ON COLUMN "public"."ken_items"."mode" IS 'recall    — hard facts, say-it-cold. Near-exact grading.
concept   — vocabulary and fluency. Ken evaluates free text and the feedback IS
            the learning. Teaches new material, not just tests it.
lyric     — fill-in-the-blank against the user''s OWN stored lyric text, held in
            prompt. Ken never reproduces lyrics from the web or from model memory.
procedure — a method executed against a generated input (Doomsday weekday, interval
            spelling, unit conversion). Ken invents the question and computes the
            answer; nothing is stored to compare against.';



COMMENT ON COLUMN "public"."ken_items"."accuracy" IS 'strict — Ken must be right: either a stored ground_truth or a live search. He
         never asserts a checkable fact he cannot back. On a procedure item strict
         means "compute deterministically, never estimate".
loose  — directional is fine; roughly right is acceptable.
Defaults by mode (recall and procedure -> strict, concept -> loose) are applied by
the tools, not here, because any item may override them.';



COMMENT ON COLUMN "public"."ken_items"."volatility" IS 'stable   — store the truth once and be done (historical dates, settled science).
volatile — the value drifts. Store last-known plus verified_at; Ken re-checks on
           age and may say "as of March it was X — still current?".
Null exactly when accuracy is loose.';



COMMENT ON COLUMN "public"."ken_items"."ground_truth" IS 'The verified answer for a strict item. Deliberately nullable: an item may be
captured before it has been verified. Such a row is NOT askable, and ken_select_batch
excludes it — the strict guarantee is enforced at the point of asking rather than at
insert, so capture stays friction-free.';



COMMENT ON COLUMN "public"."ken_items"."tricky_fragments" IS 'HEAVY JSONB — MUST BE EXCLUDED FROM ALL LIST QUERIES. Lazy-load only when quizzing
a lyric item, mirroring the sam_songs.measures pattern. Marks the mondegreen-prone
words to blank ("kiss the sky", not "kiss this guy"). Null on every non-lyric item.';



COMMENT ON COLUMN "public"."ken_items"."mastery" IS 'Learner-model state, 0 to 1, updated IN PLACE on each attempt. Read directly;
never aggregated from ken_attempts. Rollups ("wave mechanics still shaky") are
DERIVED on the fly from items grouped by subtopic and are deliberately not stored.';



COMMENT ON COLUMN "public"."ken_items"."priority" IS 'Item heat within rotation. Floor is structural (> 0) so "less interesting" cools an
item without ever hiding it — a cooled item still ambushes occasionally, which is a
feature. To actually remove something from rotation, set status = deprecated.';



CREATE OR REPLACE FUNCTION "public"."ken_select_batch"("p_limit" integer DEFAULT 10, "p_area_id" "uuid" DEFAULT NULL::"uuid", "p_mode" "text" DEFAULT NULL::"text") RETURNS SETOF "public"."ken_items"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select i.*
  from public.ken_items i
  join public.ken_areas a on a.id = i.area_id
  left join lateral (
    select avg(case when t.result = 'miss' then 1.0
                    when t.result = 'partial' then 0.5
                    else 0.0 end) as miss_rate
    from (
      select result
      from public.ken_attempts
      where item_id = i.id
      order by asked_at desc
      limit 5
    ) t
  ) m on true
  where i.status = 'active'
    and (p_area_id is null or i.area_id = p_area_id)
    and (p_mode    is null or i.mode    = p_mode)
    -- A strict item with no verified value is not askable yet. Procedure and
    -- lyric items are exempt: neither stores its answer in ground_truth.
    and (
      i.accuracy <> 'strict'
      or i.mode in ('procedure', 'lyric')
      or i.ground_truth is not null
    )
  order by
    random() ^ (
      1.0 / (
          a.priority
        * i.priority
        * (1.0 + least(
              coalesce(extract(epoch from (now() - i.last_seen)) / 86400.0, 30.0),
              30.0
            ) / 15.0)
        * (1.0 + coalesce(m.miss_rate, 0.0))
        * (1.05 - (i.mastery * 0.8))
      )
    ) desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;


ALTER FUNCTION "public"."ken_select_batch"("p_limit" integer, "p_area_id" "uuid", "p_mode" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ken_select_batch"("p_limit" integer, "p_area_id" "uuid", "p_mode" "text") IS 'Weighted-random selection without replacement (Efraimidis-Spirakis: order by
random()^(1/weight) descending). Weight combines area priority, item priority,
days since last_seen, recent miss rate, and mastery. Every factor is strictly
positive, so nothing is ever fully excluded by weight alone — only status =
deprecated removes a row from rotation. Limit is clamped here as well as in the
tool, so the cap holds no matter who calls it.';



CREATE OR REPLACE FUNCTION "public"."last_completed_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if pg_trigger_depth() <= 1 then
    if tg_op = 'INSERT' then
      new.last_completed_at := null;
    else
      new.last_completed_at := old.last_completed_at;
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."last_completed_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."last_completed_guard"() IS 'Restructure P2. BEFORE INSERT OR UPDATE on items and intents: last_completed_at only changes from inside the recalculation triggers.';



CREATE OR REPLACE FUNCTION "public"."notes_delete_for_target"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  delete from public.notes where target_type = tg_argv[0] and target_id = old.id;
  return null;
end;
$$;


ALTER FUNCTION "public"."notes_delete_for_target"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notes_delete_for_target"() IS 'Restructure P2. AFTER DELETE on items (arg ''item'') and intents (arg ''intention''): deletes the record''s notes.';



CREATE OR REPLACE FUNCTION "public"."notes_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."notes_touch_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notes_touch_updated_at"() IS 'Alfred: stamps notes.updated_at.';



CREATE OR REPLACE FUNCTION "public"."platform_check_call_budget"("p_tool" "text", "p_args_hash" "text" DEFAULT NULL::"text", "p_window_seconds" integer DEFAULT 300, "p_max_calls" integer DEFAULT 60) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'platform', 'public'
    AS $$
declare
  v_user text;
begin
  v_user := coalesce(auth.uid()::text, 'anonymous');

  return platform.check_call_budget(
    p_user_id        => v_user,
    p_tool           => p_tool,
    p_args_hash      => p_args_hash,
    p_window_seconds => p_window_seconds,
    p_max_calls      => p_max_calls
  );
end;
$$;


ALTER FUNCTION "public"."platform_check_call_budget"("p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."platform_check_call_budget"("p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer) IS 'MCP-facing wrapper for platform.check_call_budget. Called at the top of every
tool via defineTool().

  const { data } = await ctx.db.rpc("platform_check_call_budget", {
    p_tool: toolName,
    p_args_hash: hashArgs(args)
  });

Returns jsonb: { allowed, reason, calls_in_window, repeat_count, message }.
When allowed is false, throw an Error whose message is `message` VERBATIM —
the terminal do-not-retry wording is what stops a looping agent.

user_id is derived from auth.uid() inside this function and is deliberately NOT
a parameter: a caller-supplied user_id could be used to burn another user''s
budget or evade its own.';



CREATE OR REPLACE FUNCTION "public"."platform_check_conformance"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'platform', 'public'
    AS $$
begin
  return platform.check_conformance();
end;
$$;


ALTER FUNCTION "public"."platform_check_conformance"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."platform_check_conformance"() IS 'MCP-facing wrapper for platform.check_conformance. Surfaced as the
check_platform_conformance tool and run as the final step of every migration
block. Returns CONFORMANT or a per-table list of contract violations.';



CREATE OR REPLACE FUNCTION "public"."platform_recent_audit"("p_limit" integer DEFAULT 20, "p_actor" "text" DEFAULT NULL::"text", "p_minutes" integer DEFAULT 60) RETURNS TABLE("id" bigint, "table_name" "text", "record_id" "text", "op" "text", "actor" "text", "occurred_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'platform', 'public'
    AS $$
begin
  return query
  select a.id, a.table_name, a.record_id, a.op, a.actor, a.occurred_at
    from platform.audit_log a
   where a.user_id = auth.uid()::text
     and a.occurred_at > now() - make_interval(mins => greatest(p_minutes, 1))
     and (p_actor is null or a.actor = p_actor)
   order by a.id desc
   limit least(coalesce(p_limit, 20), 100);
end;
$$;


ALTER FUNCTION "public"."platform_recent_audit"("p_limit" integer, "p_actor" "text", "p_minutes" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."platform_recent_audit"("p_limit" integer, "p_actor" "text", "p_minutes" integer) IS 'Recent audited changes for the calling user. Metadata only — old_row/new_row
are deliberately excluded to keep payloads small and avoid dumping full record
bodies into an LLM context window. Inspect those directly in SQL when performing
a rollback.

Rollback itself is NOT exposed. platform.rollback_audit_entry() is a human
operation run from the SQL editor.';



CREATE OR REPLACE FUNCTION "public"."platform_search_executions"("p_intent_id" "text" DEFAULT NULL::"text", "p_context_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_limit" integer DEFAULT 20) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with filtered as (
    select
      x.id                as execution_id,
      i.text              as intent_text,
      i.item_id           as intent_item_id,
      ev.time             as event_date,
      x.started_at,
      x.closed_at,
      x.status,
      x.outcome,
      x.item_ids,
      x.context_id,
      (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at)
                                 order by n.created_at), '[]'::jsonb)
         from notes n where n.execution_id = x.id) as notes
      from executions x
      left join intents i  on i.id  = x.intent_id
      left join events  ev on ev.id = x.event_id
     where (p_intent_id  is null or x.intent_id  = p_intent_id)
       and (p_context_id is null or x.context_id = p_context_id)
       and (p_date_from is null or (ev.time is not null and ev.time >= p_date_from))
       and (p_date_to   is null or (ev.time is not null and ev.time <= p_date_to))
  )
  select jsonb_build_object(
    'rows',
      coalesce(
        (select jsonb_agg(row_to_json(y) order by y.started_at desc nulls last,
                                                  y.execution_id desc)
           from (select * from filtered
                  order by started_at desc nulls last, execution_id desc
                  limit p_limit) y),
        '[]'::jsonb),
    'total',
      (select count(*) from filtered)
  );
$$;


ALTER FUNCTION "public"."platform_search_executions"("p_intent_id" "text", "p_context_id" "text", "p_date_from" "date", "p_date_to" "date", "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."platform_search_executions"("p_intent_id" "text", "p_context_id" "text", "p_date_from" "date", "p_date_to" "date", "p_limit" integer) IS 'Alfred: get_execution_history''s reader. Filters intent, context and the event DATE RANGE in Postgres before the limit — the date lives on events.time and executions has no FK to events, so PostgREST cannot embed the join and the handler used to filter dates in memory after the limit. Returns { rows, total } from one snapshot for an honest truncation note. SECURITY INVOKER on purpose: executions RLS is owner-OR-shared-context and must not be re-implemented here. See migration 077. Restructure P2: each row carries its notes (id, body, created_at), read under notes RLS.';



CREATE OR REPLACE FUNCTION "public"."platform_search_items"("p_context_id" "text" DEFAULT NULL::"text", "p_search_text" "text" DEFAULT NULL::"text", "p_tags" "text"[] DEFAULT NULL::"text"[], "p_limit" integer DEFAULT 20, "p_status" "text"[] DEFAULT NULL::"text"[]) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with filtered as (
    select i.id, i.name, i.description, i.context_id, i.tags, i.is_capture_target,
           i.created_at, i.status, i.closed_reason, i.last_completed_at
      from items i
     where i.user_id = auth.uid()
       and i.archived = false
       and (p_context_id  is null or i.context_id = p_context_id)
       and (p_search_text is null or
            i.name ilike '%' || p_search_text || '%' or
            i.description ilike '%' || p_search_text || '%' or
            exists (select 1 from notes n
                     where n.body ilike '%' || p_search_text || '%'
                       and ((n.target_type = 'item' and n.target_id = i.id)
                            or (n.target_type = 'intention'
                                and n.target_id in (select t.id from intents t where t.item_id = i.id))
                            or n.execution_id in (select x.id from executions x where x.item_ids ? i.id))))
       and (p_tags is null
            or array_length(p_tags, 1) is null
            or i.tags && p_tags)
       and (p_status is null
            or array_length(p_status, 1) is null
            or i.status = any(p_status))
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
$$;


ALTER FUNCTION "public"."platform_search_items"("p_context_id" "text", "p_search_text" "text", "p_tags" "text"[], "p_limit" integer, "p_status" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."platform_search_items"("p_context_id" "text", "p_search_text" "text", "p_tags" "text"[], "p_limit" integer, "p_status" "text"[]) IS 'Alfred: get_items'' reader. Live items owned by the caller, filtered by context, search text, tags (any-of) and status (any-of) before the limit. Returns { rows, total }. Restructure P1 added status and p_status. Restructure P2: search text also matches notes on the item, its intentions and its executions; rows carry last_completed_at. Restructure P4: rows carry closed_reason.';



CREATE OR REPLACE FUNCTION "public"."recalc_last_completed_intent"("p_intent_id" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  update public.intents t
     set last_completed_at = s.v
    from (select max(coalesce(x.closed_at, x.started_at)) as v
            from public.executions x
           where x.intent_id = p_intent_id
             and x.status = 'closed' and x.outcome = 'done') s
   where t.id = p_intent_id
     and t.last_completed_at is distinct from s.v;
$$;


ALTER FUNCTION "public"."recalc_last_completed_intent"("p_intent_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."recalc_last_completed_intent"("p_intent_id" "text") IS 'Restructure P2. Recomputes one intention''s last_completed_at. Trigger use only.';



CREATE OR REPLACE FUNCTION "public"."recalc_last_completed_item"("p_item_id" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  update public.items i
     set last_completed_at = s.v
    from (select max(coalesce(x.closed_at, x.started_at)) as v
            from public.executions x
           where x.status = 'closed' and x.outcome = 'done'
             and (x.item_ids ? p_item_id
                  or x.intent_id in (select t.id from public.intents t where t.item_id = p_item_id))) s
   where i.id = p_item_id
     and i.last_completed_at is distinct from s.v;
$$;


ALTER FUNCTION "public"."recalc_last_completed_item"("p_item_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."recalc_last_completed_item"("p_item_id" "text") IS 'Restructure P2. Recomputes one item''s last_completed_at. Trigger use only.';



CREATE OR REPLACE FUNCTION "public"."record_lookup_tables"() RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select c.relname::text
    from platform.registry r
    join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(r.table_name::text)
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
   where not r.exempt
     and n.nspname = 'public'
   order by c.relname;
$$;


ALTER FUNCTION "public"."record_lookup_tables"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reminders_follow_intent_archive"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.archived is true and old.archived is not true then
    update public.reminders
       set state = 'cancelled', cancel_reason = 'intent_archived'
     where intent_id = new.id
       and state = 'scheduled';
  elsif new.archived is not true and old.archived is true then
    update public.reminders
       set state = 'scheduled', cancel_reason = null
     where intent_id = new.id
       and state = 'cancelled'
       and cancel_reason = 'intent_archived'
       and due_at > now();
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."reminders_follow_intent_archive"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reminders_follow_intent_archive"() IS 'Alfred: archiving an intention cancels its scheduled reminders (cancel_reason intent_archived); un-archiving re-arms only those intent_archived rows still in the future. Reminders cancelled for any other reason stay cancelled.';



CREATE OR REPLACE FUNCTION "public"."reminders_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."reminders_touch_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reminders_touch_updated_at"() IS 'Alfred: stamps reminders.updated_at.';



CREATE OR REPLACE FUNCTION "public"."replace_sam_song_scores"("p_song_id" "uuid", "p_scores_version" integer, "p_computed_from" timestamp with time zone, "p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_inserted integer;
begin
  -- Under RLS a song the caller does not own is simply invisible, which would
  -- otherwise turn this into a silent no-op.
  if not exists (select 1 from public.sam_songs where id = p_song_id) then
    raise exception 'replace_sam_song_scores: song % not found', p_song_id
      using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_sam_song_scores: p_rows must be a JSON array';
  end if;

  delete from public.sam_song_scores where song_id = p_song_id;

  insert into public.sam_song_scores (
    song_id, measure_number, beats, rh_onsets, lh_onsets, rh_stack, lh_stack,
    rh_stretch, lh_stretch, rh_jump, lh_jump, rhythm_variety, accidentals,
    scores_version, computed_from_edited_at
  )
  select
    p_song_id, r.measure_number, r.beats, r.rh_onsets, r.lh_onsets, r.rh_stack, r.lh_stack,
    r.rh_stretch, r.lh_stretch, r.rh_jump, r.lh_jump, r.rhythm_variety, r.accidentals,
    p_scores_version, p_computed_from
  from jsonb_to_recordset(p_rows) as r(
    measure_number integer,
    beats          double precision,
    rh_onsets      integer,
    lh_onsets      integer,
    rh_stack       integer,
    lh_stack       integer,
    rh_stretch     integer,
    lh_stretch     integer,
    rh_jump        integer,
    lh_jump        integer,
    rhythm_variety integer,
    accidentals    integer
  );

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;


ALTER FUNCTION "public"."replace_sam_song_scores"("p_song_id" "uuid", "p_scores_version" integer, "p_computed_from" timestamp with time zone, "p_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_sam_song_scores"("p_song_id" "uuid", "p_scores_version" integer, "p_computed_from" timestamp with time zone, "p_rows" "jsonb") IS 'SAM analyzer (M4). Replace one song''s difficulty rows wholesale — delete then insert in one transaction — stamping each with the scores version and the measures_edited_at value they were computed from. Called via computeSongScores (the sam-song-scores Edge Function and the get_sam_song_scores MCP tool). Returns rows inserted; [] clears.';



CREATE OR REPLACE FUNCTION "public"."resolve_record"("p_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $_$
declare
  v_tbl       text;
  v_rel       regclass;
  v_is_uuid   boolean;
  v_uuid      uuid;
  v_row       jsonb;
  v_first     jsonb;
  v_table     text;
  v_count     int := 0;
begin
  if p_id is null or btrim(p_id) = '' then
    return null;
  end if;

  -- uuid columns are compared as uuid so their primary-key index is used;
  -- a non-uuid id cannot be in a uuid column, so those tables are skipped.
  if p_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := p_id::uuid;
  end if;

  for v_tbl in select * from public.record_lookup_tables()
  loop
    v_rel := pg_catalog.to_regclass(format('public.%I', v_tbl));
    if v_rel is null then
      continue;
    end if;

    select a.atttypid = 'uuid'::regtype into v_is_uuid
      from pg_catalog.pg_attribute a
     where a.attrelid = v_rel and a.attname = 'id' and not a.attisdropped;

    if v_is_uuid and v_uuid is null then
      continue;
    end if;
    if not pg_catalog.has_table_privilege(v_rel, 'SELECT') then
      continue;
    end if;

    v_row := null;
    begin
      if v_is_uuid then
        execute format('select pg_catalog.to_jsonb(x) from %s x where x.id = $1 limit 1', v_rel)
          into v_row using v_uuid;
      else
        execute format('select pg_catalog.to_jsonb(x) from %s x where x.id::text = $1 limit 1', v_rel)
          into v_row using p_id;
      end if;
    exception when insufficient_privilege then
      v_row := null;
    end;

    if v_row is not null then
      v_count := v_count + 1;
      if v_first is null then
        v_first := v_row;
        v_table := v_tbl;
      end if;
    end if;
  end loop;

  if v_first is null then
    return null;
  end if;

  return jsonb_build_object('table', v_table, 'row', v_first, 'match_count', v_count);
end;
$_$;


ALTER FUNCTION "public"."resolve_record"("p_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sam_create_practice_plan"("p_plan" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid          uuid := auth.uid();
  v_prev_plan_id uuid;
  v_plan_id      uuid;
  v_plan_song_id uuid;
  v_song_json    jsonb;
  v_item         jsonb;
  v_song         record;
  v_snippet      record;
  v_song_pos     integer := 0;
  v_item_pos     integer := 0;
  v_song_id      uuid;
  v_snippet_id   uuid;
  v_has_audio    boolean;
  v_free         boolean;
  v_bpm          integer;
  v_speed        integer;
  v_passes       integer;
  v_accuracy     integer;
  -- Warm-up ladder (milestone 4). v_resolved is what the item's ladder actually
  -- resolves to, which is only needed when goal_is_warmup is set.
  v_ladder       jsonb;
  v_goal_warmup  boolean;
  v_consecutive  boolean;
  v_resolved     jsonb;
begin
  if v_uid is null then
    raise exception 'sam_create_practice_plan: not authenticated.';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'sam_create_practice_plan: the plan must be a JSON object.';
  end if;
  if nullif(btrim(p_plan->>'review_instructions'), '') is null then
    raise exception 'sam_create_practice_plan: review_instructions is required.';
  end if;
  if jsonb_typeof(p_plan->'songs') is distinct from 'array'
     or jsonb_array_length(p_plan->'songs') = 0 then
    raise exception 'sam_create_practice_plan: songs must be a non-empty array.';
  end if;

  -- Supersede the current active plan. Everything below runs in this one
  -- transaction, so any validation failure rolls this back too.
  select id into v_prev_plan_id
    from sam_practice_plans
   where user_id = v_uid and status = 'active'
   for update;

  if v_prev_plan_id is not null then
    update sam_practice_plans
       set status = 'superseded', ended_at = now()
     where id = v_prev_plan_id;
  end if;

  insert into sam_practice_plans (supersedes_plan_id, day_note, internal_notes, review_instructions)
  values (
    v_prev_plan_id,
    nullif(btrim(p_plan->>'day_note'), ''),
    nullif(btrim(p_plan->>'internal_notes'), ''),
    btrim(p_plan->>'review_instructions')
  )
  returning id into v_plan_id;

  for v_song_json in select value from jsonb_array_elements(p_plan->'songs') loop
    v_song_pos := v_song_pos + 1;
    v_song_id  := nullif(v_song_json->>'song_id', '')::uuid;

    if v_song_id is null then
      raise exception 'sam_create_practice_plan: song entry % is missing song_id.', v_song_pos;
    end if;

    select id, title, archived, default_bpm, goal_bpm, goal_playback_speed, audio_file_path,
           warmup_ladder
      into v_song
      from sam_songs
     where id = v_song_id;

    if not found then
      raise exception 'sam_create_practice_plan: song % not found.', v_song_id;
    end if;
    if v_song.archived then
      raise exception 'sam_create_practice_plan: song "%" is archived.', v_song.title;
    end if;
    if exists (select 1 from sam_practice_plan_songs
                where plan_id = v_plan_id and song_id = v_song_id) then
      raise exception 'sam_create_practice_plan: song "%" is listed more than once.', v_song.title;
    end if;
    if jsonb_typeof(v_song_json->'items') is distinct from 'array'
       or jsonb_array_length(v_song_json->'items') = 0 then
      raise exception 'sam_create_practice_plan: song "%" needs a non-empty items array.', v_song.title;
    end if;

    v_has_audio := v_song.audio_file_path is not null;

    insert into sam_practice_plan_songs (plan_id, song_id, position, song_note, internal_notes)
    values (
      v_plan_id,
      v_song_id,
      v_song_pos,
      nullif(btrim(v_song_json->>'song_note'), ''),
      nullif(btrim(v_song_json->>'internal_notes'), '')
    )
    returning id into v_plan_song_id;

    for v_item in select value from jsonb_array_elements(v_song_json->'items') loop
      v_item_pos   := v_item_pos + 1;
      v_snippet_id := nullif(v_item->>'snippet_id', '')::uuid;
      v_free       := coalesce((v_item->>'is_free_play')::boolean, false);
      v_bpm        := (v_item->>'target_bpm')::integer;
      v_speed      := (v_item->>'target_playback_speed')::integer;
      v_passes     := (v_item->>'target_passes')::integer;
      v_accuracy   := (v_item->>'accuracy_target')::integer;
      -- A ladder is absent (inherit) or an array; a JSON null is treated as absent,
      -- so "warmup_ladder": null means the same as omitting it.
      v_ladder      := case when jsonb_typeof(v_item->'warmup_ladder') = 'array'
                            then v_item->'warmup_ladder' else null end;
      v_goal_warmup := coalesce((v_item->>'goal_is_warmup')::boolean, false);
      v_consecutive := coalesce((v_item->>'consecutive')::boolean, false);

      -- Snippet checks
      if v_snippet_id is not null then
        select id, song_id, title, archived, warmup_ladder
          into v_snippet
          from sam_snippets
         where id = v_snippet_id;

        if not found then
          raise exception 'sam_create_practice_plan: item % (song "%"): snippet % not found.',
            v_item_pos, v_song.title, v_snippet_id;
        end if;
        if v_snippet.song_id <> v_song_id then
          raise exception 'sam_create_practice_plan: item %: snippet "%" does not belong to song "%".',
            v_item_pos, v_snippet.title, v_song.title;
        end if;
        if v_snippet.archived then
          raise exception 'sam_create_practice_plan: item %: snippet "%" is archived.',
            v_item_pos, v_snippet.title;
        end if;
      end if;

      if exists (select 1 from sam_practice_plan_items
                  where plan_id = v_plan_id
                    and song_id = v_song_id
                    and snippet_id is not distinct from v_snippet_id) then
        raise exception 'sam_create_practice_plan: item %: song "%" already has an item for this exact range. One item per range per plan.',
          v_item_pos, v_song.title;
      end if;

      -- Pass and accuracy checks
      if v_passes is null or v_passes < 1 then
        raise exception 'sam_create_practice_plan: item % (song "%"): target_passes must be at least 1.',
          v_item_pos, v_song.title;
      end if;
      if v_free and v_accuracy is not null then
        raise exception 'sam_create_practice_plan: item % (song "%"): free play items take no accuracy_target.',
          v_item_pos, v_song.title;
      end if;
      if not v_free and (v_accuracy is null or v_accuracy < 1 or v_accuracy > 100) then
        raise exception 'sam_create_practice_plan: item % (song "%"): accuracy_target between 1 and 100 is required.',
          v_item_pos, v_song.title;
      end if;

      -- ---------------------------------------------------------------------
      -- Warm-up checks (warm-up spec §5.2). The table's own constraints enforce
      -- the ladder's SHAPE; these two are the rules a constraint cannot express —
      -- the second spans three tables.
      -- ---------------------------------------------------------------------
      if v_goal_warmup and v_free then
        raise exception 'sam_create_practice_plan: item % (song "%"): goal_is_warmup cannot be combined with is_free_play — a warm-up item needs an accuracy_target and free play forbids one.',
          v_item_pos, v_song.title;
      end if;

      if v_goal_warmup then
        -- The ladder this item will ACTUALLY run, resolved in the player's own
        -- order: the item's, then the snippet's, then the song's, then the app
        -- default. An item resolving to [] could never be completed, so it could
        -- never be done, so it is refused rather than written.
        v_resolved := coalesce(
          v_ladder,
          case when v_snippet_id is not null then v_snippet.warmup_ladder else null end,
          v_song.warmup_ladder,
          sam_default_warmup_ladder()
        );
        if jsonb_typeof(v_resolved) <> 'array' or jsonb_array_length(v_resolved) = 0 then
          raise exception 'sam_create_practice_plan: item % (song "%"): goal_is_warmup needs a ladder, but this range resolves to none — a level below it stores an empty ladder, which stops the chain. Give the item its own warmup_ladder.',
            v_item_pos, v_song.title;
        end if;
      end if;

      -- Tempo checks (spec §4)
      if v_has_audio then
        if v_song.default_bpm is null then
          raise exception 'sam_create_practice_plan: item %: song "%" has audio but no default_bpm.',
            v_item_pos, v_song.title;
        end if;
        v_bpm := coalesce(v_bpm, v_song.default_bpm);
        if v_bpm <> v_song.default_bpm then
          raise exception 'sam_create_practice_plan: item %: song "%" has audio, so target_bpm must equal its default_bpm (%). Set the target through target_playback_speed.',
            v_item_pos, v_song.title, v_song.default_bpm;
        end if;
        if v_speed is null and v_free then
          v_speed := v_song.goal_playback_speed;
        end if;
        if v_speed is null or v_speed < 1 then
          raise exception 'sam_create_practice_plan: item %: song "%" has audio, so target_playback_speed is required.',
            v_item_pos, v_song.title;
        end if;
      else
        v_speed := coalesce(v_speed, 100);
        if v_speed <> 100 then
          raise exception 'sam_create_practice_plan: item %: song "%" has no audio, so target_playback_speed must be 100.',
            v_item_pos, v_song.title;
        end if;
        if v_bpm is null and v_free then
          v_bpm := v_song.goal_bpm;
        end if;
        if v_bpm is null or v_bpm < 1 then
          raise exception 'sam_create_practice_plan: item %: song "%" needs a target_bpm.',
            v_item_pos, v_song.title;
        end if;
      end if;

      insert into sam_practice_plan_items (
        plan_id, plan_song_id, song_id, snippet_id, position, is_free_play,
        target_bpm, target_playback_speed, target_passes, accuracy_target, instruction,
        warmup_ladder, goal_is_warmup, consecutive
      )
      values (
        v_plan_id, v_plan_song_id, v_song_id, v_snippet_id, v_item_pos, v_free,
        v_bpm, v_speed, v_passes, v_accuracy, nullif(btrim(v_item->>'instruction'), ''),
        v_ladder, v_goal_warmup, v_consecutive
      );
    end loop;
  end loop;

  if v_item_pos > 20 then
    raise exception 'sam_create_practice_plan: a plan may have at most 20 items (got %).', v_item_pos;
  end if;

  return v_plan_id;
end;
$$;


ALTER FUNCTION "public"."sam_create_practice_plan"("p_plan" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_create_practice_plan"("p_plan" "jsonb") IS 'SAM: the ONLY way to create a practice plan. Atomically supersedes the active plan and inserts
the plan, its songs and items, returning the new plan id. All-or-nothing validation: authenticated,
songs and snippets exist and are not archived, snippet belongs to its song, one item per range,
required targets, free play has no accuracy target, tempo rules (songs with audio: target_bpm =
default_bpm, target via speed; without audio: speed 100). Free play tempo defaults to the song''s
goal pair. At most 20 items. The new plan records supersedes_plan_id, so plan history is a chain and
not a set of unconnected rows.

WARM-UP LADDER (added 2026-09-27): an item may carry warmup_ladder, goal_is_warmup and consecutive.
The ladder''s SHAPE is checked by the table''s own constraint (sam_warmup_ladder_is_valid); this
function adds the two rules a constraint cannot express — goal_is_warmup is refused with
is_free_play, and refused when the item''s ladder RESOLVES to none (its own, then the snippet''s,
then the song''s, then sam_default_warmup_ladder()), since such an item could never be completed.
Omitting all three keeps the old behaviour exactly: null, false, false.

Input shape:
{ day_note, internal_notes, review_instructions,
  songs: [ { song_id, song_note, internal_notes,
             items: [ { snippet_id?, is_free_play?, target_bpm?, target_playback_speed?,
                        target_passes, accuracy_target?, instruction?,
                        warmup_ladder?, goal_is_warmup?, consecutive? } ] } ] }';



CREATE OR REPLACE FUNCTION "public"."sam_default_warmup_ladder"() RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO 'public'
    AS $$
  select '[{"target_percent": 70,  "accuracy_target": null, "target_passes": 2, "consecutive": true},
           {"target_percent": 85,  "accuracy_target": null, "target_passes": 2, "consecutive": true},
           {"target_percent": 100, "accuracy_target": null, "target_passes": 2, "consecutive": true}]'::jsonb;
$$;


ALTER FUNCTION "public"."sam_default_warmup_ladder"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_default_warmup_ladder"() IS 'SAM: the app default warm-up ladder (spec §3) — 70/85/100 percent of target tempo, two consecutive
passes each, accuracy inherited from the plan item. The last level of the resolution order, used
when no plan item, snippet or song supplies one. This is the single source of the constant: the
player should read it here rather than keeping its own copy.';



CREATE OR REPLACE FUNCTION "public"."sam_goals_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."sam_goals_touch_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_goals_touch_updated_at"() IS 'SAM: stamps sam_goals.updated_at.';



CREATE OR REPLACE FUNCTION "public"."sam_plan_item_progress"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") RETURNS TABLE("plan_item_id" "uuid", "day" "date", "attempts" integer, "qualifying" integer, "best_accuracy" integer, "best_effective_bpm" integer, "last_completed_at" timestamp with time zone, "longest_qualifying_streak" integer, "ladder_completions" integer)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $$
#variable_conflict use_column
begin
  if p_plan_id is null then
    raise exception 'sam_plan_item_progress: p_plan_id is required.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'sam_plan_item_progress: p_from and p_to are required, and p_to must not be before p_from.';
  end if;
  if p_to - p_from > 30 then
    raise exception 'sam_plan_item_progress: the date range is capped at 31 days.';
  end if;
  if not exists (select 1 from sam_practice_plans pl where pl.id = p_plan_id) then
    raise exception 'sam_plan_item_progress: plan % not found.', p_plan_id;
  end if;

  return query
  with itm as (
    select i.id                    as item_id,
           i.song_id               as item_song_id,
           i.snippet_id            as item_snippet_id,
           i.position              as item_position,
           i.is_free_play          as item_free,
           i.target_effective_bpm  as item_bpm,
           i.accuracy_target       as item_accuracy,
           public.sam_resolve_warmup_ladder(i.song_id, i.snippet_id, i.id) as ladder
      from sam_practice_plan_items i
     where i.plan_id = p_plan_id
  ),
  -- The top rung's own bar. The ladder's last rung is always the 100% rung
  -- (validator), and its target_passes is always present (§5.1 requires it on
  -- every rung), so only accuracy_target falls back to the item's.
  top_rung as (
    select t.item_id,
           coalesce((t.ladder -> -1 ->> 'accuracy_target')::smallint,
                    t.item_accuracy)                                      as top_accuracy,
           (t.ladder -> -1 ->> 'target_passes')::smallint                  as top_passes,
           coalesce((t.ladder -> -1 ->> 'consecutive')::boolean, false)    as top_consecutive
      from itm t
     where jsonb_array_length(t.ladder) > 0
  ),
  -- Every attempt on every item, with the three facts the aggregates below
  -- need. The join, the notes_played rule, the window and the qualifying
  -- expression are unchanged from migration 054.
  att as (
    select t.item_id,
           t.item_position,
           (pa.completed_at at time zone 'America/Los_Angeles')::date as pt_day,
           -- Sessions are the unit a streak lives in. A pass whose session_id is
           -- NULL cannot be attributed to a sitting — a row written before the
           -- column was filled, a session row since deleted (ON DELETE SET
           -- NULL), or a pass that completed inside the window where the app is
           -- still inserting the session row — so it becomes a group of its own
           -- and can never join, or bridge, a streak. That under-counts rather
           -- than inventing a streak that did not happen.
           coalesce(pa.session_id, pa.id)                             as session_key,
           pa.id                                                      as pass_id,
           pa.completed_at,
           pa.accuracy_percent,
           pa.effective_bpm,
           pa.warmup_rung,
           pa.warmup_target_percent,
           coalesce(pa.effective_bpm >= t.item_bpm
                    and (t.item_free or pa.accuracy_percent >= t.item_accuracy),
                    false)                                            as qualifies
      from itm t
      join sam_passes pa
        on pa.song_id = t.item_song_id
       and pa.snippet_id is not distinct from t.item_snippet_id
     where pa.notes_played > 0
       and pa.completed_at >= (p_from::timestamp at time zone 'America/Los_Angeles')
       and pa.completed_at <  ((p_to + 1)::timestamp at time zone 'America/Los_Angeles')
  ),
  -- One row per item per day with at least one attempt. Identical to 054.
  base as (
    select a.item_id,
           a.pt_day,
           count(*)::integer                              as n_attempts,
           count(*) filter (where a.qualifies)::integer    as n_qualifying,
           max(a.accuracy_percent)::integer                as best_acc,
           max(a.effective_bpm)::integer                   as best_bpm,
           max(a.completed_at)                             as last_at,
           min(a.item_position)                            as pos
      from att a
     group by a.item_id, a.pt_day
  ),
  -- The longest run of qualifying passes inside one session, on one day.
  -- Gaps-and-islands: within a session, two ordinal sequences drift apart
  -- exactly when the qualifying flag changes, so their difference labels each
  -- unbroken run.
  islands as (
    select a.item_id, a.pt_day, a.session_key, a.qualifies,
           row_number() over (partition by a.item_id, a.pt_day, a.session_key
                              order by a.completed_at, a.pass_id)
         - row_number() over (partition by a.item_id, a.pt_day, a.session_key, a.qualifies
                              order by a.completed_at, a.pass_id) as grp
      from att a
  ),
  streaks as (
    select s.item_id, s.pt_day, max(s.run_len)::integer as longest
      from (
        select item_id, pt_day, session_key, grp, count(*) as run_len
          from islands
         where qualifies
         group by item_id, pt_day, session_key, grp
      ) s
     group by s.item_id, s.pt_day
  ),
  -- LADDER RUNS. A run is one press of Warm up: it starts at the first warm-up
  -- pass of a session and again whenever the rung DROPS below the previous
  -- warm-up pass's rung, which only happens when he restarts the ladder. Passes
  -- that keep looping at the top rung after completion never decrease, so they
  -- stay in the run that earned them.
  runs as (
    select r.item_id, r.pt_day, r.session_key, r.completed_at, r.pass_id,
           r.warmup_target_percent,
           r.top_ok,
           sum(case when r.is_restart then 1 else 0 end) over (
             partition by r.item_id, r.pt_day, r.session_key
             order by r.completed_at, r.pass_id
           ) as run_no
      from (
        select a.item_id, a.pt_day, a.session_key, a.completed_at, a.pass_id,
               a.warmup_rung, a.warmup_target_percent,
               -- The top rung's bar, which can be STRICTER than the item's: the
               -- top rung is 100% of the target, so its tempo bar is the item's
               -- target_effective_bpm (floored at 20, per §4), but its accuracy
               -- bar is the rung's own when it has one.
               coalesce(a.effective_bpm >= greatest(20, t.item_bpm)
                        and (tr.top_accuracy is null
                             or a.accuracy_percent >= tr.top_accuracy),
                        false) as top_ok,
               (lag(a.warmup_rung) over w is null
                or a.warmup_rung < lag(a.warmup_rung) over w) as is_restart
          from att a
          join itm t      on t.item_id = a.item_id
          join top_rung tr on tr.item_id = a.item_id
         where a.warmup_rung is not null
        window w as (partition by a.item_id, a.pt_day, a.session_key
                     order by a.completed_at, a.pass_id)
      ) r
  ),
  -- Within a run, only the top-rung passes decide completion.
  top_islands as (
    select item_id, pt_day, session_key, run_no, top_ok, grp, count(*) as len
      from (
        select item_id, pt_day, session_key, run_no, top_ok,
               row_number() over (partition by item_id, pt_day, session_key, run_no
                                  order by completed_at, pass_id)
             - row_number() over (partition by item_id, pt_day, session_key, run_no, top_ok
                                  order by completed_at, pass_id) as grp
          from runs
         where warmup_target_percent = 100
      ) s
     group by item_id, pt_day, session_key, run_no, top_ok, grp
  ),
  run_totals as (
    select item_id, pt_day, session_key, run_no,
           coalesce(sum(len) filter (where top_ok), 0) as cumulative_top,
           coalesce(max(len) filter (where top_ok), 0) as longest_top
      from top_islands
     group by item_id, pt_day, session_key, run_no
  ),
  completions as (
    select rt.item_id, rt.pt_day, count(*)::integer as n
      from run_totals rt
      join top_rung tr on tr.item_id = rt.item_id
     where case when tr.top_consecutive then rt.longest_top else rt.cumulative_top end
           >= tr.top_passes
     group by rt.item_id, rt.pt_day
  )
  select b.item_id,
         b.pt_day,
         b.n_attempts,
         b.n_qualifying,
         b.best_acc,
         b.best_bpm,
         b.last_at,
         coalesce(st.longest, 0)::integer,
         coalesce(c.n, 0)::integer
    from base b
    left join streaks     st on st.item_id = b.item_id and st.pt_day = b.pt_day
    left join completions c  on c.item_id  = b.item_id and c.pt_day  = b.pt_day
   order by b.pt_day, b.pos;
end;
$$;


ALTER FUNCTION "public"."sam_plan_item_progress"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_plan_item_progress"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") IS 'SAM: THE single source of plan progress, used by both the app and Claude''s tools. Nothing else
counts passes. One row per plan item per Pacific day with at least one attempt.

UNCHANGED (first seven columns, same expressions as migration 054): a pass MATCHES an item when
song_id is equal and snippet_id is not distinct from the item''s (both null = whole song). ATTEMPT =
a matching pass with notes_played > 0. QUALIFYING = an attempt with effective_bpm >=
target_effective_bpm and, unless free play, accuracy_percent >= accuracy_target. Day =
completed_at in America/Los_Angeles. Matching ignores sam_passes.plan_item_id. Range capped at 31
days.

longest_qualifying_streak — the longest run of CONSECUTIVE qualifying passes within ONE SESSION on
that day. Consecutive means passes in a row with no non-qualifying pass between them; a stop or a
pause ends the session and therefore the streak. A pass with a null session_id is treated as a
session of one, so it can never join or bridge a streak. A streak that crosses Pacific midnight is
split at midnight, because an item is a per-day thing. Read this column for an item with
consecutive = true and the qualifying column for one with consecutive = false; this function
reports both and decides neither.

ladder_completions — how many times the resolved warm-up ladder was completed that day. A LADDER RUN
is one press of Warm up: it begins at the first warm-up pass of a session and again whenever
warmup_rung DROPS below the previous warm-up pass''s rung in that session. A run is COMPLETED when
its top-rung passes (warmup_target_percent = 100) meet the top rung''s target_passes — as a streak
if that rung is consecutive, cumulatively if not — where a top-rung pass counts if its effective_bpm
reached the item''s target_effective_bpm and its accuracy reached the top rung''s accuracy_target,
falling back to the item''s. The lower rungs are NOT re-derived: the app only marks a pass with rung
N after rungs 1..N-1 were satisfied on their own rules, so the recorded rung is the engine''s own
evidence. Zero when no level supplies a ladder ([]). The ladder is resolved at READ time by
sam_resolve_warmup_ladder, so editing a snippet''s or song''s ladder can change today''s count for an
item that inherits one; an item carrying its own ladder is immutable and cannot drift. Known limit:
with a single-rung ladder a restart is indistinguishable from continued looping, so two warm-ups in
one session count as one.';



CREATE OR REPLACE FUNCTION "public"."sam_plan_unplanned_practice"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") RETURNS TABLE("song_id" "uuid", "snippet_id" "uuid", "day" "date", "attempts" integer, "best_accuracy" integer, "best_effective_bpm" integer)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $$
#variable_conflict use_column
begin
  if p_plan_id is null then
    raise exception 'sam_plan_unplanned_practice: p_plan_id is required.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'sam_plan_unplanned_practice: p_from and p_to are required, and p_to must not be before p_from.';
  end if;
  if p_to - p_from > 30 then
    raise exception 'sam_plan_unplanned_practice: the date range is capped at 31 days.';
  end if;
  if not exists (select 1 from sam_practice_plans pl where pl.id = p_plan_id) then
    raise exception 'sam_plan_unplanned_practice: plan % not found.', p_plan_id;
  end if;

  return query
  select pa.song_id,
         pa.snippet_id,
         (pa.completed_at at time zone 'America/Los_Angeles')::date,
         count(*)::integer,
         max(pa.accuracy_percent)::integer,
         max(pa.effective_bpm)::integer
    from sam_passes pa
   where pa.notes_played > 0
     and pa.completed_at >= (p_from::timestamp at time zone 'America/Los_Angeles')
     and pa.completed_at <  ((p_to + 1)::timestamp at time zone 'America/Los_Angeles')
     and not exists (
       select 1
         from sam_practice_plan_items i
        where i.plan_id = p_plan_id
          and i.song_id = pa.song_id
          and i.snippet_id is not distinct from pa.snippet_id
     )
   group by 1, 2, 3
   order by 3, 1, 2;
end;
$$;


ALTER FUNCTION "public"."sam_plan_unplanned_practice"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_plan_unplanned_practice"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") IS 'SAM: attempts (notes_played > 0) per song, snippet and Pacific day that match NO item in the given
plan. Shows practice outside the plan, including snippets made on the fly. Range capped at 31 days.';



CREATE OR REPLACE FUNCTION "public"."sam_practice_plans_guard_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if (new.id, new.user_id, new.starts_on, new.supersedes_plan_id, new.day_note,
      new.internal_notes, new.review_instructions, new.created_at)
     is distinct from
     (old.id, old.user_id, old.starts_on, old.supersedes_plan_id, old.day_note,
      old.internal_notes, old.review_instructions, old.created_at) then
    raise exception 'sam_practice_plans: plan content is immutable. Create a new plan instead.';
  end if;

  if old.status = 'superseded' and new.status = 'active' then
    raise exception 'sam_practice_plans: a superseded plan cannot be reactivated. Create a new plan instead.';
  end if;

  if old.review_note is not null and new.review_note is distinct from old.review_note then
    raise exception 'sam_practice_plans: review_note is already set and cannot be changed.';
  end if;

  if old.review_note is null and new.review_note is not null and new.review_noted_at is null then
    new.review_noted_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."sam_practice_plans_guard_update"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_practice_plans_guard_update"() IS 'SAM: enforces plan immutability. Allows only status active->superseded, ended_at, a one-time
review_note, and review_noted_at. Stamps updated_at.';



CREATE OR REPLACE FUNCTION "public"."sam_practice_reject_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  raise exception '%: rows are immutable. Create a new plan instead.', tg_table_name;
end;
$$;


ALTER FUNCTION "public"."sam_practice_reject_update"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_practice_reject_update"() IS 'SAM: rejects all updates on immutable practice-plan child tables.';



CREATE OR REPLACE FUNCTION "public"."sam_resolve_warmup_ladder"("p_song_id" "uuid", "p_snippet_id" "uuid" DEFAULT NULL::"uuid", "p_plan_item_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  -- First level that is not NULL wins. coalesce is the whole rule: NULL means
  -- "fall through", and [] is not NULL, so an empty array stops the chain and
  -- means "no warm-up here".
  select coalesce(
    (select i.warmup_ladder from sam_practice_plan_items i where i.id = p_plan_item_id),
    (select s.warmup_ladder from sam_snippets s        where s.id = p_snippet_id),
    (select g.warmup_ladder from sam_songs g           where g.id = p_song_id),
    public.sam_default_warmup_ladder()
  );
$$;


ALTER FUNCTION "public"."sam_resolve_warmup_ladder"("p_song_id" "uuid", "p_snippet_id" "uuid", "p_plan_item_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_resolve_warmup_ladder"("p_song_id" "uuid", "p_snippet_id" "uuid", "p_plan_item_id" "uuid") IS 'SAM: THE resolution order for a warm-up ladder (spec §4) — plan item, then snippet, then song, then
sam_default_warmup_ladder(). NULL at a level means fall through; [] at a level means "no warm-up
here" and stops the chain, so this returns [] rather than the default. Pass p_snippet_id NULL for a
whole song and p_plan_item_id NULL when the loaded range matches no plan item. security invoker, so
it sees only the caller''s rows.';



CREATE OR REPLACE FUNCTION "public"."sam_song_scores_freshness"("p_song_id" "uuid", "p_scores_version" integer) RETURNS TABLE("fresh" boolean, "measures_edited_at" timestamp with time zone, "stored_rows" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    coalesce(
      bool_and(
        sc.scores_version = p_scores_version
        and sc.computed_from_edited_at is not distinct from s.measures_edited_at
      ),
      false
    )                             as fresh,
    s.measures_edited_at          as measures_edited_at,
    count(sc.song_id)::integer    as stored_rows
  from public.sam_songs s
  left join public.sam_song_scores sc on sc.song_id = s.id
  where s.id = p_song_id
  group by s.id, s.measures_edited_at
$$;


ALTER FUNCTION "public"."sam_song_scores_freshness"("p_song_id" "uuid", "p_scores_version" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_song_scores_freshness"("p_song_id" "uuid", "p_scores_version" integer) IS 'SAM analyzer (M4). Is this song''s stored difficulty data current? Equality check: every row must carry p_scores_version and a computed_from_edited_at that IS NOT DISTINCT FROM the song''s measures_edited_at. Reads sam_songs and sam_song_scores only — never sam_song_measures — so a fresh song costs one cheap call. Returns no row for a song the caller cannot see.';



CREATE OR REPLACE FUNCTION "public"."sam_songs_fill_goal_tempo"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.goal_bpm is null then
    new.goal_bpm := coalesce(new.default_bpm, 68);
  end if;

  if new.goal_set_at is null
     and new.song_type = 'simplified'
     and new.parent_song_id is not null then
    select p.goal_set_at
      into new.goal_set_at
      from public.sam_songs p
     where p.id = new.parent_song_id
       and p.goal_bpm = new.goal_bpm
       and p.goal_playback_speed = new.goal_playback_speed;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."sam_songs_fill_goal_tempo"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_songs_fill_goal_tempo"() IS 'SAM: guarantees every song has a goal tempo. When an insert omits goal_bpm, copy default_bpm
(or 68). A simplified song whose goal pair matches its parent inherits the parent''s goal_set_at.
App and tool code should pass goal_bpm only when the source actually specifies one.';



CREATE OR REPLACE FUNCTION "public"."sam_songs_mark_goal_set"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  -- An explicit write to goal_set_at wins.
  if new.goal_set_at is distinct from old.goal_set_at then
    return new;
  end if;

  if new.goal_playback_speed is distinct from old.goal_playback_speed
     or (new.goal_bpm is distinct from old.goal_bpm and new.audio_file_path is null) then
    new.goal_set_at := now();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."sam_songs_mark_goal_set"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_songs_mark_goal_set"() IS 'SAM: stamps sam_songs.goal_set_at when a goal tempo is deliberately changed. See the column
comment for the rule.';



CREATE OR REPLACE FUNCTION "public"."sam_warmup_ladder_is_valid"("p_ladder" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."sam_warmup_ladder_is_valid"("p_ladder" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sam_warmup_ladder_is_valid"("p_ladder" "jsonb") IS 'SAM: the ONE definition of a valid warm-up ladder (spec §5.1), used by the CHECK constraint on
sam_snippets, sam_songs and sam_practice_plan_items. True for NULL (inherit) and for [] (no warm-up
here). Otherwise: 2-6 rungs — one rung is not a ladder, since its only rung would have to be 100%
and a restart cannot be told from continued looping without a rung that drops; every rung an object
with exactly the keys target_percent, accuracy_target, target_passes, consecutive; percents whole,
10-100, STRICTLY ascending, last rung exactly 100; accuracy_target null or 1-100; target_passes >= 1;
consecutive a boolean. NOTE: Postgres does not re-check existing rows when this body changes — drop
and re-add the three constraints if the rules ever change, as
supabase/migrations/080_sam_warmup_ladder_min_two_rungs.sql does.';



CREATE OR REPLACE FUNCTION "public"."stamp_song_edited"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE sam_songs
  SET measures_edited_at = now()
  WHERE id = COALESCE(NEW.song_id, OLD.song_id);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."stamp_song_edited"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stamp_songs_from_measure_statement"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    update public.sam_songs s
       set measures_edited_at = now()
     where s.id in (select distinct n.song_id from new_rows n);
  elsif tg_op = 'DELETE' then
    update public.sam_songs s
       set measures_edited_at = now()
     where s.id in (select distinct o.song_id from old_rows o);
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."stamp_songs_from_measure_statement"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."stamp_songs_from_measure_statement"() IS 'SAM analyzer (M6). Statement-level trigger function on sam_song_measures INSERT and DELETE: sets measures_edited_at = now() once for each song the statement touched, in the same transaction as the write, so no writer can change measures without invalidating stored scores. UPDATE is covered separately by the per-row bump_parent_edited_at trigger.';



CREATE OR REPLACE FUNCTION "public"."status_activate_on_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  ids jsonb := case when jsonb_typeof(new.item_ids) = 'array' then new.item_ids else '[]'::jsonb end;
begin
  update public.intents
     set status = 'active'
   where id = new.intent_id
     and status in ('someday', 'background');

  update public.items
     set status = 'active'
   where status = 'someday'
     and id in (
       select i.item_id from public.intents i
        where i.id = new.intent_id and i.item_id is not null
       union
       select jsonb_array_elements_text(ids)
     );
  return null;
exception when others then
  raise warning 'status_activate_on_event % failed: %', new.id, sqlerrm;
  return null;
end;
$$;


ALTER FUNCTION "public"."status_activate_on_event"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."status_activate_on_event"() IS 'Restructure P1. AFTER INSERT on events (unarchived): scheduling is committing, so the intention moves to active from someday or background, and its item and every id in item_ids move to active from someday ONLY (a recurrence successor copies item_ids, so a background item would be unparked on every recurrence). Never from closed. A safety net behind the browser write; never blocks it.';



CREATE OR REPLACE FUNCTION "public"."status_activate_on_execution"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  ids jsonb := case when jsonb_typeof(new.item_ids) = 'array' then new.item_ids else '[]'::jsonb end;
begin
  update public.intents
     set status = 'active'
   where id = new.intent_id
     and status = 'someday';

  update public.items
     set status = 'active'
   where status = 'someday'
     and id in (
       select i.item_id from public.intents i
        where i.id = new.intent_id and i.item_id is not null
       union
       select jsonb_array_elements_text(ids)
     );
  return null;
exception when others then
  raise warning 'status_activate_on_execution % failed: %', new.id, sqlerrm;
  return null;
end;
$$;


ALTER FUNCTION "public"."status_activate_on_execution"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."status_activate_on_execution"() IS 'Restructure P1. AFTER INSERT on executions: the intention, its item and every id in item_ids move to active from someday ONLY. Background stays background (doing an event a parked intention kept is not unparking it); closed is never touched. A safety net behind the browser write; never blocks it.';



CREATE OR REPLACE FUNCTION "public"."status_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  else
    new.status_written_at := old.status_written_at;
    new.status_changed_at := old.status_changed_at;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."status_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."status_guard"() IS 'Restructure P1, P4. BEFORE UPDATE on any table with status, status_changed_at and status_written_at (intents, items). Keeps the old status when an update would move it back to someday, except closed -> someday within 10 minutes of the close by status_written_at (Undo). On a status change, stamps status_written_at now(), keeps an app-supplied status_changed_at that is no later than now() and otherwise stamps now(); an update that does not change status keeps both stored values.';



CREATE OR REPLACE FUNCTION "public"."update_modified_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_modified_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_apply_fix"("p_transaction_id" "uuid", "p_set_kind" "text" DEFAULT NULL::"text", "p_add_tag_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_pattern" "text" DEFAULT NULL::"text", "p_merchant_name" "text" DEFAULT NULL::"text", "p_update_rule_id" "uuid" DEFAULT NULL::"uuid", "p_add_new_rule" boolean DEFAULT false, "p_notes" "text" DEFAULT NULL::"text", "p_created_by" "text" DEFAULT 'manual'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_plan     jsonb;
  t          record;
  v_owner    uuid;
  v_mid      uuid;
  v_created  boolean := false;
  v_rule     record;
  v_rule_id  uuid;
  v_tags     uuid[];
  v_before   uuid[] := '{}';
  v_ids      uuid[];
  v_counts   jsonb;
begin
  if p_created_by not in ('claude', 'manual') then
    raise exception 'wb_apply_fix: created_by must be claude or manual' using errcode = '22023';
  end if;
  if p_set_kind is null and coalesce(cardinality(p_add_tag_ids), 0) = 0 then
    raise exception 'wb_apply_fix: say what the rule does: a kind and/or tags' using errcode = '22023';
  end if;
  if p_set_kind is not null and p_set_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
    raise exception 'wb_apply_fix: unknown kind %', p_set_kind using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_add_tag_ids, '{}')) x(id)
             where not exists (select 1 from public.wb_tags g where g.id = x.id)) then
    raise exception 'wb_apply_fix: a tag id does not exist' using errcode = '23503';
  end if;

  v_plan := public.wb_fix_plan(p_transaction_id, p_pattern, p_merchant_name);
  select user_id, context_id into t from public.wb_transactions where id = p_transaction_id;
  v_owner := coalesce(auth.uid(), t.user_id);

  if jsonb_array_length(v_plan -> 'existing_rules') > 0 and p_update_rule_id is null and not coalesce(p_add_new_rule, false) then
    raise exception 'wb_apply_fix: a rule already exists for %; update it or add another', v_plan #>> '{merchant,name}'
      using errcode = '23505';
  end if;

  -- 1. The merchant: create it, or add the pattern.
  v_mid := (v_plan #>> '{merchant,id}')::uuid;
  if v_mid is null then
    insert into public.wb_merchants (user_id, context_id, name, match_patterns)
    values (v_owner, t.context_id, v_plan #>> '{merchant,name}', array[v_plan #>> '{merchant,add_pattern}'])
    returning id into v_mid;
    v_created := true;
  elsif v_plan #>> '{merchant,add_pattern}' is not null then
    update public.wb_merchants
    set match_patterns = array(select distinct p from unnest(match_patterns || (v_plan #>> '{merchant,add_pattern}')) p order by p)
    where id = v_mid;
  end if;

  -- 2. The rule, matching on the merchant.
  if p_update_rule_id is not null then
    select * into v_rule from public.wb_rules where id = p_update_rule_id for update;
    if not found then
      raise exception 'wb_apply_fix: no rule % that you can see', p_update_rule_id using errcode = '23503';
    end if;
    v_before := array(select x.id from public.wb_transactions x where p_update_rule_id = any (x.matched_rule_ids));
    -- Keep the rule's tags, except one from an exclusive group a new tag takes over.
    v_tags := array(
      select distinct u from (
        select old.id as u
        from unnest(v_rule.add_tag_ids) old_id
        join public.wb_tags old on old.id = old_id
        join public.wb_tag_groups og on og.id = old.group_id
        where not (og.exclusive and exists (
          select 1 from unnest(coalesce(p_add_tag_ids, '{}')) n_id
          join public.wb_tags n on n.id = n_id
          where n.group_id = old.group_id))
        union
        select n_id from unnest(coalesce(p_add_tag_ids, '{}')) n_id
      ) z);
    update public.wb_rules
    set match = jsonb_build_object('merchant_id', v_mid),
        set_kind = coalesce(p_set_kind, set_kind),
        add_tag_ids = v_tags,
        notes = coalesce(p_notes, notes)
    where id = p_update_rule_id;
    v_rule_id := p_update_rule_id;
  else
    insert into public.wb_rules (user_id, context_id, name, priority, match, set_kind, add_tag_ids,
                                 created_by, created_from_transaction_id, notes)
    values (v_owner, t.context_id, v_plan #>> '{merchant,name}', 100, jsonb_build_object('merchant_id', v_mid),
            p_set_kind, coalesce(p_add_tag_ids, '{}'), p_created_by, p_transaction_id, p_notes)
    returning id into v_rule_id;
  end if;

  -- 3. Reprocess everything the merchant and the rule now touch.
  v_ids := array(
    select distinct x from unnest(
      array[p_transaction_id]
      || array(select (jsonb_array_elements_text(coalesce(v_plan -> 'ids', '[]'::jsonb)))::uuid)
      || v_before
      || array(select w.id from public.wb_transactions w where w.merchant_id = v_mid)) x);
  v_counts := public.wb_process_transactions(v_ids);

  return jsonb_build_object(
    'merchant_id', v_mid, 'merchant_created', v_created,
    'rule_id', v_rule_id, 'rule_updated', p_update_rule_id is not null,
    'matched_now', (public.wb_rule_preview(jsonb_build_object('merchant_id', v_mid), null, 0) ->> 'count')::int,
    'reprocessed', v_counts);
end;
$$;


ALTER FUNCTION "public"."wb_apply_fix"("p_transaction_id" "uuid", "p_set_kind" "text", "p_add_tag_ids" "uuid"[], "p_pattern" "text", "p_merchant_name" "text", "p_update_rule_id" "uuid", "p_add_new_rule" boolean, "p_notes" "text", "p_created_by" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_apply_fix"("p_transaction_id" "uuid", "p_set_kind" "text", "p_add_tag_ids" "uuid"[], "p_pattern" "text", "p_merchant_name" "text", "p_update_rule_id" "uuid", "p_add_new_rule" boolean, "p_notes" "text", "p_created_by" "text") IS 'Warren Buffet: "Always do this" (spec §6.1). Creates the merchant or adds the pattern, then creates a merchant rule (created_from_transaction_id set) or updates p_update_rule_id (tags merged; a new exclusive-group tag replaces the old one), then reprocesses what they touch. Refuses a second rule for a merchant unless p_add_new_rule.';



CREATE OR REPLACE FUNCTION "public"."wb_apply_tags"("p_transaction_ids" "uuid"[], "p_tag_ids" "uuid"[], "p_source" "text" DEFAULT 'claude'::"text", "p_remove_tag_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_tid        uuid;
  v_split      uuid;
  v_n          int;
  tg           record;
  v_rm         uuid;
  v_had        boolean;
  v_old_id     uuid;
  v_old_tag    uuid;
  v_old_source text;
  v_old_rule   uuid;
  n_added      int := 0;
  n_replaced   int := 0;
  n_removed    int := 0;
  n_excluded   int := 0;
  n_restored   int := 0;
  v_multi      uuid[] := '{}';
  v_missing    uuid[] := '{}';
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_apply_tags: source must be claude or manual' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_tag_ids, '{}') || coalesce(p_remove_tag_ids, '{}')) t(id)
             where not exists (select 1 from public.wb_tags x where x.id = t.id)) then
    raise exception 'wb_apply_tags: a tag id does not exist' using errcode = '23503';
  end if;
  if exists (
    select 1 from public.wb_tags x join public.wb_tag_groups g on g.id = x.group_id and g.exclusive
    where x.id = any (coalesce(p_tag_ids, '{}')) group by g.id having count(*) > 1
  ) then
    raise exception 'wb_apply_tags: two tags from one exclusive group' using errcode = '23505';
  end if;

  foreach v_tid in array coalesce(p_transaction_ids, '{}')
  loop
    select count(*)::int, (array_agg(s.id))[1] into v_n, v_split
    from public.wb_splits s where s.transaction_id = v_tid;
    if v_n = 0 then
      v_missing := v_missing || v_tid;
      continue;
    elsif v_n > 1 then
      v_multi := v_multi || v_tid;
      continue;
    end if;

    -- Removals: delete the tag and remember it, so no rule puts it back.
    foreach v_rm in array coalesce(p_remove_tag_ids, '{}')
    loop
      v_old_source := null; v_old_rule := null;
      delete from public.wb_split_tags
      where split_id = v_split and tag_id = v_rm
      returning source, coalesce(rule_id, replaced_rule_id) into v_old_source, v_old_rule;
      if found then
        n_removed := n_removed + 1;
      end if;
      insert into public.wb_tag_exclusions (transaction_id, tag_id, rule_id, source)
      values (v_tid, v_rm, v_old_rule, p_source)
      on conflict (transaction_id, tag_id) do update
        set rule_id = coalesce(excluded.rule_id, public.wb_tag_exclusions.rule_id),
            source = excluded.source, removed_by = auth.uid(), created_at = now();
      n_excluded := n_excluded + 1;
    end loop;

    for tg in
      select x.id, x.group_id, g.exclusive
      from public.wb_tags x join public.wb_tag_groups g on g.id = x.group_id
      where x.id = any (coalesce(p_tag_ids, '{}'))
    loop
      -- Added back by hand: the removal no longer applies.
      delete from public.wb_tag_exclusions where transaction_id = v_tid and tag_id = tg.id;
      if found then
        n_restored := n_restored + 1;
      end if;

      v_old_id := null; v_old_tag := null; v_old_source := null; v_old_rule := null;
      select st.id, st.tag_id, st.source, st.rule_id into v_old_id, v_old_tag, v_old_source, v_old_rule
      from public.wb_split_tags st
      where st.split_id = v_split
        and (st.tag_id = tg.id or (tg.exclusive and st.group_id = tg.group_id))
      order by (st.tag_id = tg.id) desc
      limit 1;
      v_had := found;

      if v_had and v_old_tag = tg.id then
        -- Already there: a hand tag takes it over, so a rule never removes it.
        update public.wb_split_tags
        set source = p_source, rule_id = null,
            replaced_rule_id = coalesce(replaced_rule_id, case when v_old_source = 'rule' then v_old_rule end)
        where id = v_old_id and source <> p_source;
      else
        if v_had then
          delete from public.wb_split_tags where id = v_old_id;
          n_replaced := n_replaced + 1;
        end if;
        insert into public.wb_split_tags (split_id, tag_id, source, replaced_rule_id)
        values (v_split, tg.id, p_source, case when v_old_source = 'rule' then v_old_rule end);
        n_added := n_added + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('added', n_added, 'replaced', n_replaced, 'removed', n_removed,
                            'excluded', n_excluded, 'restored', n_restored,
                            'skipped_multi_split', to_jsonb(v_multi), 'not_found', to_jsonb(v_missing));
end;
$$;


ALTER FUNCTION "public"."wb_apply_tags"("p_transaction_ids" "uuid"[], "p_tag_ids" "uuid"[], "p_source" "text", "p_remove_tag_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_apply_tags"("p_transaction_ids" "uuid"[], "p_tag_ids" "uuid"[], "p_source" "text", "p_remove_tag_ids" "uuid"[]) IS 'Warren Buffet: add tags (source claude or manual) to, and remove tags from, the single split of each transaction. An exclusive group''s new tag replaces the old one; a replaced or taken-over rule tag is recorded in replaced_rule_id. A removal is recorded in wb_tag_exclusions so no rule puts the tag back; adding the tag back by hand clears it. Multi-split transactions are skipped: use wb_replace_splits.';



CREATE OR REPLACE FUNCTION "public"."wb_bulk_create"("p_payload" "jsonb", "p_context_id" "text", "p_dry_run" boolean DEFAULT true, "p_created_by" "text" DEFAULT 'claude'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_user     uuid;
  v_results  jsonb := '[]'::jsonb;
  v_errors   int := 0;
  v_item     jsonb;
  v_name     text;
  v_group    record;
  v_parent   uuid;
  v_id       uuid;
  v_patterns text[];
  v_added    text[];
  v_existing text[];
  v_kind     text;
  v_tag_ids  uuid[];
  v_ref      text;
  v_tag      uuid;
  v_err      text;
  v_status   text;
  v_applied  boolean;
begin
  if p_created_by is null or p_created_by not in ('claude', 'manual') then
    raise exception 'wb_bulk_create: created_by must be claude or manual' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'wb_bulk_create: payload must be an object with tags, merchants and rules' using errcode = '22023';
  end if;
  if greatest(jsonb_array_length(coalesce(p_payload -> 'tags', '[]')),
              jsonb_array_length(coalesce(p_payload -> 'merchants', '[]')),
              jsonb_array_length(coalesce(p_payload -> 'rules', '[]'))) > 50 then
    raise exception 'wb_bulk_create: at most 50 tags, 50 merchants and 50 rules per call' using errcode = '22023';
  end if;
  select coalesce(auth.uid(), c.user_id) into v_user from public.contexts c where c.id = p_context_id;
  if v_user is null then
    raise exception 'wb_bulk_create: no context % that you can see', p_context_id using errcode = '23503';
  end if;

  -- Everything runs inside one sub-block; a dry run, or any item error, rolls it all back.
  begin
    -- 1. Tags, in order, so a parent may be an earlier item.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'tags', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error';
      begin
        select g.id, g.name into v_group from public.wb_tag_groups g
        where g.context_id = p_context_id and lower(g.name) = lower(btrim(v_item ->> 'group'));
        if v_group.id is null then
          v_err := format('no tag group "%s"', v_item ->> 'group');
        elsif coalesce(v_name, '') = '' then
          v_err := 'a tag needs a name';
        else
          select t.id into v_id from public.wb_tags t where t.group_id = v_group.id and lower(t.name) = lower(v_name);
          if v_id is not null then
            v_status := 'exists';
          else
            v_parent := null;
            if nullif(btrim(v_item ->> 'parent'), '') is not null then
              select t.id into v_parent from public.wb_tags t
              where t.group_id = v_group.id and lower(t.name) = lower(btrim(v_item ->> 'parent'));
              if v_parent is null then
                v_err := format('no parent tag "%s" in %s', v_item ->> 'parent', v_group.name);
              end if;
            end if;
            if v_err is null then
              insert into public.wb_tags (user_id, context_id, group_id, parent_id, name, notes)
              values (v_user, p_context_id, v_group.id, v_parent, v_name, nullif(btrim(v_item ->> 'notes'), ''))
              returning id into v_id;
              v_status := 'created';
            end if;
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; end if;
      v_results := v_results || jsonb_build_object('kind', 'tag', 'name', concat_ws('/', v_group.name, v_name),
        'status', v_status, 'id', v_id, 'error', v_err);
      v_group := null;
    end loop;

    -- 2. Merchants: an existing one (by name) gets any new patterns added.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'merchants', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error';
      begin
        select coalesce(array_agg(distinct lower(btrim(p))), '{}') into v_patterns
        from jsonb_array_elements_text(coalesce(v_item -> 'match_patterns', '[]')) p
        where btrim(p) <> '';
        v_kind := nullif(btrim(v_item ->> 'default_kind'), '');
        if coalesce(v_name, '') = '' then
          v_err := 'a merchant needs a name';
        elsif exists (select 1 from unnest(v_patterns) p where length(p) < 3) then
          v_err := 'a match pattern needs at least 3 characters';
        elsif v_kind is not null and v_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
          v_err := format('unknown kind "%s"', v_kind);
        else
          select m.id, m.match_patterns into v_id, v_existing from public.wb_merchants m
          where m.context_id = p_context_id and lower(m.name) = lower(v_name);
          if v_id is not null then
            select coalesce(array_agg(p), '{}') into v_added
            from unnest(v_patterns) p
            where p <> all (v_existing);
            if cardinality(v_added) > 0 then
              update public.wb_merchants set match_patterns = match_patterns || v_added where id = v_id;
              v_status := 'updated';
            else
              v_status := 'exists';
            end if;
          elsif cardinality(v_patterns) = 0 then
            v_err := 'a new merchant needs match_patterns';
          else
            insert into public.wb_merchants (user_id, context_id, name, match_patterns, default_kind, notes)
            values (v_user, p_context_id, v_name, v_patterns, v_kind, nullif(btrim(v_item ->> 'notes'), ''))
            returning id into v_id;
            v_status := 'created';
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; end if;
      v_results := v_results || jsonb_build_object('kind', 'merchant', 'name', v_name,
        'status', v_status, 'id', v_id, 'error', v_err);
    end loop;

    -- 3. Rules, on a merchant (by name); an active rule for that merchant is reused, never duplicated.
    for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'rules', '[]'))
    loop
      v_name := btrim(v_item ->> 'name');
      v_err := null; v_id := null; v_status := 'error'; v_tag_ids := '{}';
      begin
        v_kind := nullif(btrim(v_item ->> 'set_kind'), '');
        select m.id into v_id from public.wb_merchants m
        where m.context_id = p_context_id and lower(m.name) = lower(btrim(v_item ->> 'merchant'));
        if coalesce(v_name, '') = '' then
          v_err := 'a rule needs a name';
        elsif v_id is null then
          v_err := format('no merchant "%s"', v_item ->> 'merchant');
        elsif v_kind is not null and v_kind not in ('spend', 'income', 'transfer', 'refund', 'investment', 'interest', 'fee') then
          v_err := format('unknown kind "%s"', v_kind);
        else
          for v_ref in select * from jsonb_array_elements_text(coalesce(v_item -> 'tags', '[]'))
          loop
            select t.id into v_tag from public.wb_tags t
            join public.wb_tag_groups g on g.id = t.group_id
            where g.context_id = p_context_id
              and lower(g.name) = lower(btrim(split_part(v_ref, '/', 1)))
              and lower(t.name) = lower(btrim(substr(v_ref, length(split_part(v_ref, '/', 1)) + 2)));
            if v_tag is null then
              v_err := format('no tag "%s" (write Group/Tag)', v_ref);
              exit;
            end if;
            v_tag_ids := v_tag_ids || v_tag;
          end loop;
          if v_err is null and v_kind is null and cardinality(v_tag_ids) = 0 then
            v_err := 'say what the rule does: set_kind and/or tags';
          end if;
          if v_err is null then
            select r.id into v_tag from public.wb_rules r
            where r.active and r.match ->> 'merchant_id' = v_id::text
            order by r.priority, r.created_at limit 1;
            if v_tag is not null then
              v_id := v_tag;
              v_status := 'exists';
            else
              insert into public.wb_rules (user_id, context_id, name, priority, match, set_kind, add_tag_ids, created_by, notes)
              values (v_user, p_context_id, v_name, coalesce((v_item ->> 'priority')::int, 100),
                      jsonb_build_object('merchant_id', v_id), v_kind, v_tag_ids, p_created_by,
                      nullif(btrim(v_item ->> 'notes'), ''))
              returning id into v_id;
              v_status := 'created';
            end if;
          end if;
        end if;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_err is not null then v_errors := v_errors + 1; v_status := 'error'; v_id := null; end if;
      v_results := v_results || jsonb_build_object('kind', 'rule', 'name', v_name, 'merchant', v_item ->> 'merchant',
        'status', v_status, 'id', v_id, 'error', v_err);
    end loop;

    if p_dry_run or v_errors > 0 then
      raise exception 'wb_bulk_create: roll back' using errcode = 'WB001';
    end if;
  exception when sqlstate 'WB001' then
    null; -- rolled back; the results stay
  end;

  -- Nothing written: a "created" item has no real id, so it reports none.
  v_applied := not p_dry_run and v_errors = 0;
  if not v_applied then
    select coalesce(jsonb_agg(case when r ->> 'status' = 'created' then r || '{"id": null}'::jsonb else r end
                              order by ord), '[]'::jsonb)
    into v_results
    from jsonb_array_elements(v_results) with ordinality as e(r, ord);
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'dry_run', p_dry_run,
    'counts', (select jsonb_object_agg(k, n) from (
                 select r ->> 'status' as k, count(*) as n from jsonb_array_elements(v_results) r group by 1) s),
    'results', v_results);
end;
$$;


ALTER FUNCTION "public"."wb_bulk_create"("p_payload" "jsonb", "p_context_id" "text", "p_dry_run" boolean, "p_created_by" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_bulk_create"("p_payload" "jsonb", "p_context_id" "text", "p_dry_run" boolean, "p_created_by" "text") IS 'Warren Buffet: create tags, merchants and merchant rules in one transaction, referring to each other by name (tag parent, rule merchant, rule tags as Group/Tag). Existing names are reused, an existing merchant gets new patterns added, and a merchant that already has an active rule keeps it (no duplicate). A dry run (the default) writes nothing; any item error writes nothing; then a would-be-created item reports a null id. At most 50 of each. Security invoker. Returns applied, counts and per-item results.';



CREATE OR REPLACE FUNCTION "public"."wb_burn_rate_on"("p_today" "date" DEFAULT NULL::"date") RETURNS TABLE("month" "date", "included" numeric, "project_excluded" numeric, "matched_excluded" numeric, "subscription_excluded" numeric, "burn_median" numeric, "burn_mean" numeric)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  -- If you change 3, update help entries overview.burn_rate and overview.true_cost in
  -- src/money/helpText.js, BURN_MONTHS in src/money/ruleNumbers.js, and the test.
  v_months constant int := 3;
  v_today  date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_first  date;
begin
  v_first := (date_trunc('month', v_today) - make_interval(months => v_months))::date;
  return query
  with months as (
    select (v_first + make_interval(months => g))::date as m from generate_series(0, v_months - 1) g
  ),
  parts as (
    select date_trunc('month', (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles'))::date as m,
           s.amount,
           s.project_id is not null as on_project,
           x.subscription_id is not null as on_subscription,
           coalesce((select sum(pm.amount_applied) from public.wb_planned_matches pm
                     where pm.split_id = s.id and pm.status = 'confirmed'), 0) as matched
    from public.wb_transactions x
    join public.wb_splits s on s.transaction_id = x.id
    where not x.pending
      and x.kind in ('spend', 'refund', 'fee')
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date >= v_first
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date < date_trunc('month', v_today)::date
  ),
  per_month as (
    select mo.m,
           coalesce(sum(case when not p.on_project and not p.on_subscription then p.amount - p.matched end), 0) as inc,
           coalesce(sum(case when p.on_project then p.amount end), 0) as proj,
           coalesce(sum(case when not p.on_project and not p.on_subscription then p.matched end), 0) as mat,
           coalesce(sum(case when not p.on_project and p.on_subscription then p.amount end), 0) as subx
    from months mo
    left join parts p on p.m = mo.m
    group by mo.m
  )
  select pm.m, round(pm.inc, 2), round(pm.proj, 2), round(pm.mat, 2), round(pm.subx, 2),
         round((select percentile_cont(0.5) within group (order by q.inc) from per_month q)::numeric, 2),
         round((select avg(q.inc) from per_month q), 2)
  from per_month pm
  order by pm.m;
end;
$$;


ALTER FUNCTION "public"."wb_burn_rate_on"("p_today" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_burn_rate_on"("p_today" "date") IS 'Warren Buffet: everyday spending for the 3 full Pacific months before p_today''s month: posted spend, refund and fee splits (signed; refunds reduce it), leaving out project-linked splits, splits on subscription-linked charges, and the confirmed amount_applied of planned matches (the rest of a mixed payment still counts). One row per month with what was left out, plus the median (the burn rate) and the mean on every row. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_cash_projection"("p_include_drafts" boolean DEFAULT false, "p_today" "date" DEFAULT NULL::"date") RETURNS TABLE("day" "date", "opening" numeric, "planned_in" numeric, "planned_out" numeric, "subscriptions" numeric, "burn" numeric, "closing" numeric)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_end   date;
  v_start numeric;
  v_burn  numeric;
begin
  v_end := (v_today + make_interval(months =>
             coalesce((select horizon_months from public.wb_settings order by created_at limit 1), 12)))::date - 1;

  -- Spending cash minus what is owed on cards and emergency credit; unused credit never counts (A4).
  select coalesce(sum(case when a.role = 'spending_cash' then b.balance
                           else least(b.balance, 0) end), 0)
  into v_start
  from public.wb_accounts a
  cross join lateral (select bs.balance from public.wb_balance_snapshots bs
                      where bs.account_id = a.id and bs.as_of <= v_today
                      order by bs.as_of desc limit 1) b
  where a.role in ('spending_cash', 'credit_card', 'emergency_credit');

  -- Everyday spending at the burn rate, spread evenly per day.
  select coalesce(max(br.burn_median), 0) * 12 / 365 into v_burn from public.wb_burn_rate_on(v_today) br;

  return query
  with days as (select generate_series(v_today, v_end, interval '1 day')::date as d),
  planned as (
    -- Due dates in the horizon, less what is already confirmed against each (A5), 0 within tolerance (A45).
    select o.occurrence_on as d,
           public.wb_planned_left(o.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
               and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end),
             pi.amount_tolerance) as amt
    from public.wb_planned_occurrences(v_today, v_end, p_include_drafts) o
    join public.wb_planned_items pi on pi.id = o.planned_item_id
    where o.recurring or o.stage <> 'paid'
    union all
    -- An overdue one-off with something still unpaid counts on day 1 (A7). Missed dates of
    -- recurring items do not (A25); the weekly cleanup lists them as unmatched.
    select v_today,
           public.wb_planned_left(pi.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = pi.id and pm.status = 'confirmed'), pi.amount_tolerance)
    from public.wb_planned_items pi
    where pi.interval_count is null
      and pi.due_on < v_today
      and pi.stage not in ('paid', 'cancelled')
      and (p_include_drafts or pi.stage <> 'draft')
  ),
  subs as (
    select so.occurrence_on as d, so.amount from public.wb_subscription_occurrences(v_today, v_end, v_today) so
  ),
  per_day as (
    select dd.d,
           coalesce((select sum(p.amt) from planned p where p.d = dd.d and p.amt > 0), 0) as p_in,
           coalesce((select sum(p.amt) from planned p where p.d = dd.d and p.amt < 0), 0) as p_out,
           coalesce((select sum(s.amount) from subs s where s.d = dd.d), 0) as sub,
           v_burn as brn
    from days dd
  ),
  run as (
    select pd.*, v_start + sum(pd.p_in + pd.p_out + pd.sub + pd.brn) over (order by pd.d) as close_bal
    from per_day pd
  )
  select r.d, round(r.close_bal - (r.p_in + r.p_out + r.sub + r.brn), 2), round(r.p_in, 2), round(r.p_out, 2),
         round(r.sub, 2), round(r.brn, 2), round(r.close_bal, 2)
  from run r
  order by r.d;
end;
$$;


ALTER FUNCTION "public"."wb_cash_projection"("p_include_drafts" boolean, "p_today" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_cash_projection"("p_include_drafts" boolean, "p_today" "date") IS 'Warren Buffet: spending cash day by day from p_today across the horizon (wb_settings.horizon_months, else 12). Starts from spending_cash balances minus what is owed on credit_card and emergency_credit accounts (unused credit never counts; balances as of p_today). Each day adds planned income and bills on their due dates less what is confirmed against them (nothing when what is left is within the item''s amount_tolerance, A45), subscription charges, and the burn rate spread evenly (median x 12 / 365). An overdue one-off with something unpaid counts on day 1; a missed recurring date does not. Drafts (stage draft, or is_draft) only when p_include_drafts. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_clean_description"("p_raw" "text", "p_strip_location" boolean DEFAULT false) RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  s    text := p_raw;
  m    text[];
  code int;
begin
  if s is null then
    return null;
  end if;

  -- HTML entities: numeric, then hex, then named, with &amp; last so it decodes once.
  loop
    m := regexp_match(s, '(&#([0-9]{1,7});)');
    exit when m is null;
    code := m[2]::int;
    s := replace(s, m[1], case when code between 1 and 55295 or code between 57344 and 1114111
                               then chr(code) else ' ' end);
  end loop;
  loop
    m := regexp_match(s, '(&#[xX]([0-9A-Fa-f]{1,6});)');
    exit when m is null;
    code := ('x' || lpad(m[2], 8, '0'))::bit(32)::int;
    s := replace(s, m[1], case when code between 1 and 55295 or code between 57344 and 1114111
                               then chr(code) else ' ' end);
  end loop;
  s := replace(s, '&nbsp;', ' ');
  s := replace(s, '&quot;', '"');
  s := replace(s, '&apos;', '''');
  s := replace(s, '&lt;', '<');
  s := replace(s, '&gt;', '>');
  s := replace(s, '&amp;', '&');

  -- URLs with a path ("g.co/helppay#CA", "amzn.com/bill"); a bare "AMAZON.COM" stays.
  s := regexp_replace(s, '(https?://)?\m([a-z0-9-]+\.)+[a-z]{2,6}/[^ ]*', ' ', 'gi');
  -- Masked account numbers and any short number after them: XXXX1234, ****1234, "XXXXX6   937".
  s := regexp_replace(s, '[Xx*]{3,}[0-9]{0,4}(\s+[0-9]{1,4})?\M', ' ', 'g');
  -- Reference numbers: REF #AB123, CONF: 99812, TRACE 0042 ...
  s := regexp_replace(s, '\m(REF|REFERENCE|CONF|CONFIRMATION|TRACE|TRN)\M\s*(#|NO\.?|NUM|:)?\s*[A-Z0-9-]*[0-9][A-Z0-9-]*', ' ', 'gi');
  -- Codes after an asterisk ("MKTP US*2K4HJ1"); a name after one ("SQ *CAFE") stays.
  s := regexp_replace(s, '\*\s*[A-Z0-9]*[0-9][A-Z0-9]*', ' ', 'gi');
  -- Phone numbers: 888-555-1234, (888) 555-1234, 888.555.1234, 888-5551234, 1-888-555-1234.
  s := regexp_replace(s, '(\m1[-. ])?\(?\m[0-9]{3}\)?[-. ]?[0-9]{3}[-. ]?[0-9]{4}\M', ' ', 'g');
  -- Upper-case codes of five or more that mix letters and digits, starting with a letter ("PTQV5S").
  s := regexp_replace(s, '\m[A-Z](?=[A-Z0-9]{4,}\M)[A-Z]*[0-9][A-Z0-9]*\M', ' ', 'g');
  -- Dates, with a leading "ON": "ON 10/02/26", "09/02/2026".
  s := regexp_replace(s, '(\mON\s+)?\m[0-9]{1,2}/[0-9]{1,2}(/[0-9]{2,4})?\M', ' ', 'gi');
  -- Store numbers and digit runs of four or more.
  s := regexp_replace(s, '#\s*[0-9]+', ' ', 'g');
  s := regexp_replace(s, '\m[0-9]{4,}\M', ' ', 'g');

  s := replace(s, '*', ' ');
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := btrim(s, ' -#.,:;/\');

  -- Trailing state code, only when a merchant matched. The city stays: without a
  -- city list, "one word before the state" also ate merchant words ("PET STORE AZ").
  if p_strip_location then
    s := regexp_replace(s, '\s+(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$', '');
    s := btrim(s, ' -#.,:;/\');
  end if;

  return nullif(s, '');
end;
$_$;


ALTER FUNCTION "public"."wb_clean_description"("p_raw" "text", "p_strip_location" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_clean_description"("p_raw" "text", "p_strip_location" boolean) IS 'Warren Buffet: readable description from raw bank text. Decodes HTML entities; drops URLs with a path, masked account numbers (and a short number after them), reference numbers, asterisk codes, phone numbers, mixed letter-digit codes, dates, store numbers and digit runs of four or more; collapses whitespace. With p_strip_location, also drops a trailing state code (the city stays).';



CREATE OR REPLACE FUNCTION "public"."wb_confirm_planned_match"("p_match_id" "uuid", "p_action" "text", "p_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  m      record;
  pi     record;
  v_paid boolean := false;
begin
  if p_action not in ('confirm', 'reject') then
    raise exception 'wb_confirm_planned_match: action must be confirm or reject' using errcode = '22023';
  end if;
  select * into m from public.wb_planned_matches where id = p_match_id for update;
  if not found then
    raise exception 'wb_confirm_planned_match: no match % that you can see', p_match_id using errcode = '23503';
  end if;
  if m.status <> 'suggested' then
    raise exception 'wb_confirm_planned_match: this match was already %', m.status using errcode = '22023';
  end if;
  select * into pi from public.wb_planned_items where id = m.planned_item_id;

  if p_action = 'reject' then
    update public.wb_planned_matches set status = 'rejected', decided_at = now() where id = p_match_id;
    return jsonb_build_object('status', 'rejected', 'stage_paid', false);
  end if;

  if p_amount is not null and p_amount = 0 then
    raise exception 'wb_confirm_planned_match: the amount cannot be zero' using errcode = '22023';
  end if;
  update public.wb_planned_matches
  set status = 'confirmed', decided_at = now(),
      amount_applied = case when p_amount is null then amount_applied else sign(pi.amount) * abs(p_amount) end
  where id = p_match_id;

  -- A one-off covered by confirmed matches (within its tolerance, A45) is paid. Never set back automatically.
  if pi.interval_count is null and pi.stage <> 'paid'
     and public.wb_planned_left(pi.amount, (select sum(abs(x.amount_applied)) from public.wb_planned_matches x
          where x.planned_item_id = pi.id and x.status = 'confirmed'), pi.amount_tolerance) = 0
  then
    update public.wb_planned_items set stage = 'paid' where id = pi.id;
    v_paid := true;
  end if;
  return jsonb_build_object('status', 'confirmed', 'stage_paid', v_paid);
end;
$$;


ALTER FUNCTION "public"."wb_confirm_planned_match"("p_match_id" "uuid", "p_action" "text", "p_amount" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_confirm_planned_match"("p_match_id" "uuid", "p_action" "text", "p_amount" numeric) IS 'Warren Buffet: confirm or reject one suggested planned match. confirm may lower the amount for a part-payment (p_amount, taken with the planned item''s sign); the trigger refuses more than the split. Confirming the last part of a one-off (covered within its amount_tolerance) sets its stage to paid; nothing sets it back automatically. A rejected match is never suggested again. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_default_kind"("p_account_role" "text", "p_amount" numeric, "p_description" "text", "p_payee" "text", "p_merchant_kind" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select case
    when p_account_role in ('retirement', 'taxable_investment') then 'investment'
    when p_merchant_kind is not null then p_merchant_kind
    when public.wb_is_transfer_phrase(concat_ws(' ', p_description, p_payee))
         and not public.wb_is_p2p_phrase(concat_ws(' ', p_description, p_payee)) then 'transfer'
    when p_amount > 0 and public.wb_is_interest_phrase(concat_ws(' ', p_description, p_payee)) then 'interest'
    when p_amount < 0 and public.wb_is_fee_phrase(concat_ws(' ', p_description, p_payee)) then 'fee'
    when p_amount > 0 and p_account_role in ('credit_card', 'emergency_credit') then 'refund'
    when p_amount > 0 then 'income'
    else 'spend'
  end;
$$;


ALTER FUNCTION "public"."wb_default_kind"("p_account_role" "text", "p_amount" numeric, "p_description" "text", "p_payee" "text", "p_merchant_kind" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_detect_subscriptions"("p_today" "date" DEFAULT NULL::"date") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_today   date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  g         record;
  v_ok      boolean;
  v_sub     uuid;
  v_created uuid[] := '{}';
  n_linked  int := 0;
  n_rows    int;
begin
  for g in
    with c as (
      select x.id, x.merchant_id,
             (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d,
             -x.amount as a
      from public.wb_transactions x
      join public.wb_merchants m on m.id = x.merchant_id
      where not x.pending
        and x.kind = 'spend'
        and x.amount < 0
        and x.subscription_id is null
        and coalesce(x.subscription_source, 'default') not in ('claude', 'manual')
        and not m.not_subscription
        and not exists (select 1 from public.wb_subscriptions s where s.merchant_id = x.merchant_id)
    )
    select c.merchant_id,
           count(*)::int                                                  as n,
           (percentile_cont(0.5) within group (order by c.a))::numeric    as med,
           array_agg(c.id order by c.d, c.id)                             as ids,
           array_agg(c.d order by c.d, c.id)                              as ds,
           array_agg(c.a order by c.d, c.id)                              as amts
    from c
    where c.d between v_today - 120 and v_today
    group by c.merchant_id
    having count(*) >= 3
  loop
    -- About a month apart, every time, and each within 10% of the median.
    v_ok := true;
    for i in 2 .. g.n loop
      if g.ds[i] - g.ds[i - 1] not between 26 and 35 then
        v_ok := false;
      end if;
    end loop;
    for i in 1 .. g.n loop
      if abs(g.amts[i] - g.med) > 0.10 * g.med then
        v_ok := false;
      end if;
    end loop;
    continue when not v_ok;

    insert into public.wb_subscriptions (user_id, context_id, name, merchant_id, cadence, expected_amount, status, notes)
    select m.user_id, m.context_id, m.name, m.id, 'monthly', g.amts[g.n], 'watching',
           format('Detected %s from %s monthly charges.', v_today, g.n)
    from public.wb_merchants m
    where m.id = g.merchant_id
    returning id into v_sub;

    insert into public.wb_subscription_prices (subscription_id, effective_on, amount, source, transaction_id)
    values (v_sub, g.ds[g.n], g.amts[g.n], 'detected', g.ids[g.n]);

    update public.wb_transactions
    set subscription_id = v_sub, subscription_source = 'default'
    where id = any (g.ids);
    get diagnostics n_rows = row_count;
    n_linked  := n_linked + n_rows;
    v_created := v_created || v_sub;
  end loop;

  perform public.wb_refresh_subscriptions(v_created);
  return jsonb_build_object('created', cardinality(v_created), 'linked', n_linked);
end;
$$;


ALTER FUNCTION "public"."wb_detect_subscriptions"("p_today" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_detect_subscriptions"("p_today" "date") IS 'Warren Buffet: called by wb-sync after processing. For each merchant with no subscription row and not marked not_subscription: 3 or more posted, unlinked spend charges in the last 120 days, each 26-35 days after the one before and within 10% of their median, become a watching subscription (monthly, price = the latest charge, source detected) and are linked to it. Security invoker. Returns created and linked counts.';



CREATE OR REPLACE FUNCTION "public"."wb_fix_plan"("p_transaction_id" "uuid", "p_pattern" "text" DEFAULT NULL::"text", "p_merchant_name" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  t          record;
  m          record;
  v_pattern  text := nullif(regexp_replace(lower(btrim(coalesce(p_pattern, ''))), '\s+', ' ', 'g'), '');
  v_name     text;
  v_merchant jsonb;
  v_dry      jsonb;
  v_rules    jsonb;
  v_warn     text[] := '{}';
begin
  select * into t from public.wb_transaction_list where id = p_transaction_id;
  if not found then
    raise exception 'wb_fix_plan: no transaction % that you can see', p_transaction_id using errcode = '23503';
  end if;
  if v_pattern is not null and length(v_pattern) < 3 then
    raise exception 'wb_fix_plan: a match pattern needs at least 3 characters' using errcode = '22023';
  end if;

  if t.merchant_id is not null and v_pattern is null then
    v_merchant := jsonb_build_object('id', t.merchant_id, 'name', t.merchant_name, 'exists', true, 'add_pattern', null);
    v_dry := public.wb_rule_preview(jsonb_build_object('merchant_id', t.merchant_id), null, 5);
  else
    v_pattern := coalesce(v_pattern, public.wb_suggest_pattern(t.payee, t.clean_description));
    if v_pattern is null then
      raise exception 'wb_fix_plan: no distinctive word to match on; pass a pattern' using errcode = '22023';
    end if;
    if t.merchant_id is not null then
      select id, name, match_patterns into m from public.wb_merchants where id = t.merchant_id;
    else
      v_name := coalesce(nullif(btrim(p_merchant_name), ''), initcap(v_pattern));
      select id, name, match_patterns into m from public.wb_merchants where lower(name) = lower(v_name) limit 1;
    end if;
    if m.id is not null then
      v_merchant := jsonb_build_object('id', m.id, 'name', m.name, 'exists', true,
        'add_pattern', case when v_pattern = any (m.match_patterns) then null else v_pattern end);
    else
      v_merchant := jsonb_build_object('id', null, 'name', v_name, 'exists', false, 'add_pattern', v_pattern);
    end if;
    v_dry := public.wb_rule_preview(null, v_pattern, 5);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'priority', r.priority, 'active', r.active, 'set_kind', r.set_kind,
           'add_tag_ids', r.add_tag_ids, 'hit_count', r.hit_count) order by r.priority, r.created_at), '[]'::jsonb)
  into v_rules
  from public.wb_rules r
  where v_merchant ->> 'id' is not null and r.match ->> 'merchant_id' = v_merchant ->> 'id';

  if (v_dry ->> 'too_narrow')::boolean then
    v_warn := v_warn || format('This would catch only %s past transaction(s): probably too narrow. Try a shorter pattern.', v_dry ->> 'count');
  end if;
  if jsonb_array_length(v_rules) > 0 then
    v_warn := v_warn || format('A rule already exists for %s: update it instead of adding another.', v_merchant ->> 'name');
  end if;

  return jsonb_build_object(
    'transaction', jsonb_build_object('id', t.id, 'txn_date', t.txn_date, 'account_label', t.account_label,
                     'payee', t.payee, 'clean_description', t.clean_description, 'kind', t.kind, 'tag_names', t.tag_names),
    'merchant', v_merchant,
    'pattern', v_pattern,
    'rule_match', jsonb_build_object('merchant_id', coalesce(v_merchant ->> 'id', '(the new merchant)')),
    'dry_run', jsonb_build_object('count', (v_dry ->> 'count')::int, 'too_narrow', (v_dry ->> 'too_narrow')::boolean,
                 'samples', v_dry -> 'samples'),
    'existing_rules', v_rules,
    'warnings', to_jsonb(v_warn),
    'ids', v_dry -> 'ids');
end;
$$;


ALTER FUNCTION "public"."wb_fix_plan"("p_transaction_id" "uuid", "p_pattern" "text", "p_merchant_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_fix_plan"("p_transaction_id" "uuid", "p_pattern" "text", "p_merchant_name" "text") IS 'Warren Buffet: the "Always do this" plan for one transaction (spec §6.1): the merchant (existing, or to create, with a short pattern), the dry-run count with a too-narrow warning at 1 or fewer, and the existing rules for that merchant. Writes nothing.';



CREATE OR REPLACE FUNCTION "public"."wb_free_cash"("p_include_drafts" boolean DEFAULT false, "p_today" "date" DEFAULT NULL::"date") RETURNS TABLE("today" "date", "start_balance" numeric, "spending_cash" numeric, "credit_owed" numeric, "reserve_cash" numeric, "low_balance" numeric, "low_on" "date", "safety_floor" numeric, "floor_missing" boolean, "free_cash" numeric, "horizon_months" integer, "burn_monthly" numeric, "burn_mean" numeric)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_cash  numeric;
  v_owed  numeric;
  v_res   numeric;
  v_floor numeric;
  v_h     int;
  v_low   numeric;
  v_on    date;
  v_med   numeric;
  v_mean  numeric;
begin
  select coalesce(sum(b.balance) filter (where a.role = 'spending_cash'), 0),
         coalesce(sum(least(b.balance, 0)) filter (where a.role in ('credit_card', 'emergency_credit')), 0),
         coalesce(sum(b.balance) filter (where a.role = 'reserve_cash'), 0)
  into v_cash, v_owed, v_res
  from public.wb_accounts a
  cross join lateral (select bs.balance from public.wb_balance_snapshots bs
                      where bs.account_id = a.id and bs.as_of <= v_today
                      order by bs.as_of desc limit 1) b
  where a.role in ('spending_cash', 'credit_card', 'emergency_credit', 'reserve_cash');

  select s.safety_floor, s.horizon_months into v_floor, v_h from public.wb_settings s order by s.created_at limit 1;
  select p.closing, p.day into v_low, v_on
  from public.wb_cash_projection(p_include_drafts, v_today) p
  order by p.closing, p.day
  limit 1;
  select max(br.burn_median), max(br.burn_mean) into v_med, v_mean from public.wb_burn_rate_on(v_today) br;

  return query select v_today, round(v_cash + v_owed, 2), round(v_cash, 2), round(v_owed, 2), round(v_res, 2),
                      v_low, v_on, coalesce(v_floor, 0), v_floor is null, round(v_low - coalesce(v_floor, 0), 2),
                      coalesce(v_h, 12), v_med, v_mean;
end;
$$;


ALTER FUNCTION "public"."wb_free_cash"("p_include_drafts" boolean, "p_today" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_free_cash"("p_include_drafts" boolean, "p_today" "date") IS 'Warren Buffet: free cash = the lowest closing balance of wb_cash_projection over the horizon, minus wb_settings.safety_floor (0 with floor_missing true when none is set). Also returns the start (spending cash plus credit owed, which is negative), the reserve on its own line (never counted), the low date, the horizon and the burn rate (median and mean). Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_is_fee_phrase"("p_text" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(p_text ~* '(\mfees?\M|interest\s+charge|finance\s+charge|overdraft|\mnsf\M|service\s+charge)', false);
$$;


ALTER FUNCTION "public"."wb_is_fee_phrase"("p_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_is_interest_phrase"("p_text" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(p_text ~* '\minterest\M', false);
$$;


ALTER FUNCTION "public"."wb_is_interest_phrase"("p_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_is_p2p_phrase"("p_text" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(p_text ~* '(\mvenmo\M|\mzelle\M|visa\s+direct|\mpaypal\M|cash\s*app|square\s+cash)', false);
$$;


ALTER FUNCTION "public"."wb_is_p2p_phrase"("p_text" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_is_p2p_phrase"("p_text" "text") IS 'Warren Buffet: true for payments to or from people (Venmo, Zelle, Visa Direct, PayPal, Cash App). Such a row is not a transfer by phrase; it pairs only when a unique opposite match exists on a household account.';



CREATE OR REPLACE FUNCTION "public"."wb_is_transfer_phrase"("p_text" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(p_text ~* '(payment\s*-?\s*thank\s*you|online\s+payment|auto\s*pay|online\s+transfer|transfer\s+(to|from)|\mxfer\M|\mepay\M|card\s+payment)', false);
$$;


ALTER FUNCTION "public"."wb_is_transfer_phrase"("p_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_link_subscription"("p_transaction_ids" "uuid"[], "p_subscription_id" "uuid", "p_source" "text" DEFAULT 'manual'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_old uuid[];
  n     int;
begin
  if p_source is null or p_source not in ('claude', 'manual') then
    raise exception 'wb_link_subscription: source must be claude or manual' using errcode = '22023';
  end if;
  if p_transaction_ids is null or cardinality(p_transaction_ids) = 0 then
    raise exception 'wb_link_subscription: give at least one transaction' using errcode = '22023';
  end if;
  if p_subscription_id is not null
     and not exists (select 1 from public.wb_subscriptions where id = p_subscription_id) then
    raise exception 'wb_link_subscription: no subscription % that you can see', p_subscription_id using errcode = '23503';
  end if;

  select coalesce(array_agg(distinct x.subscription_id) filter (where x.subscription_id is not null), '{}')
  into v_old
  from public.wb_transactions x
  where x.id = any (p_transaction_ids);

  update public.wb_transactions
  set subscription_id = p_subscription_id, subscription_source = p_source
  where id = any (p_transaction_ids);
  get diagnostics n = row_count;
  if n < cardinality(p_transaction_ids) then
    raise exception 'wb_link_subscription: a transaction id does not exist or you cannot see it' using errcode = '23503';
  end if;

  perform public.wb_refresh_subscriptions(v_old || p_subscription_id);
  return jsonb_build_object('linked', case when p_subscription_id is null then 0 else n end,
                            'unlinked', case when p_subscription_id is null then n else 0 end);
end;
$$;


ALTER FUNCTION "public"."wb_link_subscription"("p_transaction_ids" "uuid"[], "p_subscription_id" "uuid", "p_source" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_link_subscription"("p_transaction_ids" "uuid"[], "p_subscription_id" "uuid", "p_source" "text") IS 'Warren Buffet: link transactions to a subscription by hand (null unlinks), with source claude or manual, so processing never changes the link. Refreshes the old and new subscriptions'' dates. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_monthly_equivalent"("p_amount" numeric, "p_interval_count" integer, "p_interval_unit" "text") RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- If you change 52 or 12, update help entries subscriptions.monthly_total,
  -- subscriptions.breakdown and overview.true_cost in src/money/helpText.js, its test,
  -- and moneyFormat.monthlyEquivalent (WEEKS_PER_YEAR, MONTHS_PER_YEAR).
  select case
    when p_amount is null or coalesce(p_interval_count, 0) <= 0 then null
    when p_interval_unit = 'month' then p_amount / p_interval_count
    when p_interval_unit = 'week'  then p_amount * 52 / 12 / p_interval_count
  end;
$$;


ALTER FUNCTION "public"."wb_monthly_equivalent"("p_amount" numeric, "p_interval_count" integer, "p_interval_unit" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_monthly_equivalent"("p_amount" numeric, "p_interval_count" integer, "p_interval_unit" "text") IS 'Warren Buffet: an amount per interval as a monthly amount: months divide by the count, weeks multiply by 52 / 12 / count; null with no interval. The same rule as moneyFormat.monthlyEquivalent in the app (spec A12).';



CREATE OR REPLACE FUNCTION "public"."wb_pair_decision"("p_forward" integer, "p_reverse" integer) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select case
    when coalesce(p_forward, 0) = 0 then 'none'
    when p_forward = 1 and p_reverse = 1 then 'pair'
    else 'ambiguous'
  end;
$$;


ALTER FUNCTION "public"."wb_pair_decision"("p_forward" integer, "p_reverse" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_planned_left"("p_amount" numeric, "p_paid" numeric, "p_tolerance" numeric) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select sign(p_amount) * case when abs(p_amount) - coalesce(p_paid, 0) <= coalesce(p_tolerance, 0) then 0
                               else abs(p_amount) - coalesce(p_paid, 0) end;
$$;


ALTER FUNCTION "public"."wb_planned_left"("p_amount" numeric, "p_paid" numeric, "p_tolerance" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_planned_left"("p_amount" numeric, "p_paid" numeric, "p_tolerance" numeric) IS 'Warren Buffet: the amount still due on a planned amount (signed like p_amount), given p_paid (the confirmed amount_applied, as a positive number) and the item''s amount_tolerance. 0 when what is left is within the tolerance, so a payment a cent short still covers it (A45); never negative in magnitude.';



CREATE OR REPLACE FUNCTION "public"."wb_planned_matches_fill"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  p         record;
  v_tid     uuid;
  v_split   numeric;
  v_pending boolean;
  v_used    numeric;
begin
  select pi.user_id, pi.context_id, pi.amount, pi.interval_count into p
  from public.wb_planned_items pi where pi.id = new.planned_item_id;
  if not found then
    raise exception 'wb_planned_matches: planned item % not found', new.planned_item_id using errcode = '23503';
  end if;
  select s.transaction_id, s.amount, x.pending into v_tid, v_split, v_pending
  from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
  where s.id = new.split_id;
  if not found then
    raise exception 'wb_planned_matches: split % not found', new.split_id using errcode = '23503';
  end if;

  new.user_id := p.user_id;
  new.context_id := p.context_id;
  new.transaction_id := v_tid;

  if v_pending then
    raise exception 'wb_planned_matches: a pending transaction cannot be matched' using errcode = '23514';
  end if;
  if p.interval_count is not null and new.occurrence_on is null then
    raise exception 'wb_planned_matches: a recurring planned item needs occurrence_on' using errcode = '23514';
  end if;
  if p.interval_count is null and new.occurrence_on is not null then
    raise exception 'wb_planned_matches: a one-off planned item has no occurrence_on' using errcode = '23514';
  end if;
  if sign(new.amount_applied) <> sign(p.amount) then
    raise exception 'wb_planned_matches: amount_applied must have the planned item''s sign' using errcode = '23514';
  end if;
  if new.status = 'confirmed' then
    select coalesce(sum(abs(m.amount_applied)), 0) into v_used
    from public.wb_planned_matches m
    where m.split_id = new.split_id and m.status = 'confirmed' and m.id <> new.id;
    if v_used + abs(new.amount_applied) > abs(v_split) then
      raise exception 'wb_planned_matches: confirmed matches on this split would exceed its amount' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_planned_matches_fill"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_planned_occurrences"("p_from" "date", "p_to" "date", "p_include_drafts" boolean DEFAULT false) RETURNS TABLE("planned_item_id" "uuid", "occurrence_on" "date", "amount" numeric, "recurring" boolean, "stage" "text", "is_draft" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select pi.id, pi.due_on, pi.amount, false, pi.stage, pi.stage = 'draft'
  from public.wb_planned_items pi
  where pi.interval_count is null
    and pi.stage <> 'cancelled'
    and (p_include_drafts or pi.stage <> 'draft')
    and pi.due_on between p_from and p_to
  union all
  select pi.id, o.d, pi.amount, true, null, pi.is_draft
  from public.wb_planned_items pi
  cross join lateral (
    select (case when pi.interval_unit = 'month'
                 then pi.due_on + make_interval(months => k * pi.interval_count)
                 else pi.due_on + make_interval(days => 7 * k * pi.interval_count) end)::date as d
    from generate_series(0, greatest(0, ceil((p_to - pi.due_on)::numeric
           / (case when pi.interval_unit = 'month' then 28 else 7 end * pi.interval_count))::int)) k
  ) o
  where pi.interval_count is not null
    and (p_include_drafts or not pi.is_draft)
    and o.d between p_from and p_to
    and (pi.ends_on is null or o.d <= pi.ends_on);
$$;


ALTER FUNCTION "public"."wb_planned_occurrences"("p_from" "date", "p_to" "date", "p_include_drafts" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_planned_occurrences"("p_from" "date", "p_to" "date", "p_include_drafts" boolean) IS 'Warren Buffet: every due date of the planned items between p_from and p_to. A one-off has one (its due_on); a recurring item repeats from due_on by its interval until ends_on, each date counted from due_on (so a month-end date stays month-end). Cancelled one-offs are left out; drafts (stage draft, or is_draft on a recurring item) only when p_include_drafts. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_planned_skips_fill"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  p record;
begin
  select pi.user_id, pi.context_id, pi.interval_count into p
  from public.wb_planned_items pi where pi.id = new.planned_item_id;
  if not found then
    raise exception 'wb_planned_skips: planned item % not found', new.planned_item_id using errcode = '23503';
  end if;
  new.user_id := p.user_id;
  new.context_id := p.context_id;
  if p.interval_count is not null and new.occurrence_on is null then
    raise exception 'wb_planned_skips: a recurring planned item needs occurrence_on' using errcode = '23514';
  end if;
  if p.interval_count is null and new.occurrence_on is not null then
    raise exception 'wb_planned_skips: a one-off planned item has no occurrence_on' using errcode = '23514';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_planned_skips_fill"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_planned_start_from_history"("p_merchant_id" "uuid", "p_amount" numeric, "p_amount_tolerance" numeric DEFAULT 0, "p_today" "date" DEFAULT NULL::"date") RETURNS "date"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with t as (select coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date) as d),
  -- The first burn month, so every payment the burn rate counts is matched.
  w as (select coalesce((select min(b.month) from t, public.wb_burn_rate_on(t.d) b), t.d) as first_day, t.d from t)
  select min(c.d)
  from w
  join public.wb_transactions x on x.merchant_id = p_merchant_id and not x.pending
  cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
  join public.wb_splits s on s.transaction_id = x.id
  where p_merchant_id is not null
    and coalesce(p_amount, 0) <> 0
    and c.d between w.first_day and w.d
    and sign(s.amount) = sign(p_amount)
    and abs(abs(s.amount) - abs(p_amount)) <= coalesce(p_amount_tolerance, 0)
    -- A split already fully confirmed against other planned items is not this item's.
    and coalesce((select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                  where pm.split_id = s.id and pm.status = 'confirmed'), 0) < abs(s.amount);
$$;


ALTER FUNCTION "public"."wb_planned_start_from_history"("p_merchant_id" "uuid", "p_amount" numeric, "p_amount_tolerance" numeric, "p_today" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_planned_start_from_history"("p_merchant_id" "uuid", "p_amount" numeric, "p_amount_tolerance" numeric, "p_today" "date") IS 'Warren Buffet: the date of the earliest posted payment at the merchant, with the amount''s sign and within the tolerance, from the first burn month (wb_burn_rate_on) to p_today, leaving out splits already fully confirmed against other planned items. Null when there is none, or no merchant. Used as the first due date of a new repeating item, so every payment the burn rate counts is matched (A34). Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_process_transactions"("ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id         uuid;
  t            record;
  cur          record;
  r            record;
  v_tag        record;
  v_merchant   uuid;
  v_msource    text;
  v_mkind      text;
  v_clean      text;
  v_kind       text;
  v_ksource    text;
  v_p2p        boolean;
  v_date       date;
  v_fwd        int;
  v_rev        int;
  v_match      record;
  v_split      uuid;
  v_nsplits    int;
  v_matched    uuid[];
  v_sub        uuid;
  v_nsubs      int;
  v_subs       uuid[] := '{}';
  v_project    uuid;
  v_psource    text;
  v_posted     uuid[] := '{}';
  v_sugg       jsonb;
  n_processed  int := 0;
  n_paired     int := 0;
  n_candidates int := 0;
  n_tags       int := 0;
  n_rules      int := 0;
  n_linked     int := 0;
  n_projects   int := 0;
begin
  if ids is null or cardinality(ids) = 0 then
    return jsonb_build_object('processed', 0, 'paired', 0, 'transfer_candidates', 0, 'rule_tags', 0, 'rules_updated', 0,
                              'subscriptions_linked', 0, 'rule_projects', 0, 'matches_suggested', 0);
  end if;

  for v_id in
    select x.id from public.wb_transactions x
    where x.id = any(ids)
    order by coalesce(x.posted_at, x.transacted_at), x.id
  loop
    -- Read fresh each time: pairing an earlier row may have changed this one.
    select x.*, a.role as account_role, a.source as account_source
    into t
    from public.wb_transactions x
    join public.wb_accounts a on a.id = x.account_id
    where x.id = v_id;
    continue when not found;

    -- 2. Merchant (before cleaning, which strips the city only when one matched).
    if t.merchant_source in ('claude', 'manual') then
      v_merchant := t.merchant_id;
      v_msource  := t.merchant_source;
    else
      v_merchant := null;
      if t.payee is not null then
        select m.id into v_merchant
        from public.wb_merchants m, unnest(m.match_patterns) p
        where position(lower(p) in lower(t.payee)) > 0
        order by length(p) desc, m.name, m.id
        limit 1;
      end if;
      if v_merchant is null and t.description is not null then
        select m.id into v_merchant
        from public.wb_merchants m, unnest(m.match_patterns) p
        where position(lower(p) in lower(t.description)) > 0
        order by length(p) desc, m.name, m.id
        limit 1;
      end if;
      v_msource := case when v_merchant is null then null else 'default' end;
    end if;
    select default_kind into v_mkind from public.wb_merchants where id = v_merchant;

    -- 1. Clean.
    v_clean := public.wb_clean_description(coalesce(nullif(btrim(t.description), ''), t.payee), v_merchant is not null);

    -- 3. Default kind.
    v_kind    := t.kind;
    v_ksource := t.kind_source;
    if coalesce(t.kind_source, 'default') not in ('claude', 'manual') and t.transfer_pair_id is null then
      v_kind    := public.wb_default_kind(t.account_role, t.amount, t.description, t.payee, v_mkind);
      v_ksource := 'default';
    end if;
    v_p2p := public.wb_is_p2p_phrase(concat_ws(' ', t.description, t.payee));

    update public.wb_transactions
    set clean_description  = v_clean,
        merchant_id        = v_merchant,
        merchant_source    = v_msource,
        kind               = v_kind,
        kind_source        = v_ksource,
        transfer_candidate = false
    where id = t.id;

    v_date := (coalesce(t.posted_at, t.transacted_at) at time zone 'America/Los_Angeles')::date;

    -- 4. Transfer pairing: posted rows on household accounts, never claude/manual.
    --    A payment to a person is tried too, but only pairs; it is never a candidate.
    if not t.pending
       and t.transfer_pair_id is null
       and (v_kind = 'transfer' or v_p2p)
       and coalesce(v_ksource, 'default') not in ('claude', 'manual')
       and t.account_source = 'simplefin'
       and t.account_role not in ('closed', 'history_rollup')
    then
      select count(*)::int into v_fwd
      from public.wb_transactions c
      join public.wb_accounts ca on ca.id = c.account_id
      where c.id <> t.id
        and c.amount = -t.amount
        and not c.pending
        and c.transfer_pair_id is null
        and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
        and ca.source = 'simplefin'
        and ca.role not in ('closed', 'history_rollup')
        and public.wb_transfer_match(t.account_id, t.amount, v_date, c.account_id, c.amount,
              (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);

      v_rev := 0;
      if v_fwd = 1 then
        select c.id, c.account_id, c.amount,
               (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date as d
        into v_match
        from public.wb_transactions c
        join public.wb_accounts ca on ca.id = c.account_id
        where c.id <> t.id
          and c.amount = -t.amount
          and not c.pending
          and c.transfer_pair_id is null
          and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
          and ca.source = 'simplefin'
          and ca.role not in ('closed', 'history_rollup')
          and public.wb_transfer_match(t.account_id, t.amount, v_date, c.account_id, c.amount,
                (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);

        select count(*)::int into v_rev
        from public.wb_transactions c
        join public.wb_accounts ca on ca.id = c.account_id
        where c.id <> v_match.id
          and c.amount = -v_match.amount
          and not c.pending
          and c.transfer_pair_id is null
          and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
          and ca.source = 'simplefin'
          and ca.role not in ('closed', 'history_rollup')
          and public.wb_transfer_match(v_match.account_id, v_match.amount, v_match.d, c.account_id, c.amount,
                (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);
      end if;

      if public.wb_pair_decision(v_fwd, v_rev) = 'pair' then
        update public.wb_transactions
        set transfer_pair_id = v_match.id, kind = 'transfer', kind_source = 'default', transfer_candidate = false
        where id = t.id;
        update public.wb_transactions
        set transfer_pair_id = t.id, kind = 'transfer', kind_source = 'default', transfer_candidate = false
        where id = v_match.id;
        v_kind     := 'transfer';
        v_ksource  := 'default';
        n_paired   := n_paired + 1;
      elsif v_kind = 'transfer' then
        update public.wb_transactions set transfer_candidate = true where id = t.id;
        n_candidates := n_candidates + 1;
      end if;
    end if;

    -- 5. Rules: posted rows only. Rule tags are replaced; claude/manual tags stay,
    --    and a tag removed by hand (wb_tag_exclusions) is never put back.
    v_matched := '{}';
    v_project := null;
    if not t.pending then
      v_posted := v_posted || t.id;
      select count(*)::int, (array_agg(s.id order by s.position, s.id))[1]
      into v_nsplits, v_split
      from public.wb_splits s
      where s.transaction_id = t.id;

      delete from public.wb_split_tags st
      using public.wb_splits s
      where st.split_id = s.id and s.transaction_id = t.id and st.source = 'rule';

      select x.kind, x.kind_source, x.merchant_id, x.merchant_source, x.transfer_pair_id, x.clean_description
      into cur
      from public.wb_transactions x
      where x.id = t.id;

      for r in
        select * from public.wb_rules where active order by priority, created_at, id
      loop
        continue when not public.wb_rule_matches(r.match, t.account_id, t.amount, t.payee, t.description,
                                                 cur.clean_description, cur.merchant_id, cur.kind);
        v_matched := v_matched || r.id;

        if r.set_kind is not null
           and coalesce(cur.kind_source, 'default') not in ('claude', 'manual')
           and cur.transfer_pair_id is null
        then
          update public.wb_transactions set kind = r.set_kind, kind_source = 'rule' where id = t.id;
          cur.kind := r.set_kind;
          cur.kind_source := 'rule';
        end if;

        if r.set_merchant_id is not null and coalesce(cur.merchant_source, 'default') not in ('claude', 'manual') then
          update public.wb_transactions set merchant_id = r.set_merchant_id, merchant_source = 'rule' where id = t.id;
          cur.merchant_id := r.set_merchant_id;
          cur.merchant_source := 'rule';
        end if;

        -- The first matching rule that sets a project wins.
        if r.set_project_id is not null and v_project is null then
          v_project := r.set_project_id;
        end if;

        -- Tags only on a single-split transaction; multi-split ones are left to people.
        if v_nsplits = 1 then
          for v_tag in
            select tg.id, tg.group_id, g.exclusive
            from unnest(r.add_tag_ids) with ordinality as x(tag_id, ord)
            join public.wb_tags tg on tg.id = x.tag_id and tg.is_active
            join public.wb_tag_groups g on g.id = tg.group_id
            order by x.ord
          loop
            continue when exists (
              select 1 from public.wb_tag_exclusions e where e.transaction_id = t.id and e.tag_id = v_tag.id);
            continue when v_tag.exclusive and exists (
              select 1 from public.wb_split_tags where split_id = v_split and group_id = v_tag.group_id);
            insert into public.wb_split_tags (split_id, tag_id, source, rule_id)
            values (v_split, v_tag.id, 'rule', r.id)
            on conflict (split_id, tag_id) do nothing;
            if found then
              n_tags := n_tags + 1;
            end if;
          end loop;
        end if;
      end loop;

      -- 5c. Project, on a single-split transaction only. A project set or removed
      --     by hand or by Claude stays; a rule's project goes when no rule sets one.
      if v_nsplits = 1 then
        select s.project_source into v_psource from public.wb_splits s where s.id = v_split;
        if coalesce(v_psource, 'rule') = 'rule' then
          update public.wb_splits
          set project_id = v_project, project_source = case when v_project is null then null else 'rule' end
          where id = v_split
            and (project_id is distinct from v_project
                 or project_source is distinct from case when v_project is null then null else 'rule' end);
          if found and v_project is not null then
            n_projects := n_projects + 1;
          end if;
        end if;
      end if;

      -- 5b. Subscription: a posted spend charge links to its merchant's one
      --     non-cancelled subscription, or, when it has several, to the one whose
      --     price is within its tolerance. Hand links (claude/manual) stay.
      if coalesce(t.subscription_source, 'default') not in ('claude', 'manual') then
        v_sub := null;
        if cur.kind = 'spend' and t.amount < 0 and cur.merchant_id is not null then
          select count(*)::int, (array_agg(s.id))[1] into v_nsubs, v_sub
          from public.wb_subscriptions s
          where s.merchant_id = cur.merchant_id and s.status <> 'cancelled';
          if v_nsubs > 1 then
            select count(*)::int, (array_agg(s.id))[1] into v_nsubs, v_sub
            from public.wb_subscriptions s
            where s.merchant_id = cur.merchant_id and s.status <> 'cancelled'
              and abs(-t.amount - public.wb_subscription_price_on(s.id, v_date)) <= s.amount_tolerance;
            if v_nsubs <> 1 then
              v_sub := null;
            end if;
          end if;
        end if;
        if v_sub is distinct from t.subscription_id then
          update public.wb_transactions
          set subscription_id = v_sub, subscription_source = case when v_sub is null then null else 'default' end
          where id = t.id;
          if v_sub is not null then
            n_linked := n_linked + 1;
          end if;
        end if;
      end if;
    end if;
    if t.subscription_id is not null then
      v_subs := v_subs || t.subscription_id;
    end if;
    if v_sub is not null then
      v_subs := v_subs || v_sub;
    end if;
    v_sub := null;

    -- 6. Done.
    update public.wb_transactions
    set matched_rule_ids = v_matched, processed_at = now()
    where id = t.id;
    n_processed := n_processed + 1;
  end loop;

  perform public.wb_refresh_subscriptions(v_subs);

  -- Rule hit counts, recomputed (not incremented) and written only when changed.
  with h as (
    select ru.id,
           count(x.id)::int as n,
           max(coalesce(x.posted_at, x.transacted_at)) as last_hit
    from public.wb_rules ru
    left join public.wb_transactions x on ru.id = any(x.matched_rule_ids)
    group by ru.id
  )
  update public.wb_rules ru
  set hit_count = h.n, last_hit_at = h.last_hit
  from h
  where ru.id = h.id
    and (ru.hit_count is distinct from h.n or ru.last_hit_at is distinct from h.last_hit);
  get diagnostics n_rules = row_count;

  -- 7. Planned match suggestions for the posted rows processed here.
  v_sugg := case when cardinality(v_posted) > 0
                 then public.wb_suggest_planned_matches(v_posted, null)
                 else jsonb_build_object('suggested', 0) end;

  return jsonb_build_object(
    'processed', n_processed,
    'paired', n_paired,
    'transfer_candidates', n_candidates,
    'rule_tags', n_tags,
    'rules_updated', n_rules,
    'subscriptions_linked', n_linked,
    'rule_projects', n_projects,
    'matches_suggested', (v_sugg ->> 'suggested')::int);
end;
$$;


ALTER FUNCTION "public"."wb_process_transactions"("ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_process_transactions"("ids" "uuid"[]) IS 'Warren Buffet: clean, merchant, default kind, transfer pairing, rules (kind, merchant, tags and, on a single split, the first matching rule''s project), subscription links, then planned match suggestions for the given transactions (Phase 2 spec §5, §4.8; Phase 3 spec §3.5). Security invoker. Never changes a claude or manual kind, merchant, tag, project or subscription link, and never puts back a tag or project removed by hand; pairs, tags, sets projects and links posted rows only; a payment to a person pairs only on a unique match and is never a transfer candidate. Safe to re-run. Returns counts.';



CREATE OR REPLACE FUNCTION "public"."wb_refresh_subscriptions"("p_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  with last as (
    select s.id, s.interval_count, s.interval_unit, s.term_end_date,
           max((coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date) as last_on
    from public.wb_subscriptions s
    left join public.wb_transactions x on x.subscription_id = s.id and not x.pending
    where s.id = any (p_ids)
    group by s.id
  ),
  nxt as (
    select l.id, l.last_on,
           (case l.interval_unit
              when 'week'  then l.last_on + 7 * l.interval_count
              when 'month' then (l.last_on + make_interval(months => l.interval_count))::date
            end) as base,
           l.term_end_date
    from last l
  )
  update public.wb_subscriptions s
  set last_charged_on  = n2.last_on,
      next_expected_on = case when n2.term_end_date is not null and (n2.base is null or n2.term_end_date > n2.base)
                              then n2.term_end_date else n2.base end
  from nxt n2
  where s.id = n2.id
    and (s.last_charged_on is distinct from n2.last_on
         or s.next_expected_on is distinct from
            case when n2.term_end_date is not null and (n2.base is null or n2.term_end_date > n2.base)
                 then n2.term_end_date else n2.base end);
  get diagnostics n = row_count;
  return n;
end;
$$;


ALTER FUNCTION "public"."wb_refresh_subscriptions"("p_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_refresh_subscriptions"("p_ids" "uuid"[]) IS 'Warren Buffet: recompute last_charged_on and next_expected_on (last charge plus the billing interval, or term_end_date when later) for the given subscriptions, writing only rows that change. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_replace_splits"("p_transaction_id" "uuid", "p_splits" "jsonb", "p_source" "text" DEFAULT 'claude'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_amount numeric;
  v_sum    numeric;
  v_split  uuid;
  v_first  uuid;
  v_old    uuid[];
  v_n      int;
  e        record;
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_replace_splits: source must be claude or manual' using errcode = '22023';
  end if;
  if jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'wb_replace_splits: splits must be a non-empty array' using errcode = '22023';
  end if;
  select amount into v_amount from public.wb_transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'wb_replace_splits: no transaction % that you can see', p_transaction_id using errcode = '23503';
  end if;
  select sum((s ->> 'amount')::numeric) into v_sum from jsonb_array_elements(p_splits) s;
  if v_sum is distinct from v_amount then
    raise exception 'wb_replace_splits: splits sum to %, but the transaction is %', v_sum, v_amount using errcode = '23514';
  end if;
  -- Two tags from one exclusive group on one split.
  if exists (
    select 1
    from jsonb_array_elements(p_splits) with ordinality as sp(s, pos)
    cross join lateral jsonb_array_elements_text(coalesce(sp.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id)
    join public.wb_tags tg on tg.id = t.tag_id::uuid
    join public.wb_tag_groups g on g.id = tg.group_id and g.exclusive
    group by sp.pos, g.id
    having count(*) > 1
  ) then
    raise exception 'wb_replace_splits: a split has two tags from one exclusive group' using errcode = '23505';
  end if;

  select array_agg(s.id order by s.position, s.created_at, s.id) into v_old
  from public.wb_splits s where s.transaction_id = p_transaction_id;
  v_old := coalesce(v_old, '{}');
  v_n := jsonb_array_length(p_splits);

  for e in select s, pos from jsonb_array_elements(p_splits) with ordinality as sp(s, pos) order by pos
  loop
    if e.pos <= cardinality(v_old) then
      v_split := v_old[e.pos];
      update public.wb_splits
      set amount         = (e.s ->> 'amount')::numeric,
          description    = nullif(btrim(e.s ->> 'description'), ''),
          tax_year       = (e.s ->> 'tax_year')::int,
          notes          = nullif(btrim(e.s ->> 'notes'), ''),
          position       = e.pos::int - 1,
          project_id     = case when e.s ? 'project_id' then (e.s ->> 'project_id')::uuid else project_id end,
          project_source = case when e.s ? 'project_id' then p_source else project_source end
      where id = v_split;
      delete from public.wb_split_tags where split_id = v_split;
    else
      insert into public.wb_splits (transaction_id, amount, description, tax_year, notes, position, project_id, project_source)
      values (p_transaction_id, (e.s ->> 'amount')::numeric, nullif(btrim(e.s ->> 'description'), ''),
              (e.s ->> 'tax_year')::int, nullif(btrim(e.s ->> 'notes'), ''), e.pos::int - 1,
              (e.s ->> 'project_id')::uuid, case when e.s ? 'project_id' then p_source end)
      returning id into v_split;
    end if;
    if e.pos = 1 then
      v_first := v_split;
    end if;
    insert into public.wb_split_tags (split_id, tag_id, source)
    select v_split, t.tag_id::uuid, p_source
    from jsonb_array_elements_text(coalesce(e.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id)
    on conflict (split_id, tag_id) do nothing;
  end loop;

  -- Splits past the new count go; their planned matches move to the first split.
  if cardinality(v_old) > v_n then
    update public.wb_planned_matches
    set split_id = v_first
    where split_id = any (v_old[v_n + 1:]);
    delete from public.wb_splits where id = any (v_old[v_n + 1:]);
  end if;
  -- A split made smaller than what is already confirmed against it.
  if exists (
    select 1 from public.wb_splits s
    join public.wb_planned_matches m on m.split_id = s.id and m.status = 'confirmed'
    where s.transaction_id = p_transaction_id
    group by s.id, s.amount
    having sum(abs(m.amount_applied)) > abs(s.amount)
  ) then
    raise exception 'wb_replace_splits: a split would be smaller than the planned matches confirmed against it' using errcode = '23514';
  end if;

  -- Tags put on by hand here are wanted again: their removals no longer apply.
  delete from public.wb_tag_exclusions x
  where x.transaction_id = p_transaction_id
    and x.tag_id in (
      select t.tag_id::uuid
      from jsonb_array_elements(p_splits) sp(s)
      cross join lateral jsonb_array_elements_text(coalesce(sp.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id));

  return jsonb_build_object('transaction_id', p_transaction_id, 'splits', (
    select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'amount', s.amount,
             'description', s.description, 'tax_year', s.tax_year, 'project_id', s.project_id,
             'project_source', s.project_source,
             'tag_ids', coalesce((select jsonb_agg(st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '[]'::jsonb))
           order by s.position)
    from public.wb_splits s where s.transaction_id = p_transaction_id));
end;
$$;


ALTER FUNCTION "public"."wb_replace_splits"("p_transaction_id" "uuid", "p_splits" "jsonb", "p_source" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_replace_splits"("p_transaction_id" "uuid", "p_splits" "jsonb", "p_source" "text") IS 'Warren Buffet: replace all splits of one transaction, with their tags (source claude or manual), in one transaction. Amounts must sum to the transaction amount. Existing split rows are reused by position, so their ids, project links and planned matches survive; project_id (and project_source, set to the caller''s source) changes only where the input gives the key (null clears it, and the clearing sticks); splits beyond the new count are deleted after their planned matches move to the first split. A tag added here by hand clears its wb_tag_exclusions row.';



CREATE OR REPLACE FUNCTION "public"."wb_rule_matches"("p_match" "jsonb", "p_account_id" "uuid", "p_amount" numeric, "p_payee" "text", "p_description" "text", "p_clean" "text", "p_merchant_id" "uuid", "p_kind" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    (not p_match ? 'merchant_id' or p_merchant_id::text = p_match ->> 'merchant_id')
    and (not p_match ? 'payee_contains'
         or position(lower(p_match ->> 'payee_contains') in lower(coalesce(p_payee, ''))) > 0)
    and (not p_match ? 'description_contains'
         or position(lower(p_match ->> 'description_contains') in lower(coalesce(p_description, ''))) > 0
         or position(lower(p_match ->> 'description_contains') in lower(coalesce(p_clean, ''))) > 0)
    and (not p_match ? 'account_ids' or (p_match -> 'account_ids') ? p_account_id::text)
    and (not p_match ? 'amount_min' or abs(p_amount) >= (p_match ->> 'amount_min')::numeric)
    and (not p_match ? 'amount_max' or abs(p_amount) <= (p_match ->> 'amount_max')::numeric)
    and (not p_match ? 'kind' or p_kind = p_match ->> 'kind'),
    false);
$$;


ALTER FUNCTION "public"."wb_rule_matches"("p_match" "jsonb", "p_account_id" "uuid", "p_amount" numeric, "p_payee" "text", "p_description" "text", "p_clean" "text", "p_merchant_id" "uuid", "p_kind" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_rule_preview"("p_match" "jsonb" DEFAULT NULL::"jsonb", "p_pattern" "text" DEFAULT NULL::"text", "p_samples" integer DEFAULT 5) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_pattern text := lower(btrim(coalesce(p_pattern, '')));
  v_ids     uuid[];
  v_samples jsonb;
begin
  if (p_match is null) = (v_pattern = '') then
    raise exception 'wb_rule_preview: pass exactly one of p_match or p_pattern' using errcode = '22023';
  end if;
  if p_match is not null and (jsonb_typeof(p_match) <> 'object' or p_match = '{}'::jsonb) then
    raise exception 'wb_rule_preview: p_match must be a non-empty object' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id order by coalesce(x.posted_at, x.transacted_at) desc, x.id), '{}')
  into v_ids
  from public.wb_transactions x
  where not x.pending
    and case
          when p_match is not null then
            public.wb_rule_matches(p_match, x.account_id, x.amount, x.payee, x.description,
                                   x.clean_description, x.merchant_id, x.kind)
          else position(v_pattern in lower(coalesce(x.payee, ''))) > 0
               or position(v_pattern in lower(coalesce(x.description, ''))) > 0
        end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'txn_date', l.txn_date, 'amount', l.amount, 'account_label', l.account_label,
           'clean_description', l.clean_description, 'payee', l.payee, 'merchant_name', l.merchant_name,
           'kind', l.kind, 'tag_names', l.tag_names)
         order by l.txn_date desc, l.id), '[]'::jsonb)
  into v_samples
  from public.wb_transaction_list l
  where l.id = any (v_ids[1:greatest(coalesce(p_samples, 5), 0)]);

  return jsonb_build_object('count', cardinality(v_ids), 'too_narrow', cardinality(v_ids) <= 1,
                            'samples', v_samples, 'ids', to_jsonb(v_ids));
end;
$$;


ALTER FUNCTION "public"."wb_rule_preview"("p_match" "jsonb", "p_pattern" "text", "p_samples" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_rule_preview"("p_match" "jsonb", "p_pattern" "text", "p_samples" integer) IS 'Warren Buffet: dry run for a rule (p_match, through wb_rule_matches, exactly as processing) or a merchant pattern (p_pattern, substring of payee or description). Posted rows only. Returns count, too_narrow (count <= 1), samples and ids. Writes nothing.';



CREATE OR REPLACE FUNCTION "public"."wb_rules_check_tags"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if exists (
    select 1 from unnest(new.add_tag_ids) x(tag_id)
    where not exists (select 1 from public.wb_tags t where t.id = x.tag_id)
  ) then
    raise exception 'wb_rules: add_tag_ids holds a tag that does not exist' using errcode = '23503';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_rules_check_tags"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_set_transfer_pair"("p_id" "uuid", "p_pair_with" "uuid", "p_source" "text" DEFAULT 'claude'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  a record;
  b record;
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_set_transfer_pair: source must be claude or manual' using errcode = '22023';
  end if;
  select id, account_id, amount, transfer_pair_id into a from public.wb_transactions where id = p_id for update;
  if not found then
    raise exception 'wb_set_transfer_pair: no transaction % that you can see', p_id using errcode = '23503';
  end if;

  if p_pair_with is null then
    if a.transfer_pair_id is null then
      return jsonb_build_object('unpaired', '[]'::jsonb);
    end if;
    update public.wb_transactions
    set transfer_pair_id = null, kind_source = p_source, transfer_candidate = false
    where id in (a.id, a.transfer_pair_id);
    return jsonb_build_object('unpaired', jsonb_build_array(a.id, a.transfer_pair_id));
  end if;

  if p_pair_with = p_id then
    raise exception 'wb_set_transfer_pair: a transaction cannot pair with itself' using errcode = '22023';
  end if;
  select id, account_id, amount, transfer_pair_id into b from public.wb_transactions where id = p_pair_with for update;
  if not found then
    raise exception 'wb_set_transfer_pair: no transaction % that you can see', p_pair_with using errcode = '23503';
  end if;
  if a.account_id = b.account_id then
    raise exception 'wb_set_transfer_pair: both rows are on the same account' using errcode = '22023';
  end if;
  if sign(a.amount) = sign(b.amount) then
    raise exception 'wb_set_transfer_pair: a transfer needs one row out (negative) and one in (positive)' using errcode = '22023';
  end if;
  if (a.transfer_pair_id is not null and a.transfer_pair_id <> b.id)
     or (b.transfer_pair_id is not null and b.transfer_pair_id <> a.id) then
    raise exception 'wb_set_transfer_pair: one of the rows is already paired with another; unpair it first' using errcode = '23505';
  end if;

  update public.wb_transactions
  set transfer_pair_id = case when id = a.id then b.id else a.id end,
      kind = 'transfer', kind_source = p_source, transfer_candidate = false
  where id in (a.id, b.id);
  return jsonb_build_object('paired', jsonb_build_array(a.id, b.id),
                            'amounts_differ', a.amount <> -b.amount);
end;
$$;


ALTER FUNCTION "public"."wb_set_transfer_pair"("p_id" "uuid", "p_pair_with" "uuid", "p_source" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_set_transfer_pair"("p_id" "uuid", "p_pair_with" "uuid", "p_source" "text") IS 'Warren Buffet: pair two transactions as a transfer (different accounts, opposite signs), or with p_pair_with null unpair one and its partner. Both rows get kind_source claude or manual, so processing never re-pairs or unpairs them.';



CREATE OR REPLACE FUNCTION "public"."wb_split_tags_fill"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  select g.id, g.exclusive into new.group_id, new.group_exclusive
  from public.wb_tags t
  join public.wb_tag_groups g on g.id = t.group_id
  where t.id = new.tag_id;
  if not found then
    raise exception 'wb_split_tags: tag % not found', new.tag_id using errcode = '23503';
  end if;
  select s.user_id, s.context_id into new.user_id, new.context_id
  from public.wb_splits s
  where s.id = new.split_id;
  if not found then
    raise exception 'wb_split_tags: split % not found', new.split_id using errcode = '23503';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_split_tags_fill"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_splits_check_sum"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ids    uuid[] := '{}';
  v_tid    uuid;
  v_amount numeric;
  v_sum    numeric;
  v_n      int;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || new.transaction_id;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || old.transaction_id;
  end if;
  for v_tid in select distinct x from unnest(v_ids) x
  loop
    select amount into v_amount from public.wb_transactions where id = v_tid;
    continue when not found;
    select count(*), coalesce(sum(amount), 0) into v_n, v_sum
    from public.wb_splits where transaction_id = v_tid;
    if v_n = 0 or v_sum <> v_amount then
      raise exception 'wb_splits: the % split(s) of transaction % sum to %, not its amount %',
        v_n, v_tid, v_sum, v_amount using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."wb_splits_check_sum"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_splits_copy_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  select t.user_id, t.context_id into new.user_id, new.context_id
  from public.wb_transactions t
  where t.id = new.transaction_id;
  if not found then
    raise exception 'wb_splits: transaction % not found', new.transaction_id using errcode = '23503';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_splits_copy_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_splits_fill_project_source"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.project_id is not null and new.project_source is null then
    new.project_source := 'manual';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_splits_fill_project_source"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_subscription_occurrences"("p_from" "date", "p_to" "date", "p_today" "date" DEFAULT NULL::"date") RETURNS TABLE("subscription_id" "uuid", "name" "text", "occurrence_on" "date", "amount" numeric, "overdue_charge" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with t as (select coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date) as d),
  subs as (
    select s.id, s.name, s.next_expected_on, s.interval_count, s.interval_unit,
           -public.wb_subscription_price_on(s.id, t.d) as amount, t.d as today
    from public.wb_subscriptions s
    cross join t
    where s.status = 'active'
      and s.interval_count is not null
      and s.next_expected_on is not null
      -- A prepaid term that does not renew expects no charge.
      and not (s.term_end_date is not null and s.auto_renew is false)
  )
  -- A charge already due and not yet seen counts once, on today (A24).
  select s.id, s.name, s.today, s.amount, true
  from subs s
  where s.next_expected_on < s.today and s.today between p_from and p_to and s.amount is not null
  union all
  select s.id, s.name, o.d, s.amount, false
  from subs s
  cross join lateral (
    select (case when s.interval_unit = 'month'
                 then s.next_expected_on + make_interval(months => k * s.interval_count)
                 else s.next_expected_on + make_interval(days => 7 * k * s.interval_count) end)::date as d
    from generate_series(0, greatest(0, ceil((p_to - s.next_expected_on)::numeric
           / (case when s.interval_unit = 'month' then 28 else 7 end * s.interval_count))::int)) k
  ) o
  where s.amount is not null
    and o.d >= s.today
    and o.d between p_from and p_to;
$$;


ALTER FUNCTION "public"."wb_subscription_occurrences"("p_from" "date", "p_to" "date", "p_today" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_subscription_occurrences"("p_from" "date", "p_to" "date", "p_today" "date") IS 'Warren Buffet: the expected charges of active subscriptions between p_from and p_to: from next_expected_on, stepping by the billing interval, at the price on p_today (negative, money out). A charge already past its expected date and not yet seen counts once, on p_today. Watching, paused and cancelled subscriptions, ones with no interval, and prepaid terms that do not renew give none. Security invoker.';



CREATE OR REPLACE FUNCTION "public"."wb_subscription_price_on"("p_subscription_id" "uuid", "p_on" "date") RETURNS numeric
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    (select p.amount from public.wb_subscription_prices p
     where p.subscription_id = p_subscription_id and p.effective_on <= p_on
     order by p.effective_on desc limit 1),
    (select p.amount from public.wb_subscription_prices p
     where p.subscription_id = p_subscription_id
     order by p.effective_on limit 1),
    (select s.expected_amount from public.wb_subscriptions s where s.id = p_subscription_id));
$$;


ALTER FUNCTION "public"."wb_subscription_price_on"("p_subscription_id" "uuid", "p_on" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_subscription_price_on"("p_subscription_id" "uuid", "p_on" "date") IS 'Warren Buffet: a subscription''s price on a date: the newest price row on or before it, else the oldest row, else expected_amount. Positive.';



CREATE OR REPLACE FUNCTION "public"."wb_subscription_prices_copy_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  select s.user_id, s.context_id into new.user_id, new.context_id
  from public.wb_subscriptions s
  where s.id = new.subscription_id;
  if not found then
    raise exception 'wb_subscription_prices: subscription % not found', new.subscription_id using errcode = '23503';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_subscription_prices_copy_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_subscriptions_fill_interval"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.cadence <> 'other' and (tg_op = 'INSERT' or new.cadence is distinct from old.cadence) then
    new.interval_count := case new.cadence when 'monthly' then 1 when 'quarterly' then 3 when 'annual' then 12 end;
    new.interval_unit  := 'month';
  elsif tg_op = 'UPDATE' and new.cadence = 'other' and old.cadence <> 'other'
        and new.interval_count is not distinct from old.interval_count
        and new.interval_unit is not distinct from old.interval_unit then
    new.interval_count := null;
    new.interval_unit  := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_subscriptions_fill_interval"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_subscriptions_fill_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.merchant_id is not null and (new.context_id is null or new.user_id is null) then
    select coalesce(new.user_id, m.user_id), coalesce(new.context_id, m.context_id)
    into new.user_id, new.context_id
    from public.wb_merchants m
    where m.id = new.merchant_id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_subscriptions_fill_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_suggest_pattern"("p_payee" "text", "p_clean" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  v_text text;
  v_word text;
  v_best text;
  v_n    int;
  stop   text[] := array[
    'the', 'and', 'inc', 'llc', 'ltd', 'corp', 'company', 'www', 'com', 'net', 'org', 'online', 'payment',
    'payments', 'purchase', 'pos', 'debit', 'credit', 'card', 'visa', 'mastercard', 'direct', 'recurring',
    'autopay', 'bill', 'pay', 'store', 'shop', 'market', 'usa', 'transfer', 'deposit', 'withdrawal', 'mktp',
    'mktpl', 'help', 'check'];
begin
  foreach v_text in array array[p_payee, p_clean]
  loop
    continue when v_text is null;
    v_best := null;
    v_n := 0;
    foreach v_word in array regexp_split_to_array(lower(v_text), '[^a-z0-9&''.-]+')
    loop
      continue when v_word = '';
      v_n := v_n + 1;
      exit when v_n > 3;
      v_word := regexp_replace(v_word, '^[^a-z0-9]+|[^a-z0-9]+$', '', 'g');
      continue when v_word !~ '^[a-z][a-z&''.-]{3,}$' or v_word = any (stop);
      if v_best is null or length(v_word) < length(v_best) then
        v_best := v_word;
      end if;
    end loop;
    if v_best is not null then
      return v_best;
    end if;
  end loop;
  return null;
end;
$_$;


ALTER FUNCTION "public"."wb_suggest_pattern"("p_payee" "text", "p_clean" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_suggest_pattern"("p_payee" "text", "p_clean" "text") IS 'Warren Buffet: the short merchant pattern "Always do this" proposes: among the first three words of the payee, else of the clean description, the shortest of at least 4 letters that is not a stop word. Null when there is none.';



CREATE OR REPLACE FUNCTION "public"."wb_suggest_planned_matches"("p_transaction_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_planned_item_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  n_removed int := 0;
  n_added   int := 0;
  v_from    date;
  v_to      date;
  v_pairs   jsonb;
begin
  -- The date range to look at: around the payments in scope, or wide for a full pass.
  select min(d) - 90, max(d) + 90 into v_from, v_to
  from (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d
        from public.wb_transactions x
        where not x.pending and x.merchant_id is not null
          and (p_transaction_ids is null or x.id = any (p_transaction_ids))) t;
  -- Nothing to pair, but suggestions in scope that no longer fit must still go.
  if v_from is null then
    v_from := current_date;
    v_to := current_date;
  end if;

  -- Every pair that qualifies now: a posted split at the item's merchant, same sign,
  -- amount within tolerance, date within the window. Drafts, cancelled and paid
  -- one-offs never qualify. Kept as jsonb so no temp table is needed.
  select coalesce(jsonb_agg(jsonb_build_object(
           'planned_item_id', pi.id,
           'occ', case when o.recurring then o.occurrence_on end,
           'split_id', s.id,
           'transaction_id', x.id,
           'applied', sign(pi.amount) * least(abs(s.amount), abs(pi.amount)),
           'ddiff', abs(c.d - o.occurrence_on),
           'adiff', abs(abs(s.amount) - abs(pi.amount)))), '[]'::jsonb)
  into v_pairs
  from public.wb_planned_occurrences(v_from, v_to, false) o
  join public.wb_planned_items pi on pi.id = o.planned_item_id
  join public.wb_transactions x on x.merchant_id = pi.merchant_id and not x.pending
  cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
  join public.wb_splits s on s.transaction_id = x.id
  where pi.merchant_id is not null
    and coalesce(pi.stage, '') <> 'paid'
    and (p_transaction_ids is null or x.id = any (p_transaction_ids))
    and (p_planned_item_ids is null or pi.id = any (p_planned_item_ids))
    and sign(s.amount) = sign(pi.amount)
    and abs(abs(s.amount) - abs(pi.amount)) <= pi.amount_tolerance
    and abs(c.d - o.occurrence_on) <= pi.match_window_days;

  -- Stale suggestions in scope go.
  delete from public.wb_planned_matches m
  where m.status = 'suggested'
    and (p_transaction_ids is null or m.transaction_id = any (p_transaction_ids))
    and (p_planned_item_ids is null or m.planned_item_id = any (p_planned_item_ids))
    and not exists (
      select 1
      from jsonb_to_recordset(v_pairs) as p(planned_item_id uuid, occ date, split_id uuid)
      where p.planned_item_id = m.planned_item_id and p.split_id = m.split_id
        and p.occ is not distinct from m.occurrence_on);
  get diagnostics n_removed = row_count;

  -- New ones: not already decided or suggested, the occurrence (within its tolerance, A45)
  -- and the split not already fully confirmed or suggested elsewhere; the closest date
  -- wins, one per occurrence and one per split.
  with cands as (
    select p.*
    from jsonb_to_recordset(v_pairs) as p(planned_item_id uuid, occ date, split_id uuid, transaction_id uuid,
                                          applied numeric, ddiff int, adiff numeric)
    join public.wb_planned_items pi on pi.id = p.planned_item_id
    join public.wb_splits s on s.id = p.split_id
    where not exists (select 1 from public.wb_planned_matches m
                      where m.planned_item_id = p.planned_item_id and m.split_id = p.split_id
                        and m.occurrence_on is not distinct from p.occ)
      and not exists (select 1 from public.wb_planned_matches m
                      where m.status = 'suggested'
                        and (m.split_id = p.split_id
                             or (m.planned_item_id = p.planned_item_id and m.occurrence_on is not distinct from p.occ)))
      and public.wb_planned_left(pi.amount, (select sum(abs(m.amount_applied)) from public.wb_planned_matches m
                    where m.status = 'confirmed' and m.planned_item_id = p.planned_item_id
                      and m.occurrence_on is not distinct from p.occ), pi.amount_tolerance) <> 0
      and coalesce((select sum(abs(m.amount_applied)) from public.wb_planned_matches m
                    where m.status = 'confirmed' and m.split_id = p.split_id), 0) < abs(s.amount)
  ),
  per_occ as (
    select o.*, row_number() over (partition by o.planned_item_id, o.occ
                                   order by o.ddiff, o.adiff, o.transaction_id, o.split_id) as rn
    from cands o
  ),
  per_split as (
    select q.*, row_number() over (partition by q.split_id
                                   order by q.ddiff, q.adiff, q.planned_item_id, q.occ) as rn2
    from per_occ q
    where q.rn = 1
  )
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  select planned_item_id, split_id, occ, applied, 'suggested', 'default'
  from per_split
  where rn2 = 1;
  get diagnostics n_added = row_count;

  return jsonb_build_object('suggested', n_added, 'removed', n_removed);
end;
$$;


ALTER FUNCTION "public"."wb_suggest_planned_matches"("p_transaction_ids" "uuid"[], "p_planned_item_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_suggest_planned_matches"("p_transaction_ids" "uuid"[], "p_planned_item_ids" "uuid"[]) IS 'Warren Buffet: suggests planned matches for the given transactions and/or planned items (null = all). A posted split qualifies for a planned item''s due date when it is at the item''s merchant, has the same sign, its amount is within the item''s amount_tolerance and its date within match_window_days. Drafts, cancelled and paid one-offs, and items with no merchant never qualify. A pair already suggested, confirmed or rejected is not suggested again; an occurrence already covered by confirmed matches (within its amount_tolerance, wb_planned_left), a split already fully confirmed, or either one already holding a suggestion, gets none; otherwise the closest date wins, one per occurrence and one per split. amount_applied is the smaller of the two amounts. Suggestions in scope that no longer qualify are deleted. Called by wb_process_transactions and after planned-item writes. Security invoker. Returns suggested and removed counts.';



CREATE OR REPLACE FUNCTION "public"."wb_tag_exclusions_copy_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  select t.user_id, t.context_id into new.user_id, new.context_id
  from public.wb_transactions t
  where t.id = new.transaction_id;
  if not found then
    raise exception 'wb_tag_exclusions: transaction % not found', new.transaction_id using errcode = '23503';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_tag_exclusions_copy_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_tag_groups_push_exclusive"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  update public.wb_split_tags set group_exclusive = new.exclusive where group_id = new.id;
  return null;
end;
$$;


ALTER FUNCTION "public"."wb_tag_groups_push_exclusive"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_tags_check"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_group uuid;
  v_cur   uuid := new.parent_id;
  v_depth int := 0;
begin
  if tg_op = 'UPDATE' then
    if new.group_id is distinct from old.group_id then
      if exists (select 1 from public.wb_split_tags where tag_id = old.id) then
        raise exception 'wb_tags: tag % is in use and cannot move to another group', old.id using errcode = '23514';
      end if;
      if exists (select 1 from public.wb_tags where parent_id = old.id) then
        raise exception 'wb_tags: tag % has children and cannot move to another group', old.id using errcode = '23514';
      end if;
    end if;
  end if;
  if new.parent_id is not null then
    select group_id into v_group from public.wb_tags where id = new.parent_id;
    if v_group is distinct from new.group_id then
      raise exception 'wb_tags: parent must be in the same group' using errcode = '23514';
    end if;
    while v_cur is not null loop
      if v_cur = new.id then
        raise exception 'wb_tags: parent_id would make a cycle' using errcode = '23514';
      end if;
      v_depth := v_depth + 1;
      if v_depth > 50 then
        raise exception 'wb_tags: tag tree deeper than 50' using errcode = '23514';
      end if;
      select parent_id into v_cur from public.wb_tags where id = v_cur;
    end loop;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_tags_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."wb_touch_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_touch_updated_at"() IS 'Warren Buffet: stamps updated_at on wb_accounts and wb_balance_snapshots.';



CREATE OR REPLACE FUNCTION "public"."wb_transactions_amount_follow"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if (select count(*) from public.wb_splits where transaction_id = new.id) = 1 then
    update public.wb_splits set amount = new.amount where transaction_id = new.id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."wb_transactions_amount_follow"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_transactions_default_split"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  insert into public.wb_splits (transaction_id, amount, position, user_id, context_id)
  values (new.id, new.amount, 0, new.user_id, new.context_id);
  return null;
end;
$$;


ALTER FUNCTION "public"."wb_transactions_default_split"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_transfer_match"("p_a_account" "uuid", "p_a_amount" numeric, "p_a_date" "date", "p_b_account" "uuid", "p_b_amount" numeric, "p_b_date" "date") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    p_a_account <> p_b_account
    and p_a_amount <> 0
    and p_a_amount = -p_b_amount
    and abs(p_a_date - p_b_date) <= 5,
    false);
$$;


ALTER FUNCTION "public"."wb_transfer_match"("p_a_account" "uuid", "p_a_amount" numeric, "p_a_date" "date", "p_b_account" "uuid", "p_b_amount" numeric, "p_b_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wb_unconfirm_planned_match"("p_match_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  m      record;
  pi     record;
  v_paid numeric;
begin
  select * into m from public.wb_planned_matches where id = p_match_id for update;
  if not found then
    raise exception 'wb_unconfirm_planned_match: no match % that you can see', p_match_id using errcode = '23503';
  end if;
  if m.status <> 'confirmed' then
    raise exception 'wb_unconfirm_planned_match: this match is %, not confirmed', m.status using errcode = '22023';
  end if;
  update public.wb_planned_matches set status = 'rejected', decided_at = now() where id = p_match_id;

  select * into pi from public.wb_planned_items where id = m.planned_item_id;
  select coalesce(sum(abs(x.amount_applied)), 0) into v_paid
  from public.wb_planned_matches x
  where x.planned_item_id = pi.id and x.status = 'confirmed';

  -- The stage is never changed here (A20); the app asks whether to set it back.
  return jsonb_build_object(
    'status', 'rejected',
    'planned_item_id', pi.id,
    'stage', pi.stage,
    'confirmed_total', sign(pi.amount) * v_paid,
    'paid_not_covered', pi.interval_count is null and pi.stage = 'paid'
                        and public.wb_planned_left(pi.amount, v_paid, pi.amount_tolerance) <> 0);
end;
$$;


ALTER FUNCTION "public"."wb_unconfirm_planned_match"("p_match_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wb_unconfirm_planned_match"("p_match_id" "uuid") IS 'Warren Buffet: remove a confirmed planned match. The match becomes rejected, so the same pair is never suggested again. The planned item''s stage is never changed (A20); paid_not_covered is true when a paid one-off is no longer covered (more than its amount_tolerance left, A45), so the app can ask whether to set it back to invoiced. Returns status, planned_item_id, stage, confirmed_total (signed) and paid_not_covered. Security invoker.';



CREATE TABLE IF NOT EXISTS "platform"."audit_log" (
    "id" bigint NOT NULL,
    "user_id" "text",
    "table_name" "text" NOT NULL,
    "record_id" "text",
    "op" "text" NOT NULL,
    "old_row" "jsonb",
    "new_row" "jsonb",
    "actor" "text" DEFAULT 'ui'::"text" NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "platform"."audit_log" OWNER TO "postgres";


COMMENT ON TABLE "platform"."audit_log" IS 'Append-only change log for every registered table. old_row holds the pre-change
image, which is what makes rollback possible. actor distinguishes AI writes from
UI writes — see platform.audit_row() and the app.actor GUC.';



COMMENT ON COLUMN "platform"."audit_log"."old_row" IS 'Pre-change row as jsonb. Rollback = re-apply this. Null on INSERT.';



COMMENT ON COLUMN "platform"."audit_log"."actor" IS 'Set via: select set_config(''app.actor'', ''claude'', true) at the top of each MCP
request. Because MCP tools use createUserClient(token), Postgres sees the USER,
not Claude — this column is the only thing that distinguishes them.';



CREATE SEQUENCE IF NOT EXISTS "platform"."audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "platform"."audit_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "platform"."audit_log_id_seq" OWNED BY "platform"."audit_log"."id";



CREATE TABLE IF NOT EXISTS "platform"."registry" (
    "table_name" "text" NOT NULL,
    "policy_mode" "text" DEFAULT 'owner'::"text" NOT NULL,
    "audited" boolean DEFAULT true NOT NULL,
    "exempt" boolean DEFAULT false NOT NULL,
    "contract_version" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "registered_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "platform"."registry" OWNER TO "postgres";


COMMENT ON TABLE "platform"."registry" IS 'Roster of tables registered under the platform contract. A public table absent
from this registry has not been vetted — see platform.conformance_failures.';



COMMENT ON COLUMN "platform"."registry"."policy_mode" IS 'owner = platform generated the standard user_id-scoped RLS policy.
none  = table has custom RLS (e.g. shared contexts); platform only applied grants + audit.';



COMMENT ON COLUMN "platform"."registry"."exempt" IS 'True for tables deliberately outside the contract (e.g. allowed_emails, which is
public-read by design and has no user_id). Exempt tables are excluded from failures.';



CREATE OR REPLACE VIEW "platform"."conformance" AS
 SELECT ((("n"."nspname")::"text" || '.'::"text") || ("c"."relname")::"text") AS "table_name",
    "c"."relrowsecurity" AS "rls_enabled",
    (EXISTS ( SELECT 1
           FROM "pg_trigger" "tg"
          WHERE (("tg"."tgrelid" = "c"."oid") AND ("tg"."tgname" = 'audit_trigger'::"name") AND (NOT "tg"."tgisinternal")))) AS "audited",
    "has_table_privilege"('authenticated'::"name", "c"."oid", 'SELECT'::"text") AS "granted_select",
    "has_table_privilege"('authenticated'::"name", "c"."oid", 'INSERT'::"text") AS "granted_insert",
    ( SELECT "count"(*) AS "count"
           FROM "pg_policies" "p"
          WHERE (("p"."schemaname" = "n"."nspname") AND ("p"."tablename" = "c"."relname"))) AS "policy_count",
    ("obj_description"("c"."oid", 'pg_class'::"name") IS NOT NULL) AS "documented",
    ("r"."table_name" IS NOT NULL) AS "registered",
    COALESCE("r"."exempt", false) AS "exempt",
    "r"."audited" AS "declared_audited",
    "r"."policy_mode" AS "declared_policy_mode",
    "r"."contract_version"
   FROM (("pg_class" "c"
     JOIN "pg_namespace" "n" ON (("n"."oid" = "c"."relnamespace")))
     LEFT JOIN "platform"."registry" "r" ON (("r"."table_name" = ((("n"."nspname")::"text" || '.'::"text") || ("c"."relname")::"text"))))
  WHERE (("n"."nspname" = 'public'::"name") AND ("c"."relkind" = 'r'::"char"));


ALTER VIEW "platform"."conformance" OWNER TO "postgres";


COMMENT ON VIEW "platform"."conformance" IS 'One row per public table: actual catalog state alongside the intent declared in
platform.registry. Conformance is defined as ACTUAL MATCHES DECLARED, not actual
matches a fixed ideal — a table may legitimately opt out of auditing, and the
registry is where that choice is recorded. Query platform.conformance_failures
for violations only.';



CREATE OR REPLACE VIEW "platform"."conformance_failures" AS
 SELECT "table_name",
        CASE
            WHEN (NOT "registered") THEN 'NOT REGISTERED — migration did not call platform.register_table()'::"text"
            ELSE NULL::"text"
        END AS "issue_registry",
        CASE
            WHEN (NOT "rls_enabled") THEN 'RLS DISABLED — table is wide open'::"text"
            ELSE NULL::"text"
        END AS "issue_rls",
        CASE
            WHEN ("policy_count" = 0) THEN 'NO RLS POLICIES — RLS on but nothing defined, table is unreadable'::"text"
            ELSE NULL::"text"
        END AS "issue_policy",
        CASE
            WHEN (NOT "granted_select") THEN 'MISSING GRANT — authenticated role cannot SELECT (Oct-2026 requirement)'::"text"
            ELSE NULL::"text"
        END AS "issue_grant",
        CASE
            WHEN ("registered" AND "declared_audited" AND (NOT "audited")) THEN 'AUDIT DRIFT — registered as audited but audit_trigger is missing'::"text"
            WHEN ("registered" AND (NOT "declared_audited") AND "audited") THEN 'AUDIT DRIFT — registered as NOT audited but audit_trigger exists'::"text"
            WHEN ((NOT "registered") AND (NOT "audited")) THEN 'NOT AUDITED — no audit_trigger and no registry declaration'::"text"
            ELSE NULL::"text"
        END AS "issue_audit",
        CASE
            WHEN (NOT "documented") THEN 'UNDOCUMENTED — no COMMENT ON TABLE; Claude cannot see design intent'::"text"
            ELSE NULL::"text"
        END AS "issue_docs"
   FROM "platform"."conformance"
  WHERE ((NOT "exempt") AND ((NOT "registered") OR (NOT "rls_enabled") OR ("policy_count" = 0) OR (NOT "granted_select") OR (NOT "documented") OR ("registered" AND "declared_audited" AND (NOT "audited")) OR ("registered" AND (NOT "declared_audited") AND "audited") OR ((NOT "registered") AND (NOT "audited"))));


ALTER VIEW "platform"."conformance_failures" OWNER TO "postgres";


COMMENT ON VIEW "platform"."conformance_failures" IS 'Violations of the platform contract, one row per offending table with a
human-readable reason per column. EMPTY RESULT = FULLY CONFORMANT.

Audit status is checked against the registry declaration, so a table registered
with audited => false (high-volume telemetry) is conformant while unaudited, and
would become non-conformant if a trigger appeared on it. Run after every migration
and in post-deploy CI.';



CREATE TABLE IF NOT EXISTS "platform"."mcp_call_log" (
    "id" bigint NOT NULL,
    "user_id" "text",
    "tool_name" "text" NOT NULL,
    "args_hash" "text",
    "called_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "blocked" boolean DEFAULT false NOT NULL,
    "block_reason" "text"
);


ALTER TABLE "platform"."mcp_call_log" OWNER TO "postgres";


COMMENT ON TABLE "platform"."mcp_call_log" IS 'Every MCP tool invocation. Powers the session call budget and loop detection in
platform.check_call_budget(). Pruned to 7 days by platform.prune_call_log().';



COMMENT ON COLUMN "platform"."mcp_call_log"."args_hash" IS 'md5 of the JSON-serialized, key-sorted tool arguments. Identical hash repeated in
a short window is the loop signal — an agent asking the exact same question again.';



COMMENT ON COLUMN "platform"."mcp_call_log"."blocked" IS 'True when check_call_budget refused this call. Blocked rows are EXCLUDED from the
loop repeat count (so the window self-heals) but INCLUDED in the volume budget (so
an agent that ignores the terminal message escalates instead of retrying for free).';



COMMENT ON COLUMN "platform"."mcp_call_log"."block_reason" IS 'loop_detected | budget_exceeded. Null when the call was allowed.';



CREATE SEQUENCE IF NOT EXISTS "platform"."mcp_call_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "platform"."mcp_call_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "platform"."mcp_call_log_id_seq" OWNED BY "platform"."mcp_call_log"."id";



CREATE OR REPLACE VIEW "platform"."tool_usage_recent" AS
 SELECT "tool_name",
    "count"(*) AS "calls_24h",
    "count"(*) FILTER (WHERE "blocked") AS "blocked_24h",
    "count"(*) FILTER (WHERE ("block_reason" = 'loop_detected'::"text")) AS "loops_24h",
    "count"(*) FILTER (WHERE ("block_reason" = 'budget_exceeded'::"text")) AS "budget_blocks_24h",
    "count"(DISTINCT "args_hash") FILTER (WHERE (NOT "blocked")) AS "distinct_arg_sets",
    "round"((("count"(*) FILTER (WHERE (NOT "blocked")))::numeric / (NULLIF("count"(DISTINCT "args_hash") FILTER (WHERE (NOT "blocked")), 0))::numeric), 1) AS "repeat_ratio",
    "max"("called_at") AS "last_called"
   FROM "platform"."mcp_call_log"
  WHERE ("called_at" > ("now"() - '24:00:00'::interval))
  GROUP BY "tool_name"
  ORDER BY ("count"(*)) DESC;


ALTER VIEW "platform"."tool_usage_recent" OWNER TO "postgres";


COMMENT ON VIEW "platform"."tool_usage_recent" IS 'Which tools burn the most calls, and which are tripping guardrails. A high
repeat_ratio means the same question is being asked repeatedly — that tool should
return more per call (fatter payload, bundled related data) rather than being
called more often. Nonzero loops_24h means an agent is actually getting stuck.';



CREATE TABLE IF NOT EXISTS "public"."allowed_emails" (
    "email" "text" NOT NULL,
    "added_at" bigint DEFAULT (EXTRACT(epoch FROM "now"()) * (1000)::numeric)
);


ALTER TABLE "public"."allowed_emails" OWNER TO "postgres";


COMMENT ON TABLE "public"."allowed_emails" IS 'AUTH. Email allowlist gating Google OAuth signup. Deliberately public-read (the login
flow must check it pre-authentication) and has no user_id, so it is registered EXEMPT
from the platform contract. Do not add user data here.';



CREATE TABLE IF NOT EXISTS "public"."apps" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "icon" "text" NOT NULL,
    "path" "text",
    "button_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "apps_id_slug" CHECK (("id" ~ '^[a-z][a-z0-9_]*$'::"text")),
    CONSTRAINT "apps_screen_pair" CHECK ((("path" IS NULL) = ("button_name" IS NULL)))
);


ALTER TABLE "public"."apps" OWNER TO "postgres";


COMMENT ON TABLE "public"."apps" IS 'ALFRED. The apps Alfred is made of: one row per app, whether or not it has a screen. Shared reference data with no user_id: every signed-in user reads it, and only migrations write it. Referenced by contexts.app_id and inbox.source_app.';



COMMENT ON COLUMN "public"."apps"."id" IS 'Text slug, e.g. warren_buffet. Matches platform_runs.app and the app named in inbox.source_metadata->>''app''. Tools take this value.';



COMMENT ON COLUMN "public"."apps"."name" IS 'Display name of the app.';



COMMENT ON COLUMN "public"."apps"."description" IS 'One plain line saying what belongs to this app. Enrichment reads it to choose inbox.source_app, the way context descriptions choose a context.';



COMMENT ON COLUMN "public"."apps"."icon" IS 'lucide-react icon name, e.g. Wallet.';



COMMENT ON COLUMN "public"."apps"."path" IS 'Route of the app''s screen in the Alfred web app, e.g. /money. Null when the app has no screen.';



COMMENT ON COLUMN "public"."apps"."button_name" IS 'Label of the app''s nav button. Null when the app has no screen. Nav buttons do not read this yet (Restructure Phase 3).';



COMMENT ON COLUMN "public"."apps"."created_at" IS 'Row creation.';



COMMENT ON COLUMN "public"."apps"."updated_at" IS 'Last change. Stamped by the apps_touch_updated_at trigger.';



CREATE TABLE IF NOT EXISTS "public"."clips" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "source" "text" NOT NULL,
    "url" "text",
    "title" "text",
    "page_text" "text" NOT NULL,
    "text_truncated" boolean DEFAULT false NOT NULL,
    "links" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "slice_paths" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "slice_count" integer GENERATED ALWAYS AS ("cardinality"("slice_paths")) STORED,
    "screenshot_truncated" boolean DEFAULT false NOT NULL,
    "page_width" integer,
    "page_height" integer,
    "inbox_id" "text",
    "captured_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "links_truncated" boolean DEFAULT false NOT NULL,
    CONSTRAINT "clips_cli_has_no_slices" CHECK ((("source" <> 'cli'::"text") OR ("cardinality"("slice_paths") = 0))),
    CONSTRAINT "clips_slice_paths_max_24" CHECK (("cardinality"("slice_paths") <= 24)),
    CONSTRAINT "clips_source_check" CHECK (("source" = ANY (ARRAY['clipboard'::"text", 'cli'::"text"])))
);


ALTER TABLE "public"."clips" OWNER TO "postgres";


COMMENT ON TABLE "public"."clips" IS 'ALFRED CLIPBOARD. One row per captured web page or pushed CLI report. Holds the heavy content -- full page text, every link, and the storage paths of the browser-sliced screenshot -- so the paired inbox row can stay a lightweight pointer. The app loads every inbox row in full on each refresh, which is why this split exists. Temporary working space, not a permanent record.';



COMMENT ON COLUMN "public"."clips"."source" IS 'clipboard = captured by the Chrome extension. cli = a report pushed by the Claude CLI via scripts/clip.mjs. Enforced by clips_source_check.';



COMMENT ON COLUMN "public"."clips"."url" IS 'The page address. Null for cli clips, which have no page.';



COMMENT ON COLUMN "public"."clips"."title" IS 'Page title, or the title given to a CLI report.';



COMMENT ON COLUMN "public"."clips"."page_text" IS 'The whole page''s text (document.body.innerText), or the CLI report body. NO main-content extraction -- a clip may hold several distinct items, for example several job cards, and Claude sorts that out in conversation (spec decision 1). Truncated to 1 MB by the capture function, which then sets text_truncated.';



COMMENT ON COLUMN "public"."clips"."text_truncated" IS 'True when page_text was cut at the 1 MB cap. Tells Claude the text it is reading is incomplete.';



COMMENT ON COLUMN "public"."clips"."links" IS 'Every <a href> on the page as [{"text": ..., "href": ...}], absolute, de-duplicated, capped at 1,000 by the capture function. This is how Claude can point at OTHER listings on a clipped job board without a second clip.';



COMMENT ON COLUMN "public"."clips"."slice_paths" IS 'Storage paths inside the clipboard bucket, IN PAGE ORDER, top to bottom: {user_id}/{clip_id}/slice-01.jpg and so on. Empty for cli clips and for a text-only clip whose screenshot failed. Written only after every slice is confirmed in storage, so a row never points at a missing file (spec decision 7).';



COMMENT ON COLUMN "public"."clips"."slice_count" IS 'Generated from cardinality(slice_paths). 0 means no screenshot.';



COMMENT ON COLUMN "public"."clips"."screenshot_truncated" IS 'True when the page was taller than 24 slices covered. The bottom of the page is not in storage at all.';



COMMENT ON COLUMN "public"."clips"."page_width" IS 'Width in pixels of the ORIGINAL capture, before the extension scaled it to 1280. Null for cli clips.';



COMMENT ON COLUMN "public"."clips"."page_height" IS 'Height in pixels of the ORIGINAL capture. Null for cli clips.';



COMMENT ON COLUMN "public"."clips"."inbox_id" IS 'The paired public.inbox row. NO FOREIGN KEY ON PURPOSE: human triage in the app hard-deletes inbox rows, so a dangling value here is a normal state (the clip outlived its pointer), not corruption.';



COMMENT ON COLUMN "public"."clips"."captured_at" IS 'When the extension or the CLI captured this, as reported by the client. created_at is when the server wrote the row; the two differ by the upload.';



COMMENT ON COLUMN "public"."clips"."links_truncated" IS 'True when the page had more than 1,000 links and the excess was dropped by the capture function. The stored `links` array is then the FIRST 1,000, which are the ones nearest the top of the page. Set from the links_dropped figure clip-capture already computes; de-duplication is NOT truncation, so three links with two distinct addresses leave this false. Reads alongside text_truncated (the page text was cut at 1 MB) and screenshot_truncated (the screenshot does not show the whole page) -- three independent facts about three different parts of the same clip. If "Claude missed a listing on a huge job board" is ever reported, this is the first column to look at.';



CREATE TABLE IF NOT EXISTS "public"."collection_item_removals" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "collection_id" "text" NOT NULL,
    "item_id" "text" NOT NULL,
    "item_name" "text",
    "quantity" "text",
    "position" integer,
    "reason" "text" DEFAULT 'manual'::"text" NOT NULL,
    "removed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "removed_by" "uuid",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "collection_item_removals_reason_check" CHECK (("reason" = ANY (ARRAY['manual'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."collection_item_removals" OWNER TO "postgres";


COMMENT ON TABLE "public"."collection_item_removals" IS 'App: Alfred. An append-only record of items removed from a collection. Feeds the "recently removed" panel so an accidental removal can be spotted and re-added. Snapshot semantics: it stores what the member looked like at removal time rather than pointing at live data.';



COMMENT ON COLUMN "public"."collection_item_removals"."id" IS 'Primary key.';



COMMENT ON COLUMN "public"."collection_item_removals"."collection_id" IS 'The collection the item was removed from.';



COMMENT ON COLUMN "public"."collection_item_removals"."item_id" IS 'The items.id that was removed. Used to re-add.';



COMMENT ON COLUMN "public"."collection_item_removals"."item_name" IS 'The item name captured at removal time. Stored rather than looked up live, because the item may later be deleted or may be unreadable to the person viewing the history.';



COMMENT ON COLUMN "public"."collection_item_removals"."quantity" IS 'The quantity at removal time, so re-adding restores the original amount.';



COMMENT ON COLUMN "public"."collection_item_removals"."position" IS 'The display position at removal time.';



COMMENT ON COLUMN "public"."collection_item_removals"."reason" IS 'How the removal happened. "manual" = the user pressed the X button. "completed" = the item was checked off during an execution and cleared when the execution was completed. The recently-removed panel shows manual only, so a bulk clear-out does not bury a genuine mistake.';



COMMENT ON COLUMN "public"."collection_item_removals"."removed_at" IS 'When the removal happened. Items cleared by a completed execution share a single timestamp.';



COMMENT ON COLUMN "public"."collection_item_removals"."removed_by" IS 'auth.uid() of the person who removed it. This is the actual user, unlike platform.audit_log.actor which records the channel (ui vs claude).';



CREATE TABLE IF NOT EXISTS "public"."collection_items" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "collection_id" "text" NOT NULL,
    "item_id" "text" NOT NULL,
    "quantity" "text",
    "position" integer DEFAULT 0 NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_by" "uuid",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL
);


ALTER TABLE "public"."collection_items" OWNER TO "postgres";


COMMENT ON TABLE "public"."collection_items" IS 'App: Alfred. One row per item in a collection. Replaces the items jsonb array on item_collections so that concurrent edits by different users no longer overwrite each other.';



COMMENT ON COLUMN "public"."collection_items"."id" IS 'Primary key. Text to match Alfred''s existing id convention.';



COMMENT ON COLUMN "public"."collection_items"."collection_id" IS 'The collection this membership belongs to. Cascades on collection delete.';



COMMENT ON COLUMN "public"."collection_items"."item_id" IS 'The items.id being referenced. Deliberately NOT a foreign key: an item may be readable by its owner but not by a collaborator, and a hard FK would not reflect that asymmetry.';



COMMENT ON COLUMN "public"."collection_items"."quantity" IS 'Free-text quantity as entered by the user, e.g. "2" or "a bunch". Text because the existing jsonb quantity was never numeric.';



COMMENT ON COLUMN "public"."collection_items"."position" IS 'Display order within the collection. Reorder conflicts between concurrent users are accepted and not resolved.';



COMMENT ON COLUMN "public"."collection_items"."added_at" IS 'When this item was added to the collection.';



COMMENT ON COLUMN "public"."collection_items"."added_by" IS 'auth.uid() of the person who added it. Null for rows backfilled from the old jsonb column, where the adder is unknown.';



CREATE TABLE IF NOT EXISTS "public"."contexts" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "keywords" "text",
    "shared" boolean DEFAULT false,
    "pinned" boolean DEFAULT false,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "archived" boolean DEFAULT false NOT NULL,
    "default_collection_id" "text",
    "app_id" "text"
);


ALTER TABLE "public"."contexts" OWNER TO "postgres";


COMMENT ON TABLE "public"."contexts" IS 'ALFRED. Areas of focus (GTD contexts) — the top-level organizing unit for items,
intentions, events and executions. Set shared = true to expose a context and its
children to the other user on the allowlist (partner sharing). NOTE: id is TEXT
here, not uuid — Alfred predates the SAM tables and uses text ids throughout.
user_id is uuid (migration 00b); only the primary keys and their references are
text.';



COMMENT ON COLUMN "public"."contexts"."keywords" IS 'Free-text matching hints used during inbox triage to suggest a context for a capture.';



COMMENT ON COLUMN "public"."contexts"."shared" IS 'True = visible to all authenticated users, not just the owner. This is the sharing
mechanism between Alex and partner. Referenced by the RLS policies on items,
intents, events and executions.';



COMMENT ON COLUMN "public"."contexts"."pinned" IS 'Surfaces the context at the top of the UI. Display only.';



COMMENT ON COLUMN "public"."contexts"."archived" IS 'Soft delete. Archiving is blocked unless the context is empty — it owns
   items, intentions, events and collections, and archiving with children
   live would orphan them from the UI (Memories filters on contextId being
   absent, so they would appear nowhere). Nothing cascades.';



COMMENT ON COLUMN "public"."contexts"."default_collection_id" IS 'App: the collection this context''s items are added to by default — Recipes -> Groceries. Nullable; most contexts have none. ON DELETE SET NULL so a Recycle Bin hard delete of a collection clears the pointer instead of orphaning or blocking it.';



COMMENT ON COLUMN "public"."contexts"."app_id" IS 'The app this context belongs to, or null. Set by hand on the context form. Not used to guess inbox.source_app (Restructure Phase 3 decision 3).';



CREATE TABLE IF NOT EXISTS "public"."dj_album_tracks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "album_id" "uuid" NOT NULL,
    "video_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "artist" "text",
    "duration_seconds" integer,
    "position" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dj_album_tracks" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_album_tracks" IS 'The track list of an album, from YouTube Music''s get_album. Exists so "have I heard this album" can be answered from dj_plays. 🛑 dj_tracks.album CANNOT ANSWER THAT — unreliable, mostly null (§14.9), frozen at write, and it describes where a PLAY came from rather than what an album contains. ⚠️ NO canonical_track_id COLUMN, DELIBERATELY (§14.10). Grouping is resolved at query time so a play of ANY upload of a track counts, the same way mode=cram and mode=engagement do it. A column that looks authoritative and sits empty is worse than none. ⚠️ COVERAGE IS A FRACTION, NEVER A BOOLEAN. Albums are 8-12 tracks and three of them may have been heard; "3 of 9" needs no caveat and "unheard: false" needs a paragraph (§12.12).';



COMMENT ON COLUMN "public"."dj_album_tracks"."video_id" IS 'YouTube video id. Joins to dj_tracks.video_id, and through it to dj_plays. ⚠️ A track never played may not exist in dj_tracks at all — that is a real zero, not a missing row, and coverage must LEFT JOIN rather than drop it.';



CREATE TABLE IF NOT EXISTS "public"."dj_albums" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "artist_id" "uuid",
    "title" "text" NOT NULL,
    "yt_album_id" "text",
    "release_year" smallint,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "artist" "text",
    "suggested_on" "date",
    CONSTRAINT "dj_albums_status_check" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'queued'::"text", 'listening'::"text", 'known'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."dj_albums" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_albums" IS 'DJ: albums worth tracking as whole works, which matters for jazz in a way it does not for rock. Holds no rating column — how you feel about an album is derived from the newest dj_feedback row.';



COMMENT ON COLUMN "public"."dj_albums"."artist_id" IS 'Nullable on purpose: compilations and various-artists sessions have no single leader.';



COMMENT ON COLUMN "public"."dj_albums"."tags" IS 'What KIND of thing this album is: canon, latin-jazz, hard-bop, vocal. ⚠️ AN ARRAY IS SAFE HERE AND WAS NOT SAFE FOR ARTIST TAGS, AND THE REASON IS WORTH KEEPING. §14.24 needed a table because artists had no row of their own, so the REJECTION had nowhere to live. An album has a row: the category goes here, the decision goes in `status`, and the two are independent. ⚠️ ACCEPTED COST: an array cannot record WHO called it canon or WHEN. Revisit the first time a category is disputed and its provenance matters.';



COMMENT ON COLUMN "public"."dj_albums"."status" IS 'Where this album sits in the queue — NOT how Alex feels about it, which is the newest dj_feedback row. proposed = suggested, unanswered. queued = accepted. listening = in rotation. known = heard. dismissed = ASKED AND ANSWERED NO. 🛑 `dismissed` IS THE STATE THAT MAKES THE THREAD WORK. Without it a declined album is indistinguishable from one never mentioned, so it comes back every week and the section gets skipped (§11.7). ⚠️ DISMISSED IS A QUEUE DECISION, NOT A FEELING, WHICH IS WHY IT IS HERE AND NOT IN dj_feedback. An album can legitimately be tags=[''canon''] AND dismissed: yes it is canonical, no I do not want it. Feedback cannot express that, because it records how you feel rather than where something sits.';



COMMENT ON COLUMN "public"."dj_albums"."artist" IS 'The album artist as a DISPLAY STRING, from YouTube Music''s get_album. ⚠️ NOT a foreign key and NOT an identity. `artist_id` points at dj_artists, which holds mbid-keyed CONCERT ACTS so setlist.fm can be queried — jazz musicians have no mbid there and do not belong in it (§14.23''s argument, unchanged). With artist_id null, this is the only record of who made the album. 🛑 THIS IS A THIRD ARTIST VOCABULARY, alongside dj_artists.name and dj_tracks.artist, and nothing joins the three. Accepted deliberately; do not build an identity on it (§14.1).';



COMMENT ON COLUMN "public"."dj_albums"."suggested_on" IS 'The day the Jazz thread last proposed this album. 🛑 THIS IS WHAT STOPS THE THREAD REPEATING ITSELF. The canon is knowledge the MODEL holds, not something the listening history contains — so a session can suggest Mingus Ah Um and have no idea it suggested it last week unless this row exists. dj_albums IS the memory; the model is not.';



CREATE TABLE IF NOT EXISTS "public"."dj_artist_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "artist" "text" NOT NULL,
    "tag" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "decided_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dj_artist_tags_source_ck" CHECK (("source" = ANY (ARRAY['playlist'::"text", 'manual'::"text"]))),
    CONSTRAINT "dj_artist_tags_status_ck" CHECK (("status" = ANY (ARRAY['active'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."dj_artist_tags" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_artist_tags" IS 'Hand-curated buckets over dj_tracks.artist STRINGS, for reporting. 🛑 NOT AN ARTIST IDENTITY AND DOES NOT CLOSE §14.1. `artist` is the EXACT dj_tracks.artist string and is a match key, not a display name: "Eddie Higgins Trio" and "Eddie Higgins" are separate rows if both appear in the history. ⚠️ DELIBERATELY NOT dj_artists.tags. dj_artists holds mbid-keyed concert-act IDENTITIES and nothing joins its `name` to dj_tracks.artist (see the comment in upsert_dj_artist). Overloading it would give one column two contracts. Exists because dj_jazz_activity''s artist arm could only ever reach artists already represented in a jazz playlist, so Thelonious Monk — 20 days and 81 distinct songs, the broadest repertoire in the library — was invisible to the jazz report while its own definition string named him as an example of what the arm catches. Curated rather than ruled, for the reason §14.7 gives: "prefer the longer form" fixes Eddie Higgins and breaks Red Garland.';



COMMENT ON COLUMN "public"."dj_artist_tags"."artist" IS 'EXACT dj_tracks.artist string. A match key, not a display name. Compare with get_dj_plays mode=artists output to find the spelling actually in the data.';



COMMENT ON COLUMN "public"."dj_artist_tags"."source" IS '⚠️ WHERE THE TAG CAME FROM, AND IT GOVERNS WHAT MAY BE REWRITTEN. ''playlist'' = DERIVED: the artist is on a track in a playlist whose kind matches the tag. A fact, re-derivable, safe for a machine to write without asking — this is migration 013''s artist arm, converted from a query-time join into a stored row. ''manual'' = a human judgement (or a rejection), and NOTHING may overwrite it automatically. The distinction exists so a resync of the derived rows can never touch a curated one.';



COMMENT ON COLUMN "public"."dj_artist_tags"."status" IS '''active'' = tagged. ''rejected'' = considered and declined. 🛑 BOTH MEAN DECIDED AND NEITHER IS EVER PROPOSED AGAIN. Absence is the only state that means "not yet asked". Without a rejected state, saying no to a proposed artist leaves no trace and the report proposes it again next week, forever — §11.7, a signal that fires on the normal case gets ignored. Only ''active'' rows are counted as tagged by dj_artist_activity.';



CREATE TABLE IF NOT EXISTS "public"."dj_artists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text" NOT NULL,
    "mbid" "text",
    "yt_channel_id" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "notes" "text",
    "last_explored_at" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dj_artists" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_artists" IS 'DJ: artist identity and standing notes. Deliberately holds NO stance or rating column — how you feel about an artist is derived from the newest dj_feedback row, so there is exactly one place that truth lives.';



COMMENT ON COLUMN "public"."dj_artists"."mbid" IS 'MusicBrainz identifier. setlist.fm keys its artist queries by this, so without it setlist lookups fall back to name search and can match the wrong band.';



COMMENT ON COLUMN "public"."dj_artists"."tags" IS 'Free descriptors used for discovery: era (90s, 2000s), genre (alt-rock, hard-bop), and anything else worth filtering on. text[] per platform standard — filter with overlaps().';



COMMENT ON COLUMN "public"."dj_artists"."last_explored_at" IS 'When a discovery pass last went deep on this artist. Stops the same handful of names being re-mined every week while others are never reached.';



CREATE TABLE IF NOT EXISTS "public"."dj_concerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "venue_id" "uuid",
    "tour_name" "text",
    "starts_on" "date",
    "ends_on" "date",
    "status" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_on" "date",
    CONSTRAINT "dj_concerts_date_range" CHECK ((("ends_on" IS NULL) OR ("ends_on" >= "starts_on"))),
    CONSTRAINT "dj_concerts_status_check" CHECK (("status" = ANY (ARRAY['screening'::"text", 'interested'::"text", 'committed'::"text", 'attended'::"text", 'missed'::"text", 'rejected'::"text"]))),
    CONSTRAINT "dj_concerts_undated_status" CHECK ((("starts_on" IS NOT NULL) OR ("status" <> ALL (ARRAY['interested'::"text", 'committed'::"text"]))))
);


ALTER TABLE "public"."dj_concerts" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_concerts" IS 'DJ: one row per show or residency, covering the whole pipeline from screening through to what happened. Not a separate upcoming and history table — status carries that.';



COMMENT ON COLUMN "public"."dj_concerts"."artist_id" IS 'on delete restrict, not cascade: attendance history is the record you least want a stray artist cleanup to quietly erase.';



COMMENT ON COLUMN "public"."dj_concerts"."starts_on" IS 'First (or only) night. NULL means NO DATE IS RECORDED, which is legitimate in exactly two shapes: (a) HISTORY - a show that happened, or was passed on, whose date is lost (attended / missed / rejected); (b) WATCHLIST - an undated screening row, meaning an act worth seeing whenever they tour, which the planned Vegas scanner fills in once a show appears. NULL is NOT "a date we will know shortly" for interested or committed: both imply a SPECIFIC show, and dj_concerts_undated_status forbids them without a date. ⚠️ Undated rows are INERT for date filters by construction - NULL < today and NULL >= today are both NULL, so such a row falls out of BOTH the past and upcoming halves of the weekly job rather than landing wrongly in one. That guarantee survives only while queries compare this column DIRECTLY; coalescing it to a sentinel date would sweep the watchlist rows into the past.';



COMMENT ON COLUMN "public"."dj_concerts"."ends_on" IS 'Null means a single night. Filled means a residency and the run is starts_on..ends_on.';



COMMENT ON COLUMN "public"."dj_concerts"."status" IS 'screening = deciding whether it is worth going. WITH a date that is a specific show; WITHOUT one it is a standing watchlist entry - an act worth considering whenever they tour. Same question, different specificity, which is why it is not a separate status. interested = want to, not committed. committed = going. attended = went. missed = did not go BUT still want to see them. rejected = not for me. The lingering want in missed is a fact about the ARTIST, so it is recorded as artist feedback; this column only records what happened that night. ⚠️ interested and committed both imply a SPECIFIC show and are therefore REJECTED without starts_on - see dj_concerts_undated_status. screening, attended, missed and rejected may all be undated.';



COMMENT ON COLUMN "public"."dj_concerts"."reviewed_on" IS 'The day an UNDATED SCREENING row was last confirmed as "still interested". ⚠️ NULL MEANS NEVER ASKED, and such a row surfaces immediately — it is not the same as "recently confirmed". get_dj_concerts mode=undecided hides a row for a period after this date (default 90 days, the same window §12.9 uses for listening). Oasis and Black Eyed Peas were asked about in two consecutive weekly reviews and answered the same way both times; a question that fires on the normal case gets skipped exactly like a flag that does (§11.7). 🛑 THIS IS NOT A THRESHOLD ON INTEREST. §14.17 records that filtering mode=undecided on went_quiet is what made Oasis invisible. This filters on whether the QUESTION HAS BEEN ANSWERED — a record of a conversation, not a guess about how much someone cares. ⚠️ Only meaningful for undated screening rows. A dated show is governed by its date.';



CREATE TABLE IF NOT EXISTS "public"."dj_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "artist_id" "uuid",
    "concert_id" "uuid",
    "album_id" "uuid",
    "track_id" "uuid",
    "venue_id" "uuid",
    "sentiment" "text",
    "note" "text",
    "occurred_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "source" "text" DEFAULT 'chat'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dj_feedback_has_content" CHECK ((("sentiment" IS NOT NULL) OR ("note" IS NOT NULL))),
    CONSTRAINT "dj_feedback_one_subject" CHECK (((((((("artist_id" IS NOT NULL))::integer + (("concert_id" IS NOT NULL))::integer) + (("album_id" IS NOT NULL))::integer) + (("track_id" IS NOT NULL))::integer) + (("venue_id" IS NOT NULL))::integer) = 1)),
    CONSTRAINT "dj_feedback_sentiment_check" CHECK (("sentiment" = ANY (ARRAY['love'::"text", 'like'::"text", 'neutral'::"text", 'dislike'::"text", 'curious'::"text"]))),
    CONSTRAINT "dj_feedback_source_check" CHECK (("source" = ANY (ARRAY['chat'::"text", 'weekly_review'::"text", 'manual'::"text", 'import'::"text"])))
);


ALTER TABLE "public"."dj_feedback" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_feedback" IS 'DJ: append-only log of stated preference. Five nullable foreign keys with exactly one filled, rather than a generic subject_type/subject_id pair — this keeps real foreign keys and real joins. Never updated; a changed opinion is a new row.';



COMMENT ON COLUMN "public"."dj_feedback"."sentiment" IS 'curious means wanting more rather than having judged. For an artist you missed live but still want to see, that lingering want is recorded here, not on the concert row.';



CREATE TABLE IF NOT EXISTS "public"."dj_known_disagreements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "video_id" "text" NOT NULL,
    "stored_artist" "text",
    "submitted_artist" "text",
    "reason" "text" NOT NULL,
    "decided_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_by" "text" DEFAULT 'alex'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dj_known_disagreements" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_known_disagreements" IS 'Artist disagreements that have been DECIDED and must stop notifying. AUTHORITATIVE; docs/dj-known-disagreements.md is a human rendering of it and is stale if the two disagree. resolveTrackIds partitions against this table, so a decided disagreement never reaches artist_disagreements - it is reported separately as known_disagreements. A table rather than a column on dj_tracks because a decision is revisable and an identity is not, and because one reason can cover many rows without being duplicated. No tool writes it: rows are inserted by hand and reviewed, because a tool that can silence its own alarms is the wrong shape.';



COMMENT ON COLUMN "public"."dj_known_disagreements"."submitted_artist" IS 'The submitted value AT THE TIME OF THE DECISION. Part of the unique key, so a DIFFERENT submitted artist on the same video is treated as a new disagreement and still notifies. Deciding "this pair is fine" must not silence "this video now reports something else entirely".';



CREATE TABLE IF NOT EXISTS "public"."dj_playlist_tracks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "playlist_id" "uuid" NOT NULL,
    "track_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "position" integer NOT NULL,
    "yt_set_video_id" "text",
    "added_reason" "text",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dj_playlist_tracks_added_reason_check" CHECK (("added_reason" = ANY (ARRAY['new_setlist'::"text", 'neglected'::"text", 'manual'::"text", 'import'::"text"]))),
    CONSTRAINT "dj_playlist_tracks_role_check" CHECK (("role" = ANY (ARRAY['cram'::"text", 'body'::"text"])))
);


ALTER TABLE "public"."dj_playlist_tracks" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_playlist_tracks" IS 'DJ: playlist membership. A track may hold rows in BOTH zones - the same song in cram and in body is deliberate, and it is what makes "clear the cram list" a delete of the cram rows that leaves the concert order intact. Within the BODY a track may also appear MORE THAN ONCE: real playlists repeat songs, and forbidding it broke the Phase 6b import of five of them. Identity is (playlist_id, role, position) - a slot cannot be claimed twice, which is the invariant that matters. It is IMMEDIATE rather than deferrable because record_dj_playlist arbitrates ON CONFLICT against it, and PostgreSQL will not accept a deferrable constraint as an arbiter; the upsert overwrites slots in place and never moves a row, so nothing needs deferring. CRAM still forbids duplicates - see dj_playlist_tracks_cram_track_uniq.';



COMMENT ON COLUMN "public"."dj_playlist_tracks"."position" IS 'Order within the zone, not the playlist. Rendered YouTube order is every cram row by position, then every body row by position.';



COMMENT ON COLUMN "public"."dj_playlist_tracks"."yt_set_video_id" IS 'YouTube''s per-playlist identifier for this entry, required before any move or remove. A cache only — it is refreshed on each playlist read and may be stale or null.';



COMMENT ON COLUMN "public"."dj_playlist_tracks"."added_reason" IS 'Why this landed in the cram block, so the weekly review can explain itself rather than presenting an unexplained list.';



CREATE TABLE IF NOT EXISTS "public"."dj_playlists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "yt_playlist_id" "text",
    "name" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "concert_id" "uuid",
    "description" "text",
    "cram_cap" smallint DEFAULT 8 NOT NULL,
    "last_synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dj_playlists_concert_link" CHECK ((("kind" = 'concert'::"text") OR ("concert_id" IS NULL))),
    CONSTRAINT "dj_playlists_kind_check" CHECK (("kind" = ANY (ARRAY['concert'::"text", 'artist'::"text", 'jazz'::"text", 'discovery'::"text", 'utility'::"text"])))
);


ALTER TABLE "public"."dj_playlists" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_playlists" IS 'DJ: playlists this system manages. Membership lives in dj_playlist_tracks; the actual audio lives in YouTube Music. yt_playlist_id is null until the playlist has been created on the YouTube side.';



COMMENT ON COLUMN "public"."dj_playlists"."kind" IS 'concert | artist | jazz | discovery | utility. Only kind=concert has a setlist body and therefore a cram block; the rest are flat. utility means RECORDED BUT NEVER PROPOSED AGAINST - running, yoga, massage, sleep, party and soundtrack playlists that DJ measures for engagement but never suggests changes to. It exists so those do not have to be mislabelled `discovery`, which is a category DJ actually uses to find new artists and which fifteen activity playlists would have swamped. ⚠️ kind is what decides how much of DJ applies to a playlist, so choosing it is a semantic act, not a label: concert gets the weekly setlist diff and cram list, artist/jazz/discovery get metrics and occasional proposals, utility gets metrics only.';



COMMENT ON COLUMN "public"."dj_playlists"."cram_cap" IS 'Maximum songs in the cram block. Past roughly eight the cram block stops focusing attention and just becomes the playlist again.';



CREATE TABLE IF NOT EXISTS "public"."dj_plays" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "track_id" "uuid" NOT NULL,
    "played_on" "date" NOT NULL,
    "precision" "text" NOT NULL,
    "played_bucket" "text",
    "occurrence" smallint DEFAULT 1 NOT NULL,
    "source" "text" NOT NULL,
    "observed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dj_plays_precision_check" CHECK (("precision" = ANY (ARRAY['exact'::"text", 'day'::"text", 'week'::"text", 'fortnight'::"text"]))),
    CONSTRAINT "dj_plays_source_check" CHECK (("source" = ANY (ARRAY['poll'::"text", 'takeout'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."dj_plays" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_plays" IS 'DJ: append-only listening log. Always has a usable date, but that date is sometimes a resolved guess — precision says which. Nullable dates were rejected: every query would pay for a precision the use case does not need. NOTE: row count is NOT play count. The poll records at most one row per track per day regardless of how many times it was played, so familiarity is measured as DISTINCT DAYS (spec 5). Only source = ''takeout'' rows can express true repeat counts.';



COMMENT ON COLUMN "public"."dj_plays"."played_on" IS 'THE UTC DATE OF THE PLAY. Not local, not the account''s day — UTC. This is FORCED, not chosen: the poll receives only a bucket LABEL (Today/Yesterday) and never learns time-of-day, so a poll row can never be converted to a local date. Confirmed 2026-08-29, 41/41 against exact Takeout timestamps: YouTube buckets history by UTC day. Part of the dedupe key with track_id, occurrence and source. KNOWN BOUNDED DISTORTION: UTC midnight is 17:00 Pacific, mid-listening-day, so an evening session can split across two UTC days or two afternoons collapse into one — bounded at plus or minus one day, which roughly cancels for the relative measure in spec 5.';



COMMENT ON COLUMN "public"."dj_plays"."precision" IS 'exact = real timestamp (Takeout). day = YouTube said Today/Yesterday. week = said This week, resolved to poll date minus 2. fortnight = said Last week, minus 9. Never treat week or fortnight rows as a real date — aggregate them, do not plot them.';



COMMENT ON COLUMN "public"."dj_plays"."played_bucket" IS 'The label YouTube returned, verbatim; NULL for sources with real timestamps. DIAGNOSTIC ONLY — deliberately NOT part of the dedupe key. It cannot be. This column previously carried the claim that a play drifting from This week to Last week "keeps its original bucket and does not re-insert": the STORED row keeps its bucket, but the INCOMING row carries the NEW label, forms a different key, and inserts. Keyed on the label, one play minted four rows as it aged; meanwhile two different plays days apart both arriving as "Today" collided and the second was silently dropped. Broken in both directions at once. See spec 4.3.';



COMMENT ON COLUMN "public"."dj_plays"."occurrence" IS 'Nth play of this track on this DAY (not within a bucket). Lets a per-play source record repeat listens as distinct rows while the unique constraint still absorbs a re-poll. NOTHING IN THE DAILY POLL WILL EVER PRODUCE occurrence > 1 — not rarely, never: YouTube''s history feed carries ONE ENTRY PER TRACK PER BUCKET, positioned at that track''s most recent play. Measured in phase 2b — three plays of one song produced one entry, and twenty would too. This column exists to serve the Takeout import (spec 7 phase 8), which has real per-play rows and is consequently the only source from which true play counts can ever be obtained.';



CREATE TABLE IF NOT EXISTS "public"."dj_tracks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "video_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "artist" "text",
    "album" "text",
    "duration_seconds" integer,
    "match_key" "text",
    "canonical_track_id" "uuid",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dj_tracks" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_tracks" IS 'DJ: one row per distinct YouTube video. The same song often has several video ids (album cut, single, remaster, live). Variants point at one canonical row via canonical_track_id; a null value means this row IS the canonical one. All familiarity counting groups by canonical id, never by video_id.';



COMMENT ON COLUMN "public"."dj_tracks"."album" IS 'The album this track is FROM — or NULL, which is the common case. NOT written by the daily poll. YouTube''s history feed reports what was listened THROUGH rather than what the track is from: playing a mix stamps the MIX name on every track in it, and it arrives carrying a real MPREb_ album browse id, so it is structurally indistinguishable from a genuine album. Measured in phase 2b — 30 of the first 32 rows said "Summer Jazz: Herbie Hancock", including tracks by Wayne Shorter, Jackie McLean and Lionel Loueke. Nulled rather than flagged because a flag would preserve a value nobody should ever read, and because dj_tracks is insert-only: any detection rule has to be right at insert time from one batch alone, and the cross-artist signal is retrospective. dj_albums must be populated from a real lookup or from Takeout, never from the history feed.';



COMMENT ON COLUMN "public"."dj_tracks"."match_key" IS 'Normalised artist|title used to propose canonical grouping on import. Written by the importer, not generated, because normalisation strips things like "(Remastered 2011)" and "- Live" that a generated column cannot express.';



CREATE TABLE IF NOT EXISTS "public"."dj_venues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text" NOT NULL,
    "city" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dj_venues" OWNER TO "postgres";


COMMENT ON TABLE "public"."dj_venues" IS 'DJ: places shows happen. Exists as its own table because venue quality is durable knowledge that outlives any single concert — seat quality, sound, whether the cheap seats are still good.';



COMMENT ON COLUMN "public"."dj_venues"."notes" IS 'Standing facts about the room itself. Reactions to a specific night belong in dj_feedback, not here.';



CREATE TABLE IF NOT EXISTS "public"."drive_mix_servings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "served_on" "date" NOT NULL,
    "position" integer NOT NULL,
    "song_id" "uuid" NOT NULL,
    "video_id" "text" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "drive_mix_servings_position_check" CHECK (("position" >= 1))
);


ALTER TABLE "public"."drive_mix_servings" OWNER TO "postgres";


COMMENT ON TABLE "public"."drive_mix_servings" IS 'DJ: what the Drive Mix playlist actually carried each day, one row per song. Written from the video_ids sent to YouTube, never re-derived from the picker, so it matches what went out. One serving per date: a second is refused by the tool. Recency does NOT read this table; it reads dj_plays.';



COMMENT ON COLUMN "public"."drive_mix_servings"."id" IS 'Surrogate key.';



COMMENT ON COLUMN "public"."drive_mix_servings"."user_id" IS 'Owner. Set explicitly when inserting from the SQL editor, where auth.uid() is null.';



COMMENT ON COLUMN "public"."drive_mix_servings"."served_on" IS 'The day the playlist was written for (UTC date, as drive_mix_pick uses).';



COMMENT ON COLUMN "public"."drive_mix_servings"."position" IS '1-based order in the playlist.';



COMMENT ON COLUMN "public"."drive_mix_servings"."song_id" IS 'The pool song. ON DELETE RESTRICT: retire a song rather than deleting it.';



COMMENT ON COLUMN "public"."drive_mix_servings"."video_id" IS 'The video_id sent to YouTube, copied so the record stands even if the pool row changes.';



COMMENT ON COLUMN "public"."drive_mix_servings"."recorded_at" IS 'When the serving was recorded.';



CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "text" NOT NULL,
    "intent_id" "text" NOT NULL,
    "time" "date" NOT NULL,
    "item_ids" "jsonb" DEFAULT '[]'::"jsonb",
    "context_id" "text",
    "archived" boolean DEFAULT false,
    "text" "text",
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "collection_id" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "source_inbox_id" "text"
);


ALTER TABLE "public"."events" OWNER TO "postgres";


COMMENT ON TABLE "public"."events" IS 'ALFRED. An intention placed on a date. Third stage of the GTD chain. An intent with no
event is a someday/maybe; an event is a commitment to a day. One intent may spawn many
events over time (recurrence).';



COMMENT ON COLUMN "public"."events"."time" IS 'DATE, not timestamp — Alfred schedules to the day, never to the minute.';



COMMENT ON COLUMN "public"."events"."item_ids" IS 'jsonb array of item ids consulted for this event.';



COMMENT ON COLUMN "public"."events"."source_inbox_id" IS 'The public.inbox row this event was created from, or null when it was not created from a capture. Set by the triage form (handleInboxSave) when a capture is triaged straight onto a date. The event''s intention carries the same value, so this is redundant for an event created alongside one — kept anyway, because an event reached from the calendar should answer "where did this come from" without a join. ON DELETE SET NULL: losing the capture must never delete the event.';



CREATE TABLE IF NOT EXISTS "public"."executions" (
    "id" "text" NOT NULL,
    "event_id" "text" NOT NULL,
    "intent_id" "text" NOT NULL,
    "context_id" "text",
    "item_ids" "jsonb" DEFAULT '[]'::"jsonb",
    "status" "text" NOT NULL,
    "outcome" "text",
    "progress" "jsonb" DEFAULT '[]'::"jsonb",
    "elements" "jsonb" DEFAULT '[]'::"jsonb",
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "collection_id" "text",
    "completed_item_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "started_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "prior_event_date" "date",
    "prior_intent_status" "text",
    CONSTRAINT "executions_prior_intent_status_check" CHECK (("prior_intent_status" = ANY (ARRAY['someday'::"text", 'active'::"text", 'background'::"text"])))
);


ALTER TABLE "public"."executions" OWNER TO "postgres";


COMMENT ON TABLE "public"."executions" IS 'ALFRED. A working session against an event — the doing, and the record of how it went.
Final stage of the GTD chain. The ACTIVE EXECUTION is the single strongest real-time
grounding signal for any Claude conversation about Alfred state: it says what the user
is doing right now.';



COMMENT ON COLUMN "public"."executions"."status" IS 'Lifecycle state of the session. Closed sessions set closed_at.';



COMMENT ON COLUMN "public"."executions"."outcome" IS 'How it went, set at close. Feeds retrospective review.';



COMMENT ON COLUMN "public"."executions"."progress" IS 'jsonb three-state step tracking (not-started / partial / complete) against the frozen elements.';



COMMENT ON COLUMN "public"."executions"."elements" IS 'FROZEN COPY of items.elements, captured at execution start. This is deliberate — editing
the source item mid-session must not change the steps of a session already in flight.';



COMMENT ON COLUMN "public"."executions"."prior_event_date" IS 'Restructure P4. The live event''s date before Start Now moved it to today; null when Start Now moved nothing. Delete Execution of an in-progress execution puts it back when the event is still on the day it was moved to and this date is today or later.';



COMMENT ON COLUMN "public"."executions"."prior_intent_status" IS 'Restructure P4. The intention''s status before Start Now un-parked it (background); null when Start Now changed no status. Delete Execution of an in-progress execution restores it.';



CREATE TABLE IF NOT EXISTS "public"."inbox" (
    "id" "text" NOT NULL,
    "archived" boolean DEFAULT false,
    "captured_text" "text" NOT NULL,
    "suggested_context_id" "text",
    "suggest_item" boolean DEFAULT false,
    "suggested_item_text" "text",
    "suggested_item_description" "text",
    "suggested_item_elements" "jsonb",
    "suggest_intent" boolean DEFAULT false,
    "suggested_intent_text" "text",
    "suggested_intent_recurrence" "text",
    "suggest_event" boolean DEFAULT false,
    "suggested_event_date" "text",
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "suggested_item_id" "text",
    "suggested_collection_id" "text",
    "source_type" "text" DEFAULT 'manual'::"text",
    "source_metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "ai_status" "text" DEFAULT 'not_started'::"text",
    "ai_confidence" numeric(3,2),
    "ai_reasoning" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "triaged_at" timestamp with time zone,
    "suggested_tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "archive_reason" "text",
    "suggested_intent_description" "text",
    "suggested_status" "text" DEFAULT 'someday'::"text" NOT NULL,
    "source_app" "text",
    "outcome" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "inbox_archive_reason_check" CHECK ((("archive_reason" IS NULL) OR ("archive_reason" = ANY (ARRAY['discarded'::"text", 'processed'::"text"])))),
    CONSTRAINT "inbox_archive_reason_needs_archived" CHECK ((("archive_reason" IS NULL) OR ("archived" IS TRUE))),
    CONSTRAINT "inbox_outcome_shape" CHECK ("public"."inbox_outcome_valid"("outcome")),
    CONSTRAINT "inbox_suggested_status_check" CHECK (("suggested_status" = ANY (ARRAY['someday'::"text", 'active'::"text"])))
);


ALTER TABLE "public"."inbox" OWNER TO "postgres";


COMMENT ON TABLE "public"."inbox" IS 'ALFRED. THE HUMAN-APPROVAL GATEWAY. Every AI-generated or externally-captured item lands
here first and is committed to the main tables only when the user triages it in the UI.
This is the original write-gating mechanism for the MCP surface.

Under platform contract v1 this is now understood as ONE gate among several — see the
three write tiers in the platform schema comment. Capture still routes through the inbox;
tier-1 appends (progress, attempts) and tier-3 inline-confirmed diffs do not.';



COMMENT ON COLUMN "public"."inbox"."suggest_item" IS 'AI proposes this become a reusable item. True for recipes, checklists, reference material.';



COMMENT ON COLUMN "public"."inbox"."suggest_intent" IS 'AI proposes this become an intention. True for action items and to-dos.';



COMMENT ON COLUMN "public"."inbox"."suggest_event" IS 'AI proposes a date. suggested_event_date must be an absolute YYYY-MM-DD, never relative.';



COMMENT ON COLUMN "public"."inbox"."source_type" IS 'How the capture arrived: manual | email (Postmark webhook) | mcp | ...';



COMMENT ON COLUMN "public"."inbox"."source_metadata" IS 'jsonb envelope from the source — e.g. Postmark sender, subject, message id.';



COMMENT ON COLUMN "public"."inbox"."ai_status" IS 'Enrichment pipeline state: not_started -> enriched (Sonnet first pass) -> re_enriched (Opus).
Drives the AI status badges in the triage UI.';



COMMENT ON COLUMN "public"."inbox"."ai_confidence" IS '0.0-1.0. Low confidence surfaces a warning in triage.';



COMMENT ON COLUMN "public"."inbox"."ai_reasoning" IS 'Why the AI made these suggestions. Shown to the user during triage so approval is informed, not blind.';



COMMENT ON COLUMN "public"."inbox"."triaged_at" IS 'Set when the human dispositions the item. Null = still pending.';



COMMENT ON COLUMN "public"."inbox"."suggested_tags" IS 'Tags the AI proposes for the item or intention this capture becomes. Native text[] as of migration 062, matching items.tags and intents.tags, which moved in 039. Normalised on write by normaliseTags -- never on load, because the triage UI dirty-checks this value with JSON.stringify and normalising on load produces phantom unsaved-changes prompts.';



COMMENT ON COLUMN "public"."inbox"."archive_reason" IS 'WHY this row was archived, or null while it is still in the inbox. ''discarded'' = binned with the trash can on the inbox screen. ''processed'' = handled: by the app''s Process (detail page or one-tap), which creates the item, intention or event and then archives, or by archive_inbox_item from Claude. Processing archives; nothing deletes inbox rows. Both reasons are reversible. Set together with archived and triaged_at, and cleared together with them on un-archive (inbox_archive_reason_needs_archived enforces the pairing). What a processed capture became is in outcome.';



COMMENT ON COLUMN "public"."inbox"."suggested_intent_description" IS 'Enrichment''s suggested Details for the intention — what the capture said beyond the intention''s name (the number to call, the reason, the constraint). Pre-fills the New Intention "Details" box on the inbox detail page and is written to intents.description when the capture is processed. Null when the enrichment suggested none, and null on every row predating migration 070. Nothing infers it from captured_text at read time. ⚠️ NOT the intention''s name — that is suggested_intent_text.';



COMMENT ON COLUMN "public"."inbox"."suggested_status" IS 'Enrichment''s suggested status for the item and/or intention this capture becomes: someday (default) or active. One value covers both. Active only for a deadline, a named date, an explicit commitment, or a health or money urgency signal.';



COMMENT ON COLUMN "public"."inbox"."source_app" IS 'Which app this capture belongs to, or null while unknown. Never guessed at capture: set at creation only when the sender knows it (create_inbox_item, scheduled tasks, or source_metadata->>''app'' via inbox_set_source_app), otherwise filled in by enrichment or the App picker on the inbox detail page, and kept by processing. Separate from source_type, which says how the capture arrived.';



COMMENT ON COLUMN "public"."inbox"."outcome" IS 'Every record this capture became: a list of {"table": "intents" | "items" | "events" | "job_applications" | ..., "id": "<id>"}. Empty until processed. Written by the app''s Process and by archive_inbox_item. The reverse link is source_inbox_id on items, intents, events and job_applications.';



CREATE TABLE IF NOT EXISTS "public"."intents" (
    "id" "text" NOT NULL,
    "text" "text" NOT NULL,
    "is_intention" boolean DEFAULT false,
    "is_item" boolean DEFAULT false,
    "archived" boolean DEFAULT false,
    "item_id" "text",
    "context_id" "text",
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "collection_id" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "recurrence_config" "jsonb",
    "target_start_date" "date",
    "end_date" "date",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source_inbox_id" "text",
    "description" "text",
    "status" "text" DEFAULT 'someday'::"text" NOT NULL,
    "status_changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_completed_at" timestamp with time zone,
    "closed_reason" "text",
    "status_written_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "intents_closed_reason_check" CHECK (("closed_reason" = ANY (ARRAY['done'::"text", 'wont_do'::"text"]))),
    CONSTRAINT "intents_status_check" CHECK (("status" = ANY (ARRAY['someday'::"text", 'active'::"text", 'background'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."intents" OWNER TO "postgres";


COMMENT ON TABLE "public"."intents" IS 'ALFRED. Intentions — things the user means to do. The second stage of the GTD chain
(capture -> inbox -> INTENT -> event -> execution -> close). PRINCIPLE "now means now":
even immediate actions traverse the full Intent -> Event -> Execution chain rather than
short-circuiting, because consistency is what makes recurrence and sharing work later.';



COMMENT ON COLUMN "public"."intents"."is_intention" IS 'True = a thing to do. Mutually meaningful with is_item.';



COMMENT ON COLUMN "public"."intents"."is_item" IS 'True = this intent is anchored to a reusable item (item_id).';



COMMENT ON COLUMN "public"."intents"."recurrence_config" IS 'PHASE 8. jsonb recurrence definition. Two paradigms, and the distinction matters:
FIXED SCHEDULE (every Tuesday — next occurrence computed from the calendar) vs
INTERVAL FROM COMPLETION (every 3 weeks after I actually do it — next occurrence computed
from the last execution close). Do not collapse these into one model. GIN indexed.';



COMMENT ON COLUMN "public"."intents"."target_start_date" IS 'Earliest date this intention should surface. Null = available now.';



COMMENT ON COLUMN "public"."intents"."end_date" IS 'Recurrence horizon. Null = open ended.';



COMMENT ON COLUMN "public"."intents"."source_inbox_id" IS 'The public.inbox row this intention was created from, or null when it was not created from a capture. Set by the triage form (handleInboxSave). Not backfillable — see the same column on public.items. ON DELETE SET NULL: losing the capture must never delete the intention.';



COMMENT ON COLUMN "public"."intents"."description" IS 'Long-form notes about the intention — the how, the why, the context that does not belong in its name. Null when none were written. LABELLED "Details" IN THE UI (the inbox detail page''s New Intention section), but named `description` to match items.description, which holds the same kind of content in the same position on the same form. One concept under two names would cost every future reader a lookup. ⚠️ NOT the intention''s name — that is `text`, which is NOT NULL and is what every list, planner row and event label renders. Keep prose out of it: `text` appears in places with no room for a paragraph. Added by migration 069 for the Phase 3 inbox detail page; every row predating it is null, and nothing infers a description from anything else.';



COMMENT ON COLUMN "public"."intents"."status" IS 'Lifecycle: someday (never live, no history) | active (live now) | background (was active, is not now, has history) | closed (done, not coming back). Default someday. Nothing returns to someday (status_guard). Moved to active by status_activate_on_event from someday or background, and by status_activate_on_execution from someday only; never from closed. Independent of archived, which is visibility only: closing does not archive. Backfilled by Restructure P1: live rows active, archived rows closed.';



COMMENT ON COLUMN "public"."intents"."status_changed_at" IS 'When status last changed. Owned by status_guard: stamped now() on a status change unless the app supplies a value no later than now() with it (Closed on; Undo). Ignored on updates that do not change status. Backfill: archived rows took updated_at, live rows the migration time.';



COMMENT ON COLUMN "public"."intents"."last_completed_at" IS 'Latest completion (closed + done execution) of this intention. Owned by executions_last_completed: client writes are ignored. Recalculated on execution insert, update and delete. Restructure P2.';



COMMENT ON COLUMN "public"."intents"."closed_reason" IS 'Restructure P4. Why it was closed: done (Completed) | wont_do (Won''t do). Null = unknown (closed before P4, or never recorded). Written by the app''s Close pop-up and by the automatic close of a one-time intention on completion; not cleared on reopen.';



COMMENT ON COLUMN "public"."intents"."status_written_at" IS 'Restructure P4. Server time of the last status change, always now(); owned by status_guard, client writes ignored. Measures the 10-minute Undo window for closed -> someday, since status_changed_at may hold an app-supplied past date.';



CREATE TABLE IF NOT EXISTS "public"."item_collections" (
    "id" "text" NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text" NOT NULL,
    "context_id" "text",
    "shared" boolean DEFAULT false,
    "is_capture_target" boolean DEFAULT false,
    "items" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "pinned" boolean DEFAULT false,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "archived" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."item_collections" OWNER TO "postgres";


COMMENT ON TABLE "public"."item_collections" IS 'ALFRED (Phase 6). Named groupings of items — grocery lists, packing lists, reading
lists. The items jsonb holds ordered member ids rather than a join table, keeping
list reads to a single row fetch.

RLS is deliberately three-policy: owner has full control; anyone may read a shared
collection; anyone may UPDATE a shared collection but WITH CHECK (shared = true)
prevents a non-owner un-sharing it. This is the shared grocery-list mechanism and
is load-bearing — do not simplify it to owner-only.

ACCEPTED RESIDUAL RISK: WITH CHECK cannot compare against the pre-update row, so a
non-owner could in principle reassign user_id on a shared collection. Closing this
would need a BEFORE UPDATE trigger. Not worth it against a two-person email
allowlist; revisit if the allowlist ever grows.';



COMMENT ON COLUMN "public"."item_collections"."is_capture_target" IS 'True = captures can be appended straight into this collection from the inbox.';



COMMENT ON COLUMN "public"."item_collections"."items" IS 'jsonb array of item ids, order-significant.';



COMMENT ON COLUMN "public"."item_collections"."archived" IS 'Soft delete. Collections are never hard-deleted: the cascade to
   collection_items and collection_item_removals would destroy removal
   history, which is the recovery mechanism for accidental removals.';



CREATE TABLE IF NOT EXISTS "public"."items" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "context_id" "text",
    "elements" "jsonb" DEFAULT '[]'::"jsonb",
    "is_capture_target" boolean DEFAULT false,
    "archived" boolean DEFAULT false,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source_inbox_id" "text",
    "status" "text" DEFAULT 'someday'::"text" NOT NULL,
    "status_changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_reference" boolean DEFAULT false NOT NULL,
    "last_completed_at" timestamp with time zone,
    "closed_reason" "text",
    "status_written_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "items_closed_reason_check" CHECK (("closed_reason" = ANY (ARRAY['done'::"text", 'wont_do'::"text"]))),
    CONSTRAINT "items_status_check" CHECK (("status" = ANY (ARRAY['someday'::"text", 'active'::"text", 'background'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."items" OWNER TO "postgres";


COMMENT ON TABLE "public"."items" IS 'ALFRED. Reusable reference material — recipes, checklists, project notes, anything
consulted more than once. Distinct from intents (things to DO). Items are composable:
an item can be referenced by many intents and events.';



COMMENT ON COLUMN "public"."items"."elements" IS 'jsonb array of typed content blocks: {type: ''header''|''bullet''|''step''|''ingredient'', text: ''...''}.
RECIPE FORMAT IS ENFORCED: "Ingredients" header -> each ingredient as type ''bullet'';
"Steps" header -> each step as type ''step''; "Notes/Suggestions" header -> tips as ''bullet''.
FROZEN AT EXECUTION START: executions copy this array into executions.elements so that
editing an item mid-session does not mutate an in-flight execution.';



COMMENT ON COLUMN "public"."items"."is_capture_target" IS 'True = this item can receive appended captures directly from the inbox (e.g. a running
grocery list) without going through full triage.';



COMMENT ON COLUMN "public"."items"."archived" IS 'Soft delete. NOTE the Alfred principle "data reflects reality": genuinely cancelled or
abandoned records are DELETED, not archived. archived is for things that are done and
kept for reference, not for things that never happened.';



COMMENT ON COLUMN "public"."items"."source_inbox_id" IS 'The public.inbox row this item was created from, or null when it was not created from a capture — which is true of almost every row and always will be. Set by the triage form (handleInboxSave). NOT BACKFILLABLE: the association was never recorded before migration 068, so every row predating it is null regardless of where it actually came from. ON DELETE SET NULL, because cascading from a scrap of captured text to the item Alex actually keeps would destroy real data to tidy up a pointer. ⚠️ ITEMS ARE SHAREABLE through a shared context, so a collaborator can read this id while being unable to read the inbox row it names. That is an opaque id and nothing more — but do not build a feature that shows it to anyone but the owner.';



COMMENT ON COLUMN "public"."items"."status" IS 'Lifecycle: someday (never live, no history) | active (live now) | background (was active, is not now, has history) | closed (done, not coming back). Default someday. Nothing returns to someday (status_guard). Moved to active from someday ONLY, by status_activate_on_event and status_activate_on_execution (the intention''s item and every id in item_ids); never from background or closed. Independent of archived, which is visibility only: closing does not archive. Backfilled by Restructure P1: live rows active, archived rows closed.';



COMMENT ON COLUMN "public"."items"."status_changed_at" IS 'When status last changed. Owned by status_guard: stamped now() on a status change unless the app supplies a value no later than now() with it (Closed on; Undo). Ignored on updates that do not change status. Backfill: archived rows took updated_at, live rows the migration time.';



COMMENT ON COLUMN "public"."items"."is_reference" IS 'Reference material rather than something to act on. NO UI YET — no chips, rendering or filtering read it. Added in Restructure P1 only so a later phase needs no second migration.';



COMMENT ON COLUMN "public"."items"."last_completed_at" IS 'Latest completion (closed + done execution) across every execution linked to this item, through executions.item_ids or through an intention whose item_id is this item. Owned by triggers (executions_last_completed, intents_last_completed): client writes are ignored. Restructure P2.';



COMMENT ON COLUMN "public"."items"."closed_reason" IS 'Restructure P4. Why it was closed: done (Completed) | wont_do (Won''t do). Null = unknown (closed before P4, or never recorded). Written by the app''s Close pop-up; not cleared on reopen.';



COMMENT ON COLUMN "public"."items"."status_written_at" IS 'Restructure P4. Server time of the last status change, always now(); owned by status_guard, client writes ignored. Measures the 10-minute Undo window for closed -> someday, since status_changed_at may hold an app-supplied past date.';



CREATE TABLE IF NOT EXISTS "public"."job_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "applied_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "org" "text" NOT NULL,
    "role" "text" NOT NULL,
    "source" "text" NOT NULL,
    "fit" "text" NOT NULL,
    "effort" "text",
    "status" "text" DEFAULT 'applied'::"text" NOT NULL,
    "deadline" "date",
    "next_action" "text",
    "next_action_due" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "posting_url" "text",
    "duplicate_of" "uuid",
    "source_inbox_id" "text",
    CONSTRAINT "job_applications_due_needs_action" CHECK ((("next_action_due" IS NULL) OR ("next_action" IS NOT NULL))),
    CONSTRAINT "job_applications_duplicate_of_not_self" CHECK (("duplicate_of" IS DISTINCT FROM "id")),
    CONSTRAINT "job_applications_effort_check" CHECK ((("effort" IS NULL) OR ("effort" = ANY (ARRAY['full'::"text", 'quick'::"text"])))),
    CONSTRAINT "job_applications_effort_when_applied" CHECK ((("effort" IS NOT NULL) OR ("status" = ANY (ARRAY['considering'::"text", 'passed'::"text"])))),
    CONSTRAINT "job_applications_fit_check" CHECK (("fit" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "job_applications_source_canonical" CHECK ((("source" <> ''::"text") AND ("source" = "lower"("btrim"("source"))))),
    CONSTRAINT "job_applications_status_check" CHECK (("status" = ANY (ARRAY['applied'::"text", 'screening'::"text", 'interview'::"text", 'rejected'::"text", 'offer'::"text", 'closed_no_response'::"text", 'withdrawn'::"text", 'considering'::"text", 'passed'::"text"])))
);


ALTER TABLE "public"."job_applications" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_applications" IS 'Job search: one row per role Alex engaged with, including roles he considered or passed on. Status carries the pipeline; there is no separate history table. Source is lowercase so grouping by source never splits "LinkedIn" from "linkedin".';



COMMENT ON COLUMN "public"."job_applications"."source" IS 'Where the role was found. Lowercase, trimmed, enforced by job_applications_source_canonical. Canonical values: nten, idealist, linkedin, 80000 hours, probably good, upwork, warm intro. New sources are allowed; reuse an existing spelling before inventing one, or the per-source counts split.';



COMMENT ON COLUMN "public"."job_applications"."effort" IS 'full = tailored CV and cover letter. quick = light-touch. NULL only when status is considering or passed (nothing was submitted).';



COMMENT ON COLUMN "public"."job_applications"."status" IS 'applied = submitted, nothing heard. screening = recruiter or phone screen. interview = past screening. rejected = they said no. offer = offer in hand. closed_no_response = gave up waiting. withdrawn = Alex pulled out after applying. considering = seen, not yet decided. passed = seen, chose not to apply. A RESPONSE is screening, interview, rejected or offer. considering and passed are excluded from per-source totals.';



COMMENT ON COLUMN "public"."job_applications"."deadline" IS 'The employer''s application deadline, if one was posted. Not Alex''s own follow-up date — that is next_action_due.';



COMMENT ON COLUMN "public"."job_applications"."next_action" IS 'What Alex owes next. NULL means nothing is owed and he is just waiting — not "unknown".';



COMMENT ON COLUMN "public"."job_applications"."next_action_due" IS 'When next_action is due. Only allowed when next_action is set (job_applications_due_needs_action).';



COMMENT ON COLUMN "public"."job_applications"."posting_url" IS 'Where the posting lives, when it is known. Null for roles logged from a warm intro, a conversation, or anywhere without a page. ⚠️ DELIBERATELY NOT UNIQUE, and job_applications_posting_url_idx is a plain index for lookup rather than a constraint. The same address can legitimately appear on more than one row: the duplicate_of mechanism EXISTS to record that Alex engaged with one posting twice, so forbidding it would forbid the thing the next column is for. It also must not block a re-application to a role that was reposted at the same address a year later.';



COMMENT ON COLUMN "public"."job_applications"."duplicate_of" IS 'Set when this row is another copy of an application already recorded, and points at the MAIN row. Null on a main row, which is almost all of them. Spec decision 13: duplicates are LINKED, NOT REMOVED -- each copy keeps its own applied_on, source, effort and notes, because "I applied to this twice, through two different job boards" is a fact worth keeping and is exactly what the per-source report needs in order to be honest. ⚠️ NO CHAINS, AND THAT RULE IS ENFORCED BY THE TOOL, NOT HERE. A duplicate must always point at a main row, never at another duplicate. A CHECK cannot express it -- it would have to read another row -- so it would need a trigger, and a trigger for an invariant only update_job_application can violate is more machinery than the rule is worth. If chains ever appear, that is a tool bug; see the guard in _shared/tools/job-applications.ts. ON DELETE SET NULL: deleting a main row leaves its duplicates standing as main rows rather than destroying them. get_job_application_sources excludes rows where this is not null, so a duplicate never inflates a source''s total (Step 10).';



COMMENT ON COLUMN "public"."job_applications"."source_inbox_id" IS 'The inbox capture this application was created from, or null. text because inbox.id is text. ON DELETE SET NULL, like source_inbox_id on items, intents and events. Set by create_job_application''s inbox_id parameter.';



CREATE TABLE IF NOT EXISTS "public"."ken_areas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "source_ref" "text",
    "priority" numeric DEFAULT 1.0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ken_areas_priority_positive" CHECK (("priority" > (0)::numeric))
);


ALTER TABLE "public"."ken_areas" OWNER TO "postgres";


COMMENT ON TABLE "public"."ken_areas" IS 'Top-level subject area. Flat by design — an area holds items directly, with
ken_items.subtopic providing the only sub-grouping. No recursion, ever.';



COMMENT ON COLUMN "public"."ken_areas"."source_ref" IS 'The Alfred item id this area was seeded from (Alfred ids are text, not uuid).
Null for an area created directly in conversation. This column is what makes the
periodic seed check idempotent: diff the Alfred Ken context against the set of
source_ref values already present and propose only what is missing. Unique per
user, so the same Alfred seed cannot be ingested twice.';



COMMENT ON COLUMN "public"."ken_areas"."priority" IS 'Heat multiplier applied over each child item''s own priority during selection.
Cooling an area dampens everything under it. Floor is structural (> 0): an area
can be cooled but never silenced, because occasional ambush across cold topics
is the point of interleaving.';



CREATE TABLE IF NOT EXISTS "public"."ken_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "item_id" "uuid" NOT NULL,
    "result" "text" NOT NULL,
    "user_answer" "text",
    "ken_assessment" "text",
    "asked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ken_attempts_result_check" CHECK (("result" = ANY (ARRAY['hit'::"text", 'partial'::"text", 'miss'::"text"])))
);


ALTER TABLE "public"."ken_attempts" OWNER TO "postgres";


COMMENT ON TABLE "public"."ken_attempts" IS 'Append-only, and read as a thin recent window only. Exists so Ken can SPOT a
pattern ("missed 3 of the last 4") before crystallizing it into a durable
misconception. Never aggregated into mastery — mastery is maintained in place on
the item. Tools query top-N per item and never the full log; the constraint is
round-trips and context budget, not storage. Written in batches by record_attempt
rather than once per question, to keep the quiz loop responsive.';



CREATE TABLE IF NOT EXISTS "public"."ken_misconceptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "item_id" "uuid",
    "related_item_id" "uuid",
    "subtopic" "text",
    "note" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ken_misconceptions_pair_distinct" CHECK ((("related_item_id" IS NULL) OR ("related_item_id" <> "item_id"))),
    CONSTRAINT "ken_misconceptions_scoped" CHECK ((("item_id" IS NOT NULL) OR ("subtopic" IS NOT NULL))),
    CONSTRAINT "ken_misconceptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."ken_misconceptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."ken_misconceptions" IS 'The curated, durable history — the part a score cannot capture. A specific,
recurring, qualitative error pattern ("often conflates timbre and tone; the
distinction is X"). Frequently a relationship BETWEEN two items, which is why
related_item_id exists: the confusion pair is the unit, not the single item.
Written sparingly and deliberately, never buffered.';



COMMENT ON COLUMN "public"."ken_misconceptions"."related_item_id" IS 'The other half of a confusion pair. on delete set null, not cascade: losing one
side of the pair must not destroy the observation, which remains true about the
surviving item.';



CREATE TABLE IF NOT EXISTS "public"."notes" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "body" "text" NOT NULL,
    "execution_id" "text",
    "applied_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notes_body_check" CHECK (("length"("btrim"("body")) > 0)),
    CONSTRAINT "notes_target_type_check" CHECK (("target_type" = ANY (ARRAY['item'::"text", 'intention'::"text"])))
);


ALTER TABLE "public"."notes" OWNER TO "postgres";


COMMENT ON TABLE "public"."notes" IS 'ALFRED. Notes on an item or an intention, optionally written during one execution. Target is target_type + target_id with no FK: a trigger on items and intents deletes a record''s notes when the record is deleted. RLS follows the target: whoever can see the item or intention can read its notes and add to it (not while it is archived); only the author edits or deletes. Replaces executions.notes (Restructure P2).';



COMMENT ON COLUMN "public"."notes"."id" IS 'Text id, like every Alfred record. Defaults to a uuid.';



COMMENT ON COLUMN "public"."notes"."user_id" IS 'The author. Only the author can edit or delete the note.';



COMMENT ON COLUMN "public"."notes"."target_type" IS 'What target_id names: ''item'' or ''intention''.';



COMMENT ON COLUMN "public"."notes"."target_id" IS 'items.id or intents.id, by target_type. No FK; notes_delete_for_target removes notes with their target. Execution notes target the execution''s intention.';



COMMENT ON COLUMN "public"."notes"."body" IS 'The note. Never empty: an emptied note is deleted, not saved blank.';



COMMENT ON COLUMN "public"."notes"."execution_id" IS 'The execution the note was written during, or null for a general note. ON DELETE CASCADE: deleting an execution deletes its notes.';



COMMENT ON COLUMN "public"."notes"."applied_at" IS 'When the note''s lesson was applied back to its item. Unused until Phase 10''s note scan.';



COMMENT ON COLUMN "public"."notes"."created_at" IS 'When the note was written. Backfilled notes take the execution''s start.';



COMMENT ON COLUMN "public"."notes"."updated_at" IS 'Last edit, stamped by notes_touch_updated_at.';



CREATE TABLE IF NOT EXISTS "public"."notification_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "execution_id" "text" NOT NULL,
    "seq" integer NOT NULL,
    "text" "text" NOT NULL,
    "offset_minutes" integer NOT NULL,
    "due_at" timestamp with time zone,
    "state" "text" DEFAULT 'waiting'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notification_steps_offset_check" CHECK (("offset_minutes" >= 0)),
    CONSTRAINT "notification_steps_seq_check" CHECK (("seq" > 0)),
    CONSTRAINT "notification_steps_state_check" CHECK (("state" = ANY (ARRAY['waiting'::"text", 'scheduled'::"text", 'sent'::"text", 'done'::"text", 'skipped'::"text", 'cancelled'::"text", 'no_subscription'::"text"])))
);


ALTER TABLE "public"."notification_steps" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_steps" IS 'Alfred: scheduled notification steps for one execution. Rows are copies generated at execution start from the execution''s snapshotted elements; editing a row never writes back to the item. Only elements carrying an offset get a row, so an item can mix a notification chain with ordinary checklist content. A chain advances when the element PRECEDING a row is completed, so an unscheduled step can still start the clock for the notification after it.';



COMMENT ON COLUMN "public"."notification_steps"."id" IS 'Surrogate key. Unlike Alfred''s legacy text ids these rows are machine-generated, so a uuid is appropriate.';



COMMENT ON COLUMN "public"."notification_steps"."user_id" IS 'Owner. Denormalised from the parent execution deliberately: it permits policy_mode owner, and lets the service-role dispatcher find the target push_subscriptions without walking back through executions.';



COMMENT ON COLUMN "public"."notification_steps"."execution_id" IS 'Parent execution. text, matching Alfred''s legacy text primary keys — not uuid. No FK: executions is a legacy table outside the platform layer, so cancel-on-close is enforced in application code.';



COMMENT ON COLUMN "public"."notification_steps"."seq" IS 'Position in the execution''s ELEMENT list, 1-based — not position among notification rows. Non-notifying elements consume a seq number without owning a row, which is what lets a plain step start the clock for the notification after it. Gaps in seq are therefore normal and expected.';



COMMENT ON COLUMN "public"."notification_steps"."text" IS 'Notification body. Copied from the element name at expansion, then independently editable for this run only.';



COMMENT ON COLUMN "public"."notification_steps"."offset_minutes" IS 'Delay BEFORE this element, measured from the completion of the PRECEDING ELEMENT — whether or not that element notifies. So a plain "saute onions" step can start the clock for a "marinate 30 minutes" notification. Ignored when nothing precedes it, in which case the step is scheduled at execution start. Zero is legitimate and must not be treated as absent.';



COMMENT ON COLUMN "public"."notification_steps"."due_at" IS 'When this step should fire. Null while state is waiting. Stamped as now() + offset_minutes when the preceding element completes. Stored as an absolute timestamp rather than an interval so explicit clock times can later populate the same column without changing the dispatcher.';



COMMENT ON COLUMN "public"."notification_steps"."state" IS 'waiting -> scheduled -> sent -> done. Also skipped (advances the chain like done), and no_subscription (the step came due but the user has no push_subscriptions row).

cancelled: set for every remaining row when an execution closes, and by "Cancel remaining" or the per-step cancel control. It is TERMINAL TO THE CHAIN — no completion, resume or dispatch moves a row out of it — but it is NOT permanent: "Schedule remaining" and the per-step restore hand the row back to the chain. Restoring recomputes the due time from NOW rather than reinstating the original due_at, which would fire immediately for a moment that has already passed. A restored row lands in waiting if the element before it is not yet completed, or scheduled at now + offset_minutes if it already is.

A manual due_at set from the execution screen puts the row in scheduled and that time WINS over the chain: completing the preceding element leaves it alone. The override is temporary, not a mode change — reverting the row hands it back, re-arming it immediately if its predecessor has already completed, so the chain link is never severed.';



COMMENT ON COLUMN "public"."notification_steps"."sent_at" IS 'Set when the dispatcher delivers. Its presence alongside state sent is what stops the row firing again on the next one-minute pass.';



COMMENT ON COLUMN "public"."notification_steps"."completed_at" IS 'When the element that owns this row was marked done. Distinct from the completion that SCHEDULED it, which belongs to the preceding element.';



COMMENT ON COLUMN "public"."notification_steps"."created_at" IS 'Row creation. All rows in a chain are created together at execution start.';



CREATE TABLE IF NOT EXISTS "public"."platform_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "app" "text" NOT NULL,
    "job" "text" NOT NULL,
    "executor" "text" NOT NULL,
    "host" "text",
    "status" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "covered_from" "date",
    "covered_to" "date",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_message" "text",
    "notified_at" timestamp with time zone,
    CONSTRAINT "platform_runs_app_check" CHECK (("app" = ANY (ARRAY['dj'::"text", 'sam'::"text", 'alfred'::"text", 'workshop'::"text", 'ken'::"text", 'warren_buffet'::"text"]))),
    CONSTRAINT "platform_runs_executor_check" CHECK (("executor" = ANY (ARRAY['workshop'::"text", 'claude'::"text", 'alfred'::"text"]))),
    CONSTRAINT "platform_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'ok'::"text", 'failed'::"text", 'auth_expired'::"text", 'partial'::"text"])))
);


ALTER TABLE "public"."platform_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_runs" IS 'Platform: one row per attempted job — scheduled or on-demand — across all apps. Generic because "did it work, when, and what broke" is the same question for every job; only the payload differs, which is what details is for.';



COMMENT ON COLUMN "public"."platform_runs"."app" IS 'Constrained rather than free text so a typo fails loudly instead of creating a row that no staleness query will ever match. Adding an app is one line in a migration.';



COMMENT ON COLUMN "public"."platform_runs"."executor" IS 'Who actually ran it. Workshop and Claude fail in different ways. Deliberately a column and not a separate table: the shape is identical, and splitting would make every staleness query a union of two tables that must be kept in step.';



COMMENT ON COLUMN "public"."platform_runs"."status" IS 'running | ok | failed | auth_expired | partial. "running" means OPEN: the row was created before the work started so a task that dies mid-flight leaves a trace. It is the only status a run can be moved OUT of — update_platform_run closes a running run and refuses to re-stamp a closed one. A run still "running" long after started_at died without reporting; nothing closes those automatically, and the daily task observes them without touching them.';



COMMENT ON COLUMN "public"."platform_runs"."finished_at" IS 'NULL while status = ''running'' — an open run has not finished. Set at the moment update_platform_run closes it. For any other status it defaults to the same instant as started_at when the caller does not supply one, because equal timestamps are the honest answer to "I do not know how long this took"; a negative interval is not.';



COMMENT ON COLUMN "public"."platform_runs"."covered_from" IS 'Period this incremental run covered. Generic to any catch-up job, not DJ-specific — compared against the previous run, it detects a lost window rather than assuming one.';



COMMENT ON COLUMN "public"."platform_runs"."error_message" IS 'REQUIRED when status is ''failed'' or ''auth_expired'' — enforced by update_platform_run, which refuses the write without it. A failure logged without its cause is indistinguishable from one that failed for no reason. Pair it with details->>''failure_kind'', which is also required, and which the notification de-dup uses to tell a still-broken thing from a newly broken one.';



COMMENT ON COLUMN "public"."platform_runs"."notified_at" IS 'When this failure was surfaced to the human. Stops one broken credential minting an identical inbox item every day until the backlog needs triaging itself.';



CREATE TABLE IF NOT EXISTS "public"."platform_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "app" "text" NOT NULL,
    "job" "text" NOT NULL,
    "executor" "text" NOT NULL,
    "cadence" "text" NOT NULL,
    "day_of_week" smallint,
    "expected_by" time without time zone DEFAULT '08:00:00'::time without time zone NOT NULL,
    "grace_hours" smallint DEFAULT 6 NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_schedules_app_check" CHECK (("app" = ANY (ARRAY['dj'::"text", 'sam'::"text", 'alfred'::"text", 'workshop'::"text", 'ken'::"text", 'warren_buffet'::"text"]))),
    CONSTRAINT "platform_schedules_cadence_check" CHECK (("cadence" = ANY (ARRAY['daily'::"text", 'weekly'::"text"]))),
    CONSTRAINT "platform_schedules_day_of_week_check" CHECK ((("day_of_week" >= 0) AND ("day_of_week" <= 6))),
    CONSTRAINT "platform_schedules_executor_check" CHECK (("executor" = ANY (ARRAY['workshop'::"text", 'claude'::"text", 'alfred'::"text"]))),
    CONSTRAINT "platform_schedules_weekly_needs_day" CHECK ((("cadence" <> 'weekly'::"text") OR ("day_of_week" IS NOT NULL)))
);


ALTER TABLE "public"."platform_schedules" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_schedules" IS 'Platform: what is SUPPOSED to run, and how often. Stores the cadence, NOT materialised expected occurrences — materialising would need a job to create those rows, and that job could fail silently, which is the exact problem this table exists to detect. Staleness is derived at read time by comparing the due occurrence against platform_runs. Absence of a row is the only signal when Claude never fires OR fires but cannot reach Supabase.';



COMMENT ON COLUMN "public"."platform_schedules"."day_of_week" IS 'Postgres dow convention: 0 = Sunday. Required for weekly, null for daily.';



COMMENT ON COLUMN "public"."platform_schedules"."grace_hours" IS 'How late before absence counts as a problem. A job due at 08:00 should not alarm at 08:01. Set higher for jobs on a machine that sleeps.';



COMMENT ON COLUMN "public"."platform_schedules"."enabled" IS 'False suspends staleness checking without deleting the definition — a paused job should not alarm, and should not have to be reconstructed from memory later.';



CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth_key" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."push_subscriptions" IS 'Alfred: Web Push subscriptions, one row per browser install.';



COMMENT ON COLUMN "public"."push_subscriptions"."endpoint" IS 'Push service URL for this install; unique, acts as the natural key.';



COMMENT ON COLUMN "public"."push_subscriptions"."p256dh" IS 'Client public key for payload encryption.';



COMMENT ON COLUMN "public"."push_subscriptions"."auth_key" IS 'Client auth secret for payload encryption.';



COMMENT ON COLUMN "public"."push_subscriptions"."user_agent" IS 'Captured at subscribe time, for identifying which device a row belongs to.';



COMMENT ON COLUMN "public"."push_subscriptions"."last_used_at" IS 'Set on each successful send; stale rows are pruning candidates.';



CREATE TABLE IF NOT EXISTS "public"."sam_goals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "title" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "status" "text" DEFAULT 'someday'::"text" NOT NULL,
    "song_id" "uuid",
    "notes" "text",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sam_goals_kind_check" CHECK (("kind" = ANY (ARRAY['song'::"text", 'technique'::"text", 'progression'::"text"]))),
    CONSTRAINT "sam_goals_status_check" CHECK (("status" = ANY (ARRAY['someday'::"text", 'active'::"text", 'done'::"text", 'dropped'::"text"]))),
    CONSTRAINT "sam_goals_title_check" CHECK (("length"("btrim"("title")) > 0))
);


ALTER TABLE "public"."sam_goals" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_goals" IS 'SAM. Longer-range learning goals: songs to learn, techniques, chord progressions. Maintained by
Claude through tools. No deletes: use status dropped.';



COMMENT ON COLUMN "public"."sam_goals"."kind" IS 'song | technique | progression';



COMMENT ON COLUMN "public"."sam_goals"."status" IS 'someday | active | done | dropped';



COMMENT ON COLUMN "public"."sam_goals"."song_id" IS 'Optional link to the song this goal is about.';



COMMENT ON COLUMN "public"."sam_goals"."completed_at" IS 'Set when status becomes done.';



CREATE TABLE IF NOT EXISTS "public"."sam_passes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "song_id" "uuid" NOT NULL,
    "snippet_id" "uuid",
    "session_id" "uuid",
    "bpm" integer,
    "completed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "playback_speed" integer,
    "effective_bpm" integer GENERATED ALWAYS AS (("round"(((("bpm" * "playback_speed"))::numeric / 100.0)))::integer) STORED,
    "hits" integer,
    "misses" integer,
    "notes_played" integer,
    "hand_mode" "text",
    "accuracy_percent" integer GENERATED ALWAYS AS (
CASE
    WHEN (COALESCE("notes_played", 0) = 0) THEN NULL::integer
    WHEN ((COALESCE("hits", 0) + COALESCE("misses", 0)) = 0) THEN NULL::integer
    ELSE ("round"((((COALESCE("hits", 0))::numeric * 100.0) / ((COALESCE("hits", 0) + COALESCE("misses", 0)))::numeric)))::integer
END) STORED,
    "plan_id" "uuid",
    "plan_item_id" "uuid",
    "warmup_rung" smallint,
    "warmup_target_percent" smallint,
    CONSTRAINT "sam_passes_warmup_pair" CHECK ((("warmup_rung" IS NULL) = ("warmup_target_percent" IS NULL))),
    CONSTRAINT "sam_passes_warmup_percent_range" CHECK ((("warmup_target_percent" IS NULL) OR (("warmup_target_percent" >= 10) AND ("warmup_target_percent" <= 100)))),
    CONSTRAINT "sam_passes_warmup_rung_range" CHECK ((("warmup_rung" IS NULL) OR (("warmup_rung" >= 1) AND ("warmup_rung" <= 6))))
);


ALTER TABLE "public"."sam_passes" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_passes" IS 'SAM. One completed playthrough of a song (snippet_id null) or a snippet (snippet_id set). Append-only. A row exists only when playback reached the final measure of the loaded range, having started at the first measure of that range, without a stop or reset in between. Looped playback writes one row per cycle.';



COMMENT ON COLUMN "public"."sam_passes"."snippet_id" IS 'NULL means the pass was the whole song. A whole-song pass never credits the snippets inside it.';



COMMENT ON COLUMN "public"."sam_passes"."session_id" IS 'The practice sitting this pass belonged to, when known. Nullable and ON DELETE SET NULL so pass history survives session cleanup.';



COMMENT ON COLUMN "public"."sam_passes"."bpm" IS 'Playback tempo in force at the instant the pass completed. If tempo changed mid-pass, this is the tempo at the finish line, not the start. NOTE: this is the score tempo and ignores playback speed — see effective_bpm for the tempo actually heard.';



COMMENT ON COLUMN "public"."sam_passes"."completed_at" IS 'Instant the final measure was crossed. Bucketing into "today" is done in the app by ptDateKey() in practiceTimeFormat.js, which buckets by Pacific time, not by browser-local midnight.';



COMMENT ON COLUMN "public"."sam_passes"."playback_speed" IS 'Playback speed percentage in force when the pass completed (100 = normal). NULL means NOT RECORDED — not 100. This column began recording when it was deployed, part-way through 2026-09-16 (~07:01 PT), so passes from that day exist both with and without a value and completed_at cannot be used to infer what a NULL should have been. The NULL is the fact: the speed was never captured and is unrecoverable. Only audio-backed songs expose a speed control, so non-audio songs record 100.';



COMMENT ON COLUMN "public"."sam_passes"."effective_bpm" IS 'Generated: round(bpm * playback_speed / 100.0). The tempo actually heard, so 60 bpm at 80% reads 48. NULL whenever playback_speed is NULL — i.e. for any pass recorded before that column was deployed part-way through 2026-09-16 — because an unknown speed gives an unknown effective tempo. Read this for "how fast was it really"; read bpm for "what did the tempo box say".';



COMMENT ON COLUMN "public"."sam_passes"."hits" IS 'Notes played correctly during this pass, from the same per-playthrough counters usePracticeSession keeps for the live display. Partials are counted separately by the app and are NOT included here, matching accuracyOf(). NULL means NOT RECORDED: this column began recording when it was deployed, part-way through 2026-09-16 (~07:28 PT), so passes from that day exist both with and without a value. Do not infer a value from completed_at.';



COMMENT ON COLUMN "public"."sam_passes"."misses" IS 'Beats scored as missed or wrong during this pass. NOTE: a miss is raised on elapsed time alone and does not require MIDI input, so a pass played with no keyboard attached records 0 hits and a full count of misses. Use notes_played to tell that apart from playing badly. NULL means NOT RECORDED — deployed part-way through 2026-09-16 (~07:28 PT), so that day has rows on both sides.';



COMMENT ON COLUMN "public"."sam_passes"."notes_played" IS 'Count of MIDI notes that actually arrived during this pass. 0 means nothing was played — a playback test, or the player was not at the keyboard — which is why accuracy_percent is NULL rather than 0 for those rows. This is the only reliable way to exclude test data from practice history. NULL means NOT RECORDED, which is a THIRD state distinct from both 0 and any positive count: deployed part-way through 2026-09-16 (~07:28 PT), so that day has rows on both sides. A filter for "played" and a filter for "not played" together do NOT cover the NULL rows.';



COMMENT ON COLUMN "public"."sam_passes"."hand_mode" IS 'Which hand the player was SCORED on for this pass: both | lh | rh. Recoverable from the snippet for snippet passes, but not for whole-song passes, where it was previously indistinguishable — and hand mode is the likeliest explanation for an accuracy jump. NULL means NOT RECORDED — deployed part-way through 2026-09-16 (~07:28 PT), so that day has rows on both sides.';



COMMENT ON COLUMN "public"."sam_passes"."accuracy_percent" IS 'Generated: round(hits * 100 / (hits + misses)), or NULL when notes_played is 0, when no beats were scored, or when hits/misses were never recorded. NULL means unmeasurable; 0 means measured and every note wrong. Do not treat NULL as 0 in any aggregate. The inputs began recording part-way through 2026-09-16 (~07:28 PT), so passes from that day exist on both sides of the change.';



COMMENT ON COLUMN "public"."sam_passes"."plan_id" IS 'The practice plan active when this pass was recorded, if any. Set even when the pass matches no
item (e.g. a snippet made on the fly). Historic rows are null. Never rewritten.';



COMMENT ON COLUMN "public"."sam_passes"."plan_item_id" IS 'The plan item matching this pass''s song and snippet when recorded, if any. Recorded for
history only: progress counting matches on song and snippet, not this column.';



COMMENT ON COLUMN "public"."sam_passes"."warmup_rung" IS '1-based index of the warm-up ladder rung this pass belonged to, or NULL for an ordinary pass. The
app writes this, and the app only reaches rung N after rungs 1..N-1 were satisfied on their own
rules — so a pass marked with rung N is the engine''s own evidence that the rungs below it were met.
sam_plan_item_progress relies on that rather than re-deriving it. A DROP back to rung 1 inside one
session is how "he pressed Warm up again" is recognised. NULL on every row written before this
column existed.';



COMMENT ON COLUMN "public"."sam_passes"."warmup_target_percent" IS 'The rung''s target_percent, denormalised onto the pass so analysis never has to resolve the ladder
that was in force — ladders can be edited, and ladder progress is never stored. Percent of the
TARGET tempo, so the rung''s BPM was greatest(20, round(target_effective_bpm * this / 100)). Because
percents are strictly ascending and the last rung is always 100, warmup_target_percent = 100
identifies a TOP-rung pass with no ladder lookup at all. NULL on an ordinary pass. A pass below the
top rung is at a deliberately slow tempo: it is not evidence about the passage at target tempo, so
it never qualifies for a plan item (it fails the tempo bar by construction) and is excluded from
measure stats by default.';



CREATE TABLE IF NOT EXISTS "public"."sam_practice_plan_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "plan_song_id" "uuid" NOT NULL,
    "song_id" "uuid" NOT NULL,
    "snippet_id" "uuid",
    "position" smallint NOT NULL,
    "is_free_play" boolean DEFAULT false NOT NULL,
    "target_bpm" integer NOT NULL,
    "target_playback_speed" integer DEFAULT 100 NOT NULL,
    "target_effective_bpm" integer GENERATED ALWAYS AS (("round"(((("target_bpm" * "target_playback_speed"))::numeric / 100.0)))::integer) STORED,
    "target_passes" smallint NOT NULL,
    "accuracy_target" smallint,
    "instruction" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "warmup_ladder" "jsonb",
    "goal_is_warmup" boolean DEFAULT false NOT NULL,
    "consecutive" boolean DEFAULT false NOT NULL,
    CONSTRAINT "sam_practice_plan_items_accuracy_check" CHECK ((("is_free_play" AND ("accuracy_target" IS NULL)) OR ((NOT "is_free_play") AND ("accuracy_target" IS NOT NULL)))),
    CONSTRAINT "sam_practice_plan_items_accuracy_target_check" CHECK ((("accuracy_target" >= 1) AND ("accuracy_target" <= 100))),
    CONSTRAINT "sam_practice_plan_items_position_check" CHECK (("position" > 0)),
    CONSTRAINT "sam_practice_plan_items_target_bpm_check" CHECK (("target_bpm" > 0)),
    CONSTRAINT "sam_practice_plan_items_target_passes_check" CHECK (("target_passes" > 0)),
    CONSTRAINT "sam_practice_plan_items_target_playback_speed_check" CHECK (("target_playback_speed" > 0)),
    CONSTRAINT "sam_practice_plan_items_warmup_goal_needs_ladder" CHECK ((NOT ("goal_is_warmup" AND ("jsonb_typeof"("warmup_ladder") = 'array'::"text") AND ("jsonb_array_length"("warmup_ladder") = 0)))),
    CONSTRAINT "sam_practice_plan_items_warmup_ladder_valid" CHECK ("public"."sam_warmup_ladder_is_valid"("warmup_ladder")),
    CONSTRAINT "sam_practice_plan_items_warmup_not_free_play" CHECK ((NOT ("goal_is_warmup" AND "is_free_play")))
);


ALTER TABLE "public"."sam_practice_plan_items" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_practice_plan_items" IS 'SAM. One checklist item in a practice plan: a song or snippet, a tempo, a pass count, and (except
free play) an accuracy target. Immutable (trigger-enforced). At most one item per exact range
(song + snippet, null snippet = whole song) per plan, so a pass never counts toward two items.
Progress is computed ONLY by sam_plan_item_progress(); never count passes separately.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."snippet_id" IS 'Null = whole song. Must belong to song_id (composite foreign key).';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."position" IS 'Checklist order across the whole plan, starting at 1.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."is_free_play" IS 'Optional Free Play: tempo target, no accuracy target, counted separately in the app.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."target_bpm" IS 'Tempo-box BPM (quarter notes per minute). For songs with audio this equals the song''s
default_bpm and the target is expressed through target_playback_speed.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."target_playback_speed" IS 'Speed percent. 100 for songs without audio.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."target_effective_bpm" IS 'Generated heard tempo. A pass qualifies when sam_passes.effective_bpm >= this. Never compare
target_bpm directly.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."target_passes" IS 'Qualifying passes needed today for the item to be crossed off.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."accuracy_target" IS 'Minimum sam_passes.accuracy_percent for a pass to qualify. Required unless free play; null for
free play (constraint-enforced).';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."instruction" IS 'VISIBLE. One short line, e.g. "Count out loud."';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."warmup_ladder" IS 'Warm-up ladder for this item, overriding the snippet''s and the song''s while the plan is active,
including after the item is complete for the day: a jsonb ARRAY of rungs, each
{target_percent, accuracy_target, target_passes, consecutive}. target_percent is a percent of this
item''s target_effective_bpm. NULL = inherit from the snippet, then the song, then
sam_default_warmup_ladder(). [] = no warm-up for this item. A rung''s null accuracy_target means
"use this item''s accuracy_target". consecutive on a rung means that rung''s target_passes must be
met as a streak WITHIN ONE SESSION. Set at creation and never changed — plan items are immutable
(sam_practice_plan_items_reject_update). Validated by sam_warmup_ladder_is_valid().';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."goal_is_warmup" IS 'True = the WARM-UP IS THE GOAL. The item is complete for the day once the resolved ladder has been
completed at least once that Pacific day (sam_plan_item_progress.ladder_completions >= 1), NOT when
target_passes qualifying passes are reached. accuracy_target is still required and IS what the top
rung falls back to when the rung''s own accuracy_target is null. target_passes is still required but
does NOT substitute: §5.1 requires target_passes on every rung, so the top rung always carries its
own. Mutually exclusive with is_free_play (constraint-enforced). Default false = today''s behaviour,
unchanged. Set at insert; the table is immutable.';



COMMENT ON COLUMN "public"."sam_practice_plan_items"."consecutive" IS 'How target_passes is counted. FALSE (the default, and today''s behaviour, unchanged) = CUMULATIVE:
any target_passes qualifying passes across the whole Pacific day, in any order, in any number of
sittings. TRUE = the target_passes qualifying passes must be a STREAK WITHIN ONE SESSION: passes in
a row, with no non-qualifying pass between them. A stop or a pause ends the session and therefore
the streak, because that is what "without stopping" means. Read
sam_plan_item_progress.longest_qualifying_streak for a consecutive item and .qualifying for a
cumulative one; the function returns both on every row and never decides between them. Set at
insert; the table is immutable.';



CREATE TABLE IF NOT EXISTS "public"."sam_practice_plan_songs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "song_id" "uuid" NOT NULL,
    "position" smallint NOT NULL,
    "song_note" "text",
    "internal_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sam_practice_plan_songs_position_check" CHECK (("position" > 0))
);


ALTER TABLE "public"."sam_practice_plan_songs" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_practice_plan_songs" IS 'SAM. One row per song in a practice plan. Immutable (trigger-enforced). Read across plans by
song_id to see a song''s plan history.';



COMMENT ON COLUMN "public"."sam_practice_plan_songs"."position" IS 'Order of the song within the plan, starting at 1.';



COMMENT ON COLUMN "public"."sam_practice_plan_songs"."song_note" IS 'VISIBLE in the player when this song is loaded. Short song goal, e.g. "Master m.16-17, then
start m.18." Measure numbers are PLAYED numbers; add the printed number in parentheses when it
helps, e.g. "m.37 (22)".';



COMMENT ON COLUMN "public"."sam_practice_plan_songs"."internal_notes" IS 'CLAUDE ONLY. E.g. "Has the fingering, needs speed. This plan addresses that."';



CREATE TABLE IF NOT EXISTS "public"."sam_practice_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "starts_on" "date" DEFAULT (("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" NOT NULL,
    "ended_at" timestamp with time zone,
    "supersedes_plan_id" "uuid",
    "day_note" "text",
    "internal_notes" "text",
    "review_instructions" "text" NOT NULL,
    "review_note" "text",
    "review_noted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sam_practice_plans_review_instructions_check" CHECK (("length"("btrim"("review_instructions")) > 0)),
    CONSTRAINT "sam_practice_plans_review_noted_check" CHECK ((("review_note" IS NULL) = ("review_noted_at" IS NULL))),
    CONSTRAINT "sam_practice_plans_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'superseded'::"text"]))),
    CONSTRAINT "sam_practice_plans_status_ended_check" CHECK ((("status" = 'active'::"text") = ("ended_at" IS NULL)))
);


ALTER TABLE "public"."sam_practice_plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_practice_plans" IS 'SAM. A practice plan written by Claude and approved by Alex in conversation. PLANS ARE NEVER
EDITED: any change creates a new plan that supersedes this one (trigger-enforced). Only status,
ended_at, review_note, review_noted_at and updated_at may change after insert. At most one active
plan per user. Create plans only through sam_create_practice_plan().';



COMMENT ON COLUMN "public"."sam_practice_plans"."status" IS 'active | superseded. A superseded plan can never be reactivated.';



COMMENT ON COLUMN "public"."sam_practice_plans"."starts_on" IS 'Pacific (America/Los_Angeles) date the plan began.';



COMMENT ON COLUMN "public"."sam_practice_plans"."ended_at" IS 'When this plan was superseded. Null while active (constraint-enforced).';



COMMENT ON COLUMN "public"."sam_practice_plans"."supersedes_plan_id" IS 'The plan this one replaced. Chains plan history.';



COMMENT ON COLUMN "public"."sam_practice_plans"."day_note" IS 'VISIBLE on the Sam tab. Short daily goal, e.g. "Improve speed on Autumn Leaves."';



COMMENT ON COLUMN "public"."sam_practice_plans"."internal_notes" IS 'CLAUDE ONLY. Reasoning behind the plan. Not shown in the app.';



COMMENT ON COLUMN "public"."sam_practice_plans"."review_instructions" IS 'CLAUDE ONLY. Plain-language criteria the daily review job applies to decide when to post a
review note, e.g. "Post once he hits 90% at 60 on m.16-17 for three days, or is under 70% there
for four days."';



COMMENT ON COLUMN "public"."sam_practice_plans"."review_note" IS 'Written once by the daily review job when review_instructions are met. Can be set from null
exactly once and never changed (trigger-enforced). Its presence means a plan conversation is due.';



COMMENT ON COLUMN "public"."sam_practice_plans"."review_noted_at" IS 'When review_note was written. Filled automatically if omitted.';



CREATE TABLE IF NOT EXISTS "public"."sam_session_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "song_id" "uuid" NOT NULL,
    "measure_id" "uuid",
    "measure_number" integer NOT NULL,
    "beat" numeric NOT NULL,
    "result" "text" NOT NULL,
    "played_notes" integer[] DEFAULT '{}'::integer[],
    "expected_notes" integer[] DEFAULT '{}'::integer[],
    "timing_delta_ms" integer,
    "loop_iteration" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "sam_session_events_result_check" CHECK (("result" = ANY (ARRAY['hit'::"text", 'miss'::"text", 'partial'::"text", 'wrong'::"text", 'extra'::"text"])))
);


ALTER TABLE "public"."sam_session_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_session_events" IS 'SAM. Per-beat practice telemetry: one row per expected beat per attempt, plus one row per
stray keystroke. HIGH VOLUME — audited => false. Never select it unaggregated across sessions;
query by session_id or by (song_id, measure_number). Full prose: docs/sam-scoring-definitions.md.

HOW SCORING WORKS (read before computing anything from this table):
* result is one of hit, miss, partial, extra. (''wrong'' is permitted by the constraint but has
  never been written — see the result column comment.)
* ACCURACY IS hits / (hits + misses). A partial is NEITHER: it sits outside the ratio and is
  reported separately. An extra is outside everything.
* A WRONG KEY STRUCK AND CORRECTED WITHIN THE WINDOW STILL SCORES AS A HIT. That is deliberate:
  the score measures whether the passage was played, and punishing a recovered slip would make
  it less useful. The stray key is recorded as its own extra row, which changes no score.
* THE MATCHING WINDOW DECIDES HOW FORGIVING SCORING IS. It is per session, in
  sam_sessions.settings.windowMs (default 300 ms): a keystroke further from its beat than that
  matches nothing. ⚠️ THE SAME PASSAGE PRACTISED AT DIFFERENT WINDOW SETTINGS IS NOT
  COMPARABLE — tightening the window lowers accuracy on identical playing, and reading that
  as getting worse is a mistake. Always report the window(s) behind any figure.
* DATES THAT LIMIT THE DATA: events from 2026-02-14; ''partial'' rows only from 2026-09-18
  onward, except where the 2026-09-18 backfill recovered earlier ones from sam_sessions.events;
  ''extra'' rows from 2026-09-18 onward only; sam_passes carries hits/misses/notes_played/
  accuracy_percent only from 2026-09-16. 285 ended sessions (tab closed mid-practice) have no
  rows here and never will. 3,295 backfilled rows have a null measure_id because their song was
  re-imported since; their measure_number is correct.';



COMMENT ON COLUMN "public"."sam_session_events"."measure_number" IS 'PLAYED measure number, repeats written out — the same numbering snippets and the score use. The printed number is sam_song_measures.source_measure, which differs wherever a bar repeats. measure_id may be null (song re-imported since) but this stays correct. On an extra row it is the measure of the nearest pending beat.';



COMMENT ON COLUMN "public"."sam_session_events"."result" IS 'What happened at this beat. hit — every expected note played within the window; a wrong key struck and corrected in time still counts as a hit, deliberately. miss — the beat was not played correctly: either nothing was struck at it, or what was struck was wrong (see played_notes). partial — some but not all of the beat''s notes; counts as NEITHER hit nor miss in the accuracy ratio and is reported separately. extra — a keystroke that was NOT AN ATTEMPT AT ANY BEAT: it matched nothing within the window. Scoreless, never counted toward attempts, hits, misses, accuracy or timing averages, with the struck pitch in played_notes and expected_notes empty. An attempt at a beat that was simply wrong is a MISS carrying its pitches, not an extra. wrong — legal but never written.';



COMMENT ON COLUMN "public"."sam_session_events"."played_notes" IS 'MIDI numbers struck for this beat. On a hit or a partial, what was played. On a MISS it is either empty (the beat passed with nothing struck at it) or the wrong keys that were struck at it — from the ordinary scoring path, where a chord with some wrong notes and a missing expected note scores a miss, or (from 2026-09-18) from an all-wrong chord that left the beat pending until the scanner timed it out. Wrong keys carried on a miss are NOT counted toward notesPlayed or any score: the miss stays a miss. On an EXTRA row this is the stray keystroke itself — the answer to "what am I hitting instead". ONE FUMBLE IS ONE ROW: an all-wrong chord no longer also writes a companion extra row (it did briefly on 2026-09-18), so a per-measure count of wrong notes cannot double-count it.';



COMMENT ON COLUMN "public"."sam_session_events"."expected_notes" IS 'MIDI numbers the beat called for, in the session''s hand mode. Empty on an extra row, which belongs to no beat.';



COMMENT ON COLUMN "public"."sam_session_events"."timing_delta_ms" IS 'Signed milliseconds between the beat''s expected onset and when it was played: POSITIVE = EARLY (rushing), NEGATIVE = LATE (dragging). This is `targetTimeMs - elapsed` from src/sam/lib/noteMatching.js. ⚠️ The comment here said the opposite until 2026-09-18. NULL for a miss (nothing was played to time). ON AN EXTRA ROW it is the offset to the nearest pending beat, and is NULL whenever that beat is further away than TWICE the session''s matching window (settings.windowMs): a keystroke that far from anything is unattached rather than early or late, and storing the number invites a meaningless average. Before 2026-09-18 extras stored it regardless, and values of several seconds exist — treat extra offsets from before that date as noise. THREE LIMITS ON ANY AVERAGE: (1) a keystroke further out than windowMs matches no beat, so extremes are invisible and the mean is pulled toward zero; (2) any fixed MIDI or audio latency rides along as a constant offset; (3) different windowMs values are not comparable. Comparisons WITHIN one session are far more reliable than absolute values.';



COMMENT ON COLUMN "public"."sam_session_events"."loop_iteration" IS 'Which repetition of a looped range, 0-indexed. A drilled bar contributes one row per beat per cycle, so any per-measure rate must say how many iterations it is averaging over, or a heavily looped bar silently dominates. It resets when a mid-play setting change restarts the scroll, so it counts cycles rather than identifying them.';



CREATE TABLE IF NOT EXISTS "public"."sam_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "song_id" "uuid" NOT NULL,
    "snippet_id" "uuid",
    "started_at" timestamp with time zone DEFAULT "now"(),
    "ended_at" timestamp with time zone,
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "summary" "jsonb" DEFAULT '{}'::"jsonb",
    "events" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "plan_id" "uuid",
    "plan_item_id" "uuid"
);


ALTER TABLE "public"."sam_sessions" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_sessions" IS 'SAM. One practice sitting against a song or snippet. summary holds the rolled-up result;
per-note detail lives in sam_session_events.';



COMMENT ON COLUMN "public"."sam_sessions"."ended_at" IS 'End of the sitting. Practice time is derived as ended_at - started_at; there is
no stored duration column. NULL means the session was abandoned without a clean
end (tab closed mid-practice) — such rows must contribute zero to time totals,
not be treated as zero-length. If engaged-time (excluding idle) is ever needed,
add a separately named column such as active_seconds — do not overload this.';



COMMENT ON COLUMN "public"."sam_sessions"."settings" IS 'jsonb snapshot of bpm / timing window in force for this session.';



COMMENT ON COLUMN "public"."sam_sessions"."summary" IS 'jsonb aggregate — accuracy, note counts, problem measures. Read this instead of aggregating events.';



COMMENT ON COLUMN "public"."sam_sessions"."events" IS 'LEGACY inline event array. Superseded by the sam_session_events table. Do not write new data here.';



COMMENT ON COLUMN "public"."sam_sessions"."plan_id" IS 'The practice plan active when this session started, if any. Historic rows are null.';



COMMENT ON COLUMN "public"."sam_sessions"."plan_item_id" IS 'The plan item matching this session''s song and snippet when it started, if any.';



CREATE TABLE IF NOT EXISTS "public"."sam_snippets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "song_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "start_measure" integer NOT NULL,
    "end_measure" integer NOT NULL,
    "rest_measures" integer DEFAULT 0,
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "archived" boolean DEFAULT false NOT NULL,
    "warmup_ladder" "jsonb",
    CONSTRAINT "sam_snippets_warmup_ladder_valid" CHECK ("public"."sam_warmup_ladder_is_valid"("warmup_ladder"))
);


ALTER TABLE "public"."sam_snippets" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_snippets" IS 'SAM. A practice-sized slice of a song (measure range), the actual unit of deliberate
practice. Looping a hard four-bar passage is the point of the app.';



COMMENT ON COLUMN "public"."sam_snippets"."rest_measures" IS 'Silent measures inserted between loop repetitions, giving the player a beat to reset.';



COMMENT ON COLUMN "public"."sam_snippets"."settings" IS 'Only settings.handMode is written or read ("both" | "lh" | "rh"; missing = "both"). Other keys
(bpm, windowMs, chordGroupMs) on older rows are obsolete since 2026-07-08 and ignored: tempo,
timing window and chord grouping always come from the song defaults.';



COMMENT ON COLUMN "public"."sam_snippets"."tags" IS 'NOTE: native text[] here, unlike Alfred which uses jsonb arrays for tags.';



COMMENT ON COLUMN "public"."sam_snippets"."warmup_ladder" IS 'Warm-up ladder for this passage: a jsonb ARRAY of rungs, each
{target_percent, accuracy_target, target_passes, consecutive}. target_percent is a percent of the
TARGET tempo (the plan item''s target_effective_bpm, else the song''s confirmed goal_effective_bpm,
else whatever is in the tempo box), never of goal_bpm. NULL = inherit: resolution order is plan item
-> snippet -> song -> the app default in sam_default_warmup_ladder(). [] = no warm-up here, which is
how a level opts out of an inherited ladder. A rung''s null accuracy_target means "use the plan
item''s accuracy target" (85% off-plan). consecutive on a rung means that rung''s target_passes must
be met as a streak WITHIN ONE SESSION — a stop or a pause ends the session and the streak with it.
Validated by sam_warmup_ladder_is_valid(). Ladder PROGRESS is never stored: it lives in memory for
the session, and pressing Warm up always restarts at rung one.';



CREATE TABLE IF NOT EXISTS "public"."sam_song_fingerings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "song_id" "uuid" NOT NULL,
    "measure_num" integer NOT NULL,
    "rh_index" integer NOT NULL,
    "note_index" integer DEFAULT 0 NOT NULL,
    "finger" smallint NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "sam_song_fingerings_finger_check" CHECK ((("finger" >= 1) AND ("finger" <= 5))),
    CONSTRAINT "sam_song_fingerings_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'musicxml'::"text"])))
);


ALTER TABLE "public"."sam_song_fingerings" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_song_fingerings" IS 'SAM. One row per fingering cue, mapped onto right-hand notation events the same way sam_song_lyrics maps syllables. Scoped to song_id only — fingerings do NOT follow a song across re-import, and flattened repeats are marked independently. RLS inherited via the parent song.';



COMMENT ON COLUMN "public"."sam_song_fingerings"."rh_index" IS 'Index into sam_song_measures.rh — which notation event this fingering sits on.';



COMMENT ON COLUMN "public"."sam_song_fingerings"."note_index" IS 'Index into the event''s noteheads, low pitch to high. 0 for single-note events.';



COMMENT ON COLUMN "public"."sam_song_fingerings"."finger" IS 'Right-hand finger number, 1 (thumb) through 5 (little finger).';



COMMENT ON COLUMN "public"."sam_song_fingerings"."source" IS 'manual = entered in the edit screen. musicxml = seeded from <technical><fingering> at import. Both may exist on one notehead; manual always wins at render.';



CREATE TABLE IF NOT EXISTS "public"."sam_song_lyrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "song_id" "uuid" NOT NULL,
    "word_order" integer NOT NULL,
    "syllable" "text" NOT NULL,
    "measure_num" integer,
    "rh_index" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sam_song_lyrics" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_song_lyrics" IS 'SAM. One row per syllable, mapped onto right-hand notation events. Placement workflow:
rows are loaded unplaced (measure_num null), then assigned to (measure_num, rh_index)
in blocks. The partial index idx_song_lyrics_unplaced makes "what is left to place"
a cheap lookup. USER-SUPPLIED TEXT — lyrics are provided by the user, never generated.';



COMMENT ON COLUMN "public"."sam_song_lyrics"."word_order" IS 'Global syllable sequence within the song. Unique per song. The stable identity of a syllable.';



COMMENT ON COLUMN "public"."sam_song_lyrics"."measure_num" IS 'Null = not yet placed. Set during placement.';



COMMENT ON COLUMN "public"."sam_song_lyrics"."rh_index" IS 'Index into sam_song_measures.rh — which note this syllable sits on.';



CREATE TABLE IF NOT EXISTS "public"."sam_song_measures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "song_id" "uuid" NOT NULL,
    "number" integer NOT NULL,
    "rh" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "lh" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "time_signature" "jsonb" DEFAULT '{"beats": 4, "beatType": 4}'::"jsonb" NOT NULL,
    "audio_offset_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "chord" "text",
    "section" "text",
    "lyrics_text" "text",
    "source_measure" "text"
);


ALTER TABLE "public"."sam_song_measures" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_song_measures" IS 'SAM. Canonical per-measure notation, one row per measure. Replaced the monolithic
sam_songs.measures blob so measures can be read and written in ranges instead of
rewriting the whole song. RLS is inherited via the parent song.';



COMMENT ON COLUMN "public"."sam_song_measures"."rh" IS 'jsonb array of right-hand notation events. Lyric placement targets these via rh_index.';



COMMENT ON COLUMN "public"."sam_song_measures"."lh" IS 'jsonb array of left-hand notation events.';



COMMENT ON COLUMN "public"."sam_song_measures"."audio_offset_ms" IS 'Offset into the backing track where this measure begins. Null = not aligned.';



COMMENT ON COLUMN "public"."sam_song_measures"."section" IS 'Structural label — verse, chorus, bridge. Used for snippet naming and navigation.';



COMMENT ON COLUMN "public"."sam_song_measures"."lyrics_text" IS 'Denormalized readable lyric line for this measure. Authoritative syllable placement lives in sam_song_lyrics.';



COMMENT ON COLUMN "public"."sam_song_measures"."source_measure" IS 'Measure number as written in the source score, taken verbatim from the MusicXML <measure number> attribute. TEXT because MusicXML defines this as CDATA: ending brackets commonly use non-numeric labels (X1, X2) and some editions use 12a/12b. Differs from `number` when repeats and navigation were flattened at parse time, and when a pickup offsets the numbering. Null = same as `number`.';



CREATE TABLE IF NOT EXISTS "public"."sam_song_scores" (
    "song_id" "uuid" NOT NULL,
    "measure_number" integer NOT NULL,
    "beats" double precision NOT NULL,
    "rh_onsets" integer NOT NULL,
    "lh_onsets" integer NOT NULL,
    "rh_stack" integer NOT NULL,
    "lh_stack" integer NOT NULL,
    "rh_stretch" integer NOT NULL,
    "lh_stretch" integer NOT NULL,
    "rh_jump" integer NOT NULL,
    "lh_jump" integer NOT NULL,
    "rhythm_variety" integer NOT NULL,
    "accidentals" integer,
    "scores_version" integer NOT NULL,
    "computed_from_edited_at" timestamp with time zone,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sam_song_scores_accidentals_check" CHECK (("accidentals" >= 0)),
    CONSTRAINT "sam_song_scores_beats_check" CHECK (("beats" >= (0)::double precision)),
    CONSTRAINT "sam_song_scores_lh_jump_check" CHECK (("lh_jump" >= 0)),
    CONSTRAINT "sam_song_scores_lh_onsets_check" CHECK (("lh_onsets" >= 0)),
    CONSTRAINT "sam_song_scores_lh_stack_check" CHECK (("lh_stack" >= 0)),
    CONSTRAINT "sam_song_scores_lh_stretch_check" CHECK (("lh_stretch" >= 0)),
    CONSTRAINT "sam_song_scores_measure_number_check" CHECK (("measure_number" >= 1)),
    CONSTRAINT "sam_song_scores_rh_jump_check" CHECK (("rh_jump" >= 0)),
    CONSTRAINT "sam_song_scores_rh_onsets_check" CHECK (("rh_onsets" >= 0)),
    CONSTRAINT "sam_song_scores_rh_stack_check" CHECK (("rh_stack" >= 0)),
    CONSTRAINT "sam_song_scores_rh_stretch_check" CHECK (("rh_stretch" >= 0)),
    CONSTRAINT "sam_song_scores_rhythm_variety_check" CHECK (("rhythm_variety" >= 0)),
    CONSTRAINT "sam_song_scores_scores_version_check" CHECK (("scores_version" >= 1))
);


ALTER TABLE "public"."sam_song_scores" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_song_scores" IS 'SAM. Per-measure difficulty facts from the analyzer (supabase/functions/_shared/analyze.ts, analyzeSongFacts), one row per PLAYED measure. TEMPO-INDEPENDENT ONLY: notes-per-second and flags are derived on read at a resolved tempo (explicit argument -> sam_songs.goal_effective_bpm -> error; never goal_bpm, never default_bpm) and are never stored. DERIVED DATA: rows are replaced wholesale per song and are safe to delete and recompute. Keyed on (song_id, measure_number), never on sam_song_measures.id, because import deletes and reinserts measure rows. RLS inherited via the parent song.';



COMMENT ON COLUMN "public"."sam_song_scores"."song_id" IS 'The song. ON DELETE CASCADE: deleting a song deletes its scores.';



COMMENT ON COLUMN "public"."sam_song_scores"."measure_number" IS 'sam_song_measures.number — the PLAYED measure number (1-based, repeats written out), the same number snippets and simplifier plans use. Not the printed number (source_measure).';



COMMENT ON COLUMN "public"."sam_song_scores"."beats" IS 'Measure length in QUARTER-NOTE beats, from the time signature: beats * 4 / beatType. A 6/8 bar is 3.0. double precision so the value round-trips exactly with the analyzer''s JS number.';



COMMENT ON COLUMN "public"."sam_song_scores"."rh_onsets" IS 'Right-hand sounding events in the measure (rests excluded; a chord is one onset). A count, not a rate: notes-per-beat is rh_onsets / beats, and notes-per-second is (rh_onsets + lh_onsets) / (beats * 60 / bpm), both derived on read.';



COMMENT ON COLUMN "public"."sam_song_scores"."lh_onsets" IS 'Left-hand sounding events in the measure (rests excluded; a chord is one onset). A count, not a rate — see rh_onsets.';



COMMENT ON COLUMN "public"."sam_song_scores"."rh_stack" IS 'Most simultaneous notes in one right-hand event.';



COMMENT ON COLUMN "public"."sam_song_scores"."lh_stack" IS 'Most simultaneous notes in one left-hand event.';



COMMENT ON COLUMN "public"."sam_song_scores"."rh_stretch" IS 'Widest right-hand chord, in semitones (top minus bottom of one event).';



COMMENT ON COLUMN "public"."sam_song_scores"."lh_stretch" IS 'Widest left-hand chord, in semitones (top minus bottom of one event).';



COMMENT ON COLUMN "public"."sam_song_scores"."rh_jump" IS 'Largest move, in semitones, between consecutive right-hand events, following the TOP note. Rests do not break the line.';



COMMENT ON COLUMN "public"."sam_song_scores"."lh_jump" IS 'Largest move, in semitones, between consecutive left-hand events, following the BOTTOM note. Rests do not break the line.';



COMMENT ON COLUMN "public"."sam_song_scores"."rhythm_variety" IS 'Distinct duration tokens per hand, the larger of the two hands (rests count as tokens). Per hand, not pooled: pooling rose when a simplification added a token, punishing the simplification.';



COMMENT ON COLUMN "public"."sam_song_scores"."accidentals" IS 'Note occurrences (not distinct pitches) outside the key signature''s diatonic set, both hands. NULL when the song''s key (fifths) is unknown — unmeasurable, not zero; never treat NULL as 0.';



COMMENT ON COLUMN "public"."sam_song_scores"."scores_version" IS 'Version of the analyzer''s metric DEFINITIONS that produced this row (SCORES_VERSION in code). Bumped whenever a definition changes — rhythm_variety already changed once, pooled -> per hand — so a row computed before a fix can be told apart and recomputed. Version 1 = the definitions at the analyzer port (branch analyzer-port, M2).';



COMMENT ON COLUMN "public"."sam_song_scores"."computed_from_edited_at" IS 'The sam_songs.measures_edited_at value these scores were computed from. The row is fresh iff it IS NOT DISTINCT FROM the song''s current measures_edited_at and scores_version is current — an equality check, never a timestamp comparison (the stamps come from different machines'' clocks). NULL when the song''s measures_edited_at was NULL at compute time.';



COMMENT ON COLUMN "public"."sam_song_scores"."computed_at" IS 'When this row was computed. Informational only — freshness is decided by computed_from_edited_at and scores_version, never by this.';



CREATE TABLE IF NOT EXISTS "public"."sam_songs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "title" "text" NOT NULL,
    "artist" "text",
    "source" "text",
    "source_file" "text",
    "key_signature" "text",
    "time_signature" "text" DEFAULT '4/4'::"text",
    "default_bpm" integer DEFAULT 68,
    "measures" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "archived" boolean DEFAULT false NOT NULL,
    "default_timing_window_ms" integer DEFAULT 300,
    "default_chord_ms" integer DEFAULT 80,
    "default_measure_width" integer DEFAULT 300,
    "audio_file_path" "text",
    "measures_compiled_at" timestamp with time zone,
    "measures_edited_at" timestamp with time zone,
    "playback_speed" integer DEFAULT 100,
    "song_type" "text" DEFAULT 'original'::"text" NOT NULL,
    "parent_song_id" "uuid",
    "difficulty_tier" smallint,
    "generation_notes" "jsonb",
    "source_xml_path" "text",
    "show_imported_fingerings" boolean DEFAULT false NOT NULL,
    "goal_bpm" integer NOT NULL,
    "goal_playback_speed" integer DEFAULT 100 NOT NULL,
    "goal_effective_bpm" integer GENERATED ALWAYS AS (("round"(((("goal_bpm" * "goal_playback_speed"))::numeric / 100.0)))::integer) STORED,
    "goal_set_at" timestamp with time zone,
    "warmup_ladder" "jsonb",
    CONSTRAINT "sam_songs_difficulty_tier_check" CHECK ((("difficulty_tier" IS NULL) OR (("song_type" = 'simplified'::"text") AND (("difficulty_tier" >= 1) AND ("difficulty_tier" <= 9))))),
    CONSTRAINT "sam_songs_goal_bpm_check" CHECK ((("goal_bpm" IS NULL) OR ("goal_bpm" > 0))),
    CONSTRAINT "sam_songs_goal_playback_speed_check" CHECK (("goal_playback_speed" > 0)),
    CONSTRAINT "sam_songs_lineage_check" CHECK (((("song_type" = 'original'::"text") AND ("parent_song_id" IS NULL)) OR (("song_type" = 'simplified'::"text") AND ("parent_song_id" IS NOT NULL)) OR ("song_type" = 'drill'::"text"))),
    CONSTRAINT "sam_songs_no_self_parent_check" CHECK (("parent_song_id" IS DISTINCT FROM "id")),
    CONSTRAINT "sam_songs_song_type_check" CHECK (("song_type" = ANY (ARRAY['original'::"text", 'simplified'::"text", 'drill'::"text"]))),
    CONSTRAINT "sam_songs_warmup_ladder_valid" CHECK ("public"."sam_warmup_ladder_is_valid"("warmup_ladder"))
);


ALTER TABLE "public"."sam_songs" OWNER TO "postgres";


COMMENT ON TABLE "public"."sam_songs" IS 'SAM. Song catalogue with playback and notation defaults. Uses uuid ids and uuid user_id
(contrast with Alfred''s text ids).';



COMMENT ON COLUMN "public"."sam_songs"."measures" IS 'HEAVY JSONB — legacy compiled notation blob. MUST BE EXCLUDED FROM ALL LIST QUERIES.
Fetch on demand only. This column is the reason get_sam_songs returns metadata only.
Canonical per-measure data now lives in sam_song_measures; this is the compiled artifact.';



COMMENT ON COLUMN "public"."sam_songs"."default_timing_window_ms" IS 'Hit-detection tolerance in ms. Wider = more forgiving practice.';



COMMENT ON COLUMN "public"."sam_songs"."default_chord_ms" IS 'Max ms between notes for them to count as a simultaneous chord rather than sequential notes.';



COMMENT ON COLUMN "public"."sam_songs"."measures_compiled_at" IS 'When measures was last built from sam_song_measures.';



COMMENT ON COLUMN "public"."sam_songs"."measures_edited_at" IS 'When sam_song_measures last changed. If this is later than measures_compiled_at, the
compiled blob is stale and needs a rebuild.';



COMMENT ON COLUMN "public"."sam_songs"."playback_speed" IS 'Percent of default_bpm, 100 = full tempo.';



COMMENT ON COLUMN "public"."sam_songs"."song_type" IS 'Discriminator: original | simplified | drill.
  original   — an imported score, the root of a family. No parent.
  simplified — a difficulty-reduced variant of a parent score. Requires a parent.
  drill      — a bespoke practice arrangement (scales, chord-transition patterns).
               Bears no notational relationship to any parent and may have none.
SNAPSHOT SEMANTICS: derivation is a historical fact, not a live dependency. Editing a
parent NEVER propagates to a child, and a child is NEVER regenerated. If a variant
drifts from what is needed, create a new one.';



COMMENT ON COLUMN "public"."sam_songs"."parent_song_id" IS 'Family membership, not a build dependency. ON DELETE SET NULL is deliberate —
deleting an original must not destroy its variants or drills, which remain
independently valuable practice material. Orphans render as roots in the library tree.';



COMMENT ON COLUMN "public"."sam_songs"."difficulty_tier" IS '1-9, ascending difficulty. Meaningful ONLY when song_type = ''simplified''; null
otherwise, enforced by sam_songs_difficulty_tier_check. Not a tier for originals —
an original has no difficulty rating, it has whatever difficulty it has.';



COMMENT ON COLUMN "public"."sam_songs"."generation_notes" IS 'jsonb receipt describing how this song was produced — the simplification plan for a
variant, or the practice rationale for a drill. A RECEIPT, NOT SOURCE: nothing reads
this to regenerate anything. It exists so that, months later, you can see what a
variant actually did before building the next one.';



COMMENT ON COLUMN "public"."sam_songs"."source_xml_path" IS 'Path into the sam-scores Storage bucket holding the original MusicXML document.
RESERVED — populated by the daemon phase (difficulty analysis via music21, which
needs the source document rather than parsed JSON). Null for every song imported
before that work lands, and null for drills, which have no source document.';



COMMENT ON COLUMN "public"."sam_songs"."show_imported_fingerings" IS 'When false (default), fingerings with source=''musicxml'' are hidden. Manual fingerings always render.';



COMMENT ON COLUMN "public"."sam_songs"."goal_bpm" IS 'Goal tempo for this song, in the same units as the tempo box (default_bpm). Deliberately separate
from default_bpm: default_bpm is the tempo the song loads at and drifts when practice tempo is saved;
goal_bpm changes only when deliberately edited. Filled from default_bpm on insert when not supplied
(trigger sam_songs_fill_goal_tempo).';



COMMENT ON COLUMN "public"."sam_songs"."goal_playback_speed" IS 'Goal playback speed percent paired with goal_bpm. 100 = full recording tempo for songs with audio.';



COMMENT ON COLUMN "public"."sam_songs"."goal_effective_bpm" IS 'Generated: round(goal_bpm * goal_playback_speed / 100). The goal tempo actually heard.
Compare against sam_passes.effective_bpm. Default target tempo for difficulty analysis.';



COMMENT ON COLUMN "public"."sam_songs"."goal_set_at" IS 'When the goal tempo was deliberately set or confirmed. NULL = placeholder goal (backfilled or
defaulted), never to be treated as a real target. Stamped automatically on update when
goal_playback_speed changes, or goal_bpm changes on a song without audio (on songs with audio a
goal_bpm change is only scroll-sync calibration). An explicit write to this column is kept.
On insert, a simplified song whose goal pair matches its parent copies the parent''s value.';



COMMENT ON COLUMN "public"."sam_songs"."warmup_ladder" IS 'Warm-up ladder fallback for every range in this song: a jsonb ARRAY of rungs, each
{target_percent, accuracy_target, target_passes, consecutive}. target_percent is a percent of the
TARGET tempo, never of goal_bpm. NULL = inherit: resolution order is plan item -> snippet -> song ->
the app default in sam_default_warmup_ladder(), so NULL here falls through to the default. [] = no
warm-up for this song. A rung''s null accuracy_target means "use the plan item''s accuracy target"
(85% off-plan). consecutive on a rung means that rung''s target_passes must be met as a streak
WITHIN ONE SESSION — a stop or a pause ends the session and the streak with it. Validated by
sam_warmup_ladder_is_valid(). Ladder progress is never stored.';



CREATE TABLE IF NOT EXISTS "public"."wb_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "source" "text" NOT NULL,
    "external_id" "text",
    "institution" "text",
    "name" "text" NOT NULL,
    "display_name" "text",
    "last4" "text",
    "owner" "text",
    "role" "text" DEFAULT 'unassigned'::"text" NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "credit_limit" numeric(14,2),
    "reward_unit" "text",
    "reward_value_per_unit" numeric(10,6),
    "expires_on" "date",
    "active_from" "date",
    "active_until" "date",
    "is_hidden" boolean DEFAULT false NOT NULL,
    "last_synced_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_accounts_active_window_check" CHECK ((("active_from" IS NULL) OR ("active_until" IS NULL) OR ("active_from" <= "active_until"))),
    CONSTRAINT "wb_accounts_external_id_check" CHECK ((("source" = 'simplefin'::"text") = ("external_id" IS NOT NULL))),
    CONSTRAINT "wb_accounts_last4_check" CHECK ((("last4" IS NULL) OR ("last4" ~ '^[0-9]{4}$'::"text"))),
    CONSTRAINT "wb_accounts_owner_check" CHECK ((("owner" IS NULL) OR ("owner" = ANY (ARRAY['alex'::"text", 'elise'::"text", 'joint'::"text"])))),
    CONSTRAINT "wb_accounts_role_check" CHECK (("role" = ANY (ARRAY['unassigned'::"text", 'spending_cash'::"text", 'reserve_cash'::"text", 'credit_card'::"text", 'emergency_credit'::"text", 'loan'::"text", 'retirement'::"text", 'taxable_investment'::"text", 'rewards'::"text", 'history_rollup'::"text", 'closed'::"text"]))),
    CONSTRAINT "wb_accounts_source_check" CHECK (("source" = ANY (ARRAY['simplefin'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."wb_accounts" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_accounts" IS 'App: Warren Buffet. Every money account, synced from SimpleFIN or entered by hand, with a role that decides which net-worth group it counts in. The sync owns name, institution, external_id, last4 and last_synced_at; display_name, owner, role, credit_limit, reward fields, expires_on, active_from/until, is_hidden and notes are human columns the sync never overwrites.';



COMMENT ON COLUMN "public"."wb_accounts"."name" IS 'As reported by SimpleFIN (or typed for a manual account). Never edited by humans; display_name is the editable label.';



COMMENT ON COLUMN "public"."wb_accounts"."last4" IS 'Last four digits only, parsed from the name when present. Never store more (spec section 3).';



COMMENT ON COLUMN "public"."wb_accounts"."role" IS 'Which net-worth group the account counts in. New synced accounts arrive as unassigned and stay out of net worth until a role is set.';



COMMENT ON COLUMN "public"."wb_accounts"."reward_value_per_unit" IS 'Dollar value per reward unit, chosen by Alex. Null means do not convert, and the account is left out of the rewards total.';



COMMENT ON COLUMN "public"."wb_accounts"."active_until" IS 'For history_rollup accounts: the day before synced history starts, so rollups never double count with real accounts. A history_rollup with no active_until counts on no date.';



CREATE TABLE IF NOT EXISTS "public"."wb_balance_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "as_of" "date" NOT NULL,
    "balance" numeric(14,2) NOT NULL,
    "available_balance" numeric(14,2),
    "reported_at" timestamp with time zone,
    "source" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_balance_snapshots_source_check" CHECK (("source" = ANY (ARRAY['sync'::"text", 'manual'::"text", 'import'::"text"])))
);


ALTER TABLE "public"."wb_balance_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_balance_snapshots" IS 'App: Warren Buffet. One balance per account per day. The sync upserts its own row for today but never overwrites a manual or import row: it pre-reads today''s rows and skips any account whose row is not source = sync.';



COMMENT ON COLUMN "public"."wb_balance_snapshots"."as_of" IS 'Local date, America/Los_Angeles.';



COMMENT ON COLUMN "public"."wb_balance_snapshots"."reported_at" IS 'SimpleFIN balance-date for synced rows.';



CREATE OR REPLACE VIEW "public"."wb_account_latest" WITH ("security_invoker"='true') AS
 SELECT "a"."id" AS "account_id",
    "a"."user_id",
    "a"."context_id",
    "a"."source",
    "a"."institution",
    "a"."name",
    "a"."display_name",
    COALESCE("a"."display_name", "a"."name") AS "label",
    "a"."last4",
    "a"."owner",
    "a"."role",
    "a"."currency",
    "a"."credit_limit",
    "a"."reward_unit",
    "a"."reward_value_per_unit",
    "a"."expires_on",
    "a"."is_hidden",
    "a"."last_synced_at",
    "s"."as_of",
    "s"."balance",
    "s"."available_balance",
    "s"."source" AS "snapshot_source",
    ((("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" - "s"."as_of") AS "staleness_days"
   FROM ("public"."wb_accounts" "a"
     LEFT JOIN LATERAL ( SELECT "bs"."as_of",
            "bs"."balance",
            "bs"."available_balance",
            "bs"."source"
           FROM "public"."wb_balance_snapshots" "bs"
          WHERE ("bs"."account_id" = "a"."id")
          ORDER BY "bs"."as_of" DESC
         LIMIT 1) "s" ON (true));


ALTER VIEW "public"."wb_account_latest" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_account_latest" IS 'App: Warren Buffet. Each account with its most recent balance snapshot and staleness in days (America/Los_Angeles). Null as_of means no snapshot yet. security_invoker, so wb_ RLS applies.';



CREATE OR REPLACE VIEW "public"."wb_burn_rate" WITH ("security_invoker"='true') AS
 SELECT "month",
    "included",
    "project_excluded",
    "matched_excluded",
    "subscription_excluded",
    "burn_median",
    "burn_mean"
   FROM "public"."wb_burn_rate_on"((("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date") "wb_burn_rate_on"("month", "included", "project_excluded", "matched_excluded", "subscription_excluded", "burn_median", "burn_mean");


ALTER VIEW "public"."wb_burn_rate" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_burn_rate" IS 'App: Warren Buffet. wb_burn_rate_on for today: the 3 full months used, what each left out, the median (the burn rate) and the mean. security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "external_id" "text" NOT NULL,
    "posted_at" timestamp with time zone,
    "transacted_at" timestamp with time zone,
    "amount" numeric(14,2) NOT NULL,
    "description" "text",
    "payee" "text",
    "memo" "text",
    "mcc" "text",
    "pending" boolean DEFAULT false NOT NULL,
    "raw" "jsonb" NOT NULL,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "clean_description" "text",
    "merchant_id" "uuid",
    "merchant_source" "text",
    "kind" "text",
    "kind_source" "text",
    "transfer_pair_id" "uuid",
    "transfer_candidate" boolean DEFAULT false NOT NULL,
    "matched_rule_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "reviewed" boolean DEFAULT false NOT NULL,
    "processed_at" timestamp with time zone,
    "notes" "text",
    "subscription_id" "uuid",
    "subscription_source" "text",
    CONSTRAINT "wb_transactions_kind_check" CHECK ((("kind" IS NULL) OR ("kind" = ANY (ARRAY['spend'::"text", 'income'::"text", 'transfer'::"text", 'refund'::"text", 'investment'::"text", 'interest'::"text", 'fee'::"text"])))),
    CONSTRAINT "wb_transactions_kind_source_check" CHECK ((("kind_source" IS NULL) OR ("kind_source" = ANY (ARRAY['default'::"text", 'rule'::"text", 'claude'::"text", 'manual'::"text"])))),
    CONSTRAINT "wb_transactions_merchant_source_check" CHECK ((("merchant_source" IS NULL) OR ("merchant_source" = ANY (ARRAY['default'::"text", 'rule'::"text", 'claude'::"text", 'manual'::"text"])))),
    CONSTRAINT "wb_transactions_not_own_pair" CHECK ((("transfer_pair_id" IS NULL) OR ("transfer_pair_id" <> "id"))),
    CONSTRAINT "wb_transactions_subscription_source_check" CHECK ((("subscription_source" IS NULL) OR ("subscription_source" = ANY (ARRAY['default'::"text", 'claude'::"text", 'manual'::"text"]))))
);


ALTER TABLE "public"."wb_transactions" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_transactions" IS 'App: Warren Buffet. Raw transactions exactly as SimpleFIN reports them; never edited. Stored from day one because SimpleFIN only returns the last 90 days. Sign: money in positive, money out negative, on every account. The sync deletes a pending row only when a later fetch covers its date and does not return it; posted rows are never deleted.';



COMMENT ON COLUMN "public"."wb_transactions"."description" IS 'Raw bank description, unedited. Cleanup lives in Phase 2 columns.';



COMMENT ON COLUMN "public"."wb_transactions"."raw" IS 'Full SimpleFIN transaction object. Excluded from every list read.';



COMMENT ON COLUMN "public"."wb_transactions"."clean_description" IS 'Set by wb_process_transactions from the raw description; never typed by hand.';



COMMENT ON COLUMN "public"."wb_transactions"."merchant_source" IS 'default, rule, claude or manual. Processing never changes a claude or manual merchant.';



COMMENT ON COLUMN "public"."wb_transactions"."kind" IS 'spend, income, transfer, refund, investment, interest or fee. Null until processed.';



COMMENT ON COLUMN "public"."wb_transactions"."kind_source" IS 'default, rule, claude or manual. Processing never changes a claude or manual kind, and never pairs such a row.';



COMMENT ON COLUMN "public"."wb_transactions"."transfer_pair_id" IS 'The other side of a transfer between household accounts; both rows point at each other.';



COMMENT ON COLUMN "public"."wb_transactions"."transfer_candidate" IS 'Processing found a transfer to pair but no unique match; it waits in the review queue.';



COMMENT ON COLUMN "public"."wb_transactions"."matched_rule_ids" IS 'Rules that matched at the last processing; wb_rules.hit_count is computed from it.';



COMMENT ON COLUMN "public"."wb_transactions"."processed_at" IS 'Last time wb_process_transactions touched the row. Null = never processed.';



COMMENT ON COLUMN "public"."wb_transactions"."notes" IS 'Free-text note on the transaction, written by a person or Claude. The sync never writes it.';



COMMENT ON COLUMN "public"."wb_transactions"."subscription_source" IS 'default = linked by processing or detection; claude or manual = set by hand (wb_link_subscription), never changed by processing, including a hand unlink (subscription_id null).';



CREATE OR REPLACE VIEW "public"."wb_cash_flow_monthly" WITH ("security_invoker"='true') AS
 WITH "m" AS (
         SELECT ("date_trunc"('month'::"text", (COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text")))::"date" AS "month",
            COALESCE("sum"("x"."amount") FILTER (WHERE ("x"."kind" = ANY (ARRAY['income'::"text", 'interest'::"text"]))), (0)::numeric) AS "income",
            COALESCE("sum"("x"."amount") FILTER (WHERE ("x"."kind" = ANY (ARRAY['spend'::"text", 'refund'::"text", 'fee'::"text"]))), (0)::numeric) AS "spending",
            "count"(*) FILTER (WHERE ("x"."kind" IS NULL)) AS "unprocessed"
           FROM "public"."wb_transactions" "x"
          WHERE (NOT "x"."pending")
          GROUP BY (("date_trunc"('month'::"text", (COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text")))::"date")
        )
 SELECT "month",
    "income",
    "spending",
    ("income" + "spending") AS "net",
    "unprocessed"
   FROM "m";


ALTER VIEW "public"."wb_cash_flow_monthly" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_cash_flow_monthly" IS 'App: Warren Buffet. Per month (posted rows): income (income + interest), spending (spend + refund + fee, negative = money out), net, and how many rows are not yet processed. Transfers and investments excluded. security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_holding_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "as_of" "date" NOT NULL,
    "external_id" "text" NOT NULL,
    "symbol" "text",
    "description" "text",
    "shares" numeric(20,6),
    "market_value" numeric(14,2),
    "cost_basis" numeric(14,2),
    "purchase_price" numeric(14,4),
    "currency" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."wb_holding_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_holding_snapshots" IS 'App: Warren Buffet. One row per investment position per account per day, as SimpleFIN reports it. Sync-managed.';



COMMENT ON COLUMN "public"."wb_holding_snapshots"."external_id" IS 'SimpleFIN holding id.';



CREATE TABLE IF NOT EXISTS "public"."wb_merchants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "match_patterns" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "default_kind" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "not_subscription" boolean DEFAULT false NOT NULL,
    CONSTRAINT "wb_merchants_default_kind_check" CHECK ((("default_kind" IS NULL) OR ("default_kind" = ANY (ARRAY['spend'::"text", 'income'::"text", 'transfer'::"text", 'refund'::"text", 'investment'::"text", 'interest'::"text", 'fee'::"text"])))),
    CONSTRAINT "wb_merchants_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_merchants_patterns_check" CHECK ((("array_position"("match_patterns", NULL::"text") IS NULL) AND (''::"text" <> ALL ("match_patterns"))))
);


ALTER TABLE "public"."wb_merchants" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_merchants" IS 'App: Warren Buffet. One clean merchant name plus the messy bank text that maps to it. Processing matches each pattern as a case-insensitive substring of the payee first, then the raw description; the longest matching pattern wins.';



COMMENT ON COLUMN "public"."wb_merchants"."match_patterns" IS 'Case-insensitive substrings; a pattern must be contained in the text, never the reverse.';



COMMENT ON COLUMN "public"."wb_merchants"."default_kind" IS 'Kind given to this merchant''s transactions, ahead of the sign rules but behind the investment-account rule.';



COMMENT ON COLUMN "public"."wb_merchants"."not_subscription" IS 'True when this merchant''s regular charges are not a subscription (insurance, HOA, a store): detection skips it and its watching row leaves the review queue. Set when a detection is dismissed.';



CREATE OR REPLACE VIEW "public"."wb_net_worth_daily" WITH ("security_invoker"='true') AS
 WITH "bounds" AS (
         SELECT "min"("wb_balance_snapshots"."as_of") AS "first_day",
            "max"("wb_balance_snapshots"."as_of") AS "last_day"
           FROM "public"."wb_balance_snapshots"
        ), "days" AS (
         SELECT ("generate_series"(("b"."first_day")::timestamp with time zone, ("b"."last_day")::timestamp with time zone, '1 day'::interval))::"date" AS "as_of"
           FROM "bounds" "b"
          WHERE ("b"."first_day" IS NOT NULL)
        ), "account_days" AS (
         SELECT "d"."as_of",
            "a"."role",
            "a"."reward_value_per_unit",
            ( SELECT "bs"."balance"
                   FROM "public"."wb_balance_snapshots" "bs"
                  WHERE (("bs"."account_id" = "a"."id") AND ("bs"."as_of" <= "d"."as_of"))
                  ORDER BY "bs"."as_of" DESC
                 LIMIT 1) AS "balance"
           FROM (("days" "d"
             CROSS JOIN "public"."wb_accounts" "a")
             LEFT JOIN LATERAL ( SELECT "max"("bs"."as_of") AS "last_as_of"
                   FROM "public"."wb_balance_snapshots" "bs"
                  WHERE ("bs"."account_id" = "a"."id")) "l" ON (true))
          WHERE ((("a"."role" <> 'closed'::"text") OR ("d"."as_of" <= "l"."last_as_of")) AND (("a"."role" <> 'history_rollup'::"text") OR (("a"."active_until" IS NOT NULL) AND ("d"."as_of" <= "a"."active_until") AND (("a"."active_from" IS NULL) OR ("d"."as_of" >= "a"."active_from")))))
        ), "grouped" AS (
         SELECT "account_days"."as_of",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'spending_cash'::"text")), (0)::numeric) AS "spending_cash",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'reserve_cash'::"text")), (0)::numeric) AS "reserve_cash",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = ANY (ARRAY['credit_card'::"text", 'emergency_credit'::"text"]))), (0)::numeric) AS "credit_owed",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'loan'::"text")), (0)::numeric) AS "loans",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'retirement'::"text")), (0)::numeric) AS "retirement",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'taxable_investment'::"text")), (0)::numeric) AS "taxable_investments",
            COALESCE("sum"("round"(("account_days"."balance" * "account_days"."reward_value_per_unit"), 2)) FILTER (WHERE (("account_days"."role" = 'rewards'::"text") AND ("account_days"."reward_value_per_unit" IS NOT NULL))), (0)::numeric) AS "rewards",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'history_rollup'::"text")), (0)::numeric) AS "history_rollup",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'closed'::"text")), (0)::numeric) AS "closed",
            COALESCE("sum"("account_days"."balance") FILTER (WHERE ("account_days"."role" = 'unassigned'::"text")), (0)::numeric) AS "unassigned"
           FROM "account_days"
          GROUP BY "account_days"."as_of"
        )
 SELECT "as_of",
    "spending_cash",
    "reserve_cash",
    "credit_owed",
    "loans",
    "retirement",
    "taxable_investments",
    "rewards",
    "history_rollup",
    "closed",
    "unassigned",
    (((((((("spending_cash" + "reserve_cash") + "credit_owed") + "loans") + "retirement") + "taxable_investments") + "rewards") + "history_rollup") + "closed") AS "net_worth"
   FROM "grouped";


ALTER VIEW "public"."wb_net_worth_daily" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_net_worth_daily" IS 'App: Warren Buffet. Per day, totals by role group and net worth, carrying each account''s last known balance forward on days with no snapshot. A closed account counts in its own closed column up to and including its last snapshot and never after. history_rollup accounts count only inside active_from..active_until; one with no active_until never counts. unassigned is shown but kept out of net_worth; rewards convert only where reward_value_per_unit is set. Debts are negative balances. security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_planned_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "project_id" "uuid",
    "name" "text" NOT NULL,
    "counterparty" "text",
    "merchant_id" "uuid",
    "amount" numeric(14,2) NOT NULL,
    "due_on" "date" NOT NULL,
    "interval_count" integer,
    "interval_unit" "text",
    "ends_on" "date",
    "stage" "text",
    "is_draft" boolean DEFAULT false NOT NULL,
    "tax_year" integer,
    "amount_tolerance" numeric(14,2) DEFAULT 0 NOT NULL,
    "match_window_days" integer DEFAULT 10 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_planned_items_amount_check" CHECK (("amount" <> (0)::numeric)),
    CONSTRAINT "wb_planned_items_ends_check" CHECK ((("ends_on" IS NULL) OR (("interval_count" IS NOT NULL) AND ("ends_on" >= "due_on")))),
    CONSTRAINT "wb_planned_items_interval_check" CHECK (((("interval_count" IS NULL) AND ("interval_unit" IS NULL)) OR ((("interval_count" >= 1) AND ("interval_count" <= 120)) AND ("interval_unit" IS NOT NULL) AND ("interval_unit" = ANY (ARRAY['week'::"text", 'month'::"text"]))))),
    CONSTRAINT "wb_planned_items_is_draft_check" CHECK (((NOT "is_draft") OR ("interval_count" IS NOT NULL))),
    CONSTRAINT "wb_planned_items_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_planned_items_stage_check" CHECK (((("interval_count" IS NULL) AND ("stage" IS NOT NULL) AND ("stage" = ANY (ARRAY['draft'::"text", 'estimate'::"text", 'quoted'::"text", 'invoiced'::"text", 'paid'::"text", 'cancelled'::"text"]))) OR (("interval_count" IS NOT NULL) AND ("stage" IS NULL)))),
    CONSTRAINT "wb_planned_items_tax_year_check" CHECK ((("tax_year" IS NULL) OR (("tax_year" >= 2000) AND ("tax_year" <= 2100)))),
    CONSTRAINT "wb_planned_items_tolerance_check" CHECK (("amount_tolerance" >= (0)::numeric)),
    CONSTRAINT "wb_planned_items_window_check" CHECK ((("match_window_days" >= 0) AND ("match_window_days" <= 90)))
);


ALTER TABLE "public"."wb_planned_items" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_planned_items" IS 'App: Warren Buffet. Future money in or out. Signed amount: in positive, out negative. A one-off has a stage; a recurring item (interval_count + interval_unit) has none and repeats from due_on until ends_on. Drafts (stage draft, or is_draft on a recurring item) stay out of free cash unless a scenario includes them. Premiums and expected income are recurring items. Subscriptions are never stored here: they are computed from wb_subscriptions.';



COMMENT ON COLUMN "public"."wb_planned_items"."merchant_id" IS 'Optional merchant, used by match suggestions.';



COMMENT ON COLUMN "public"."wb_planned_items"."amount" IS 'Signed: money in positive, money out negative. For a recurring item, the amount of each occurrence.';



COMMENT ON COLUMN "public"."wb_planned_items"."due_on" IS 'A one-off''s date; a recurring item''s first (or next) occurrence.';



COMMENT ON COLUMN "public"."wb_planned_items"."stage" IS 'One-off only: draft (what if; kept out of free cash unless a scenario includes drafts), estimate, quoted, invoiced, paid, cancelled. Null for a recurring item.';



COMMENT ON COLUMN "public"."wb_planned_items"."is_draft" IS 'Recurring items only: a what-if, kept out of free cash unless a scenario includes drafts. A one-off draft uses stage draft instead.';



COMMENT ON COLUMN "public"."wb_planned_items"."tax_year" IS 'Optional tax year this money belongs to.';



COMMENT ON COLUMN "public"."wb_planned_items"."amount_tolerance" IS 'Dollars either side of the amount that a payment may differ by and still be suggested as a match.';



COMMENT ON COLUMN "public"."wb_planned_items"."match_window_days" IS 'Days either side of the due date in which a payment may be suggested as a match.';



CREATE TABLE IF NOT EXISTS "public"."wb_planned_matches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "planned_item_id" "uuid" NOT NULL,
    "split_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "occurrence_on" "date",
    "amount_applied" numeric(14,2) NOT NULL,
    "status" "text" DEFAULT 'suggested'::"text" NOT NULL,
    "source" "text" DEFAULT 'default'::"text" NOT NULL,
    "decided_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_planned_matches_amount_check" CHECK (("amount_applied" <> (0)::numeric)),
    CONSTRAINT "wb_planned_matches_source_check" CHECK (("source" = ANY (ARRAY['default'::"text", 'claude'::"text", 'manual'::"text"]))),
    CONSTRAINT "wb_planned_matches_status_check" CHECK (("status" = ANY (ARRAY['suggested'::"text", 'confirmed'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."wb_planned_matches" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_planned_matches" IS 'App: Warren Buffet. Links a planned item (and, for a recurring item, one occurrence) to a split that paid it, with the amount applied (partial payments allowed). suggested rows come from the suggestion function and wait in the review queue; confirmed and rejected are decisions, and a rejected row stops the same suggestion coming back. user_id, context_id and transaction_id are filled by trigger.';



COMMENT ON COLUMN "public"."wb_planned_matches"."occurrence_on" IS 'The occurrence date a payment settles. Required for a recurring planned item; null for a one-off.';



COMMENT ON COLUMN "public"."wb_planned_matches"."amount_applied" IS 'Same sign as the planned item. Confirmed amounts on one split never exceed that split''s amount.';



COMMENT ON COLUMN "public"."wb_planned_matches"."status" IS 'suggested, confirmed or rejected.';



COMMENT ON COLUMN "public"."wb_planned_matches"."source" IS 'default = the suggestion function; claude or manual = made by hand.';



CREATE TABLE IF NOT EXISTS "public"."wb_planned_skips" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "planned_item_id" "uuid" NOT NULL,
    "occurrence_on" "date",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."wb_planned_skips" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_planned_skips" IS 'App: Warren Buffet. A past due date of a planned item marked Not needed (for example a payment from before the bank sync started), so wb_planned_unmatched and the weekly cleanup leave it out. occurrence_on is the date for a recurring item and null for a one-off, as in wb_planned_matches. user_id and context_id are filled from the planned item by trigger. Deleting the planned item deletes its skips.';



COMMENT ON COLUMN "public"."wb_planned_skips"."occurrence_on" IS 'The skipped due date of a recurring item; null for a one-off.';



COMMENT ON COLUMN "public"."wb_planned_skips"."reason" IS 'Optional note on why the date is not needed.';



CREATE TABLE IF NOT EXISTS "public"."wb_projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "budget" numeric(14,2),
    "starts_on" "date",
    "ends_on" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_projects_budget_check" CHECK ((("budget" IS NULL) OR ("budget" >= (0)::numeric))),
    CONSTRAINT "wb_projects_dates_check" CHECK ((("starts_on" IS NULL) OR ("ends_on" IS NULL) OR ("starts_on" <= "ends_on"))),
    CONSTRAINT "wb_projects_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_projects_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'on_hold'::"text", 'done'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."wb_projects" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_projects" IS 'App: Warren Buffet. A group of payments, such as a remodel or a trip. Splits join a project through wb_splits.project_id; planned items through wb_planned_items.project_id. Optional: a one-off planned item needs no project.';



COMMENT ON COLUMN "public"."wb_projects"."status" IS 'active, on_hold, done or cancelled.';



COMMENT ON COLUMN "public"."wb_projects"."budget" IS 'Optional total budget, positive.';



CREATE OR REPLACE VIEW "public"."wb_planned_unmatched" WITH ("security_invoker"='true') AS
 WITH "t" AS (
         SELECT (("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "d"
        ), "occ" AS (
         SELECT "o"."planned_item_id",
            "o"."occurrence_on" AS "due_on",
            "o"."occurrence_on",
            true AS "recurring"
           FROM ("t" "t_1"
             CROSS JOIN LATERAL "public"."wb_planned_occurrences"(COALESCE(( SELECT "min"("wb_planned_items"."due_on") AS "min"
                   FROM "public"."wb_planned_items"
                  WHERE ("wb_planned_items"."interval_count" IS NOT NULL)), "t_1"."d"), ("t_1"."d" - 1), false) "o"("planned_item_id", "occurrence_on", "amount", "recurring", "stage", "is_draft"))
          WHERE "o"."recurring"
        UNION ALL
         SELECT "pi_1"."id",
            "pi_1"."due_on",
            NULL::"date" AS "date",
            false
           FROM "public"."wb_planned_items" "pi_1",
            "t" "t_1"
          WHERE (("pi_1"."interval_count" IS NULL) AND ("pi_1"."due_on" < "t_1"."d") AND ("pi_1"."stage" <> ALL (ARRAY['draft'::"text", 'paid'::"text", 'cancelled'::"text"])))
        ), "done" AS (
         SELECT "o"."planned_item_id",
            "o"."due_on",
            "o"."occurrence_on",
            "o"."recurring",
            COALESCE(( SELECT "sum"("abs"("pm"."amount_applied")) AS "sum"
                   FROM "public"."wb_planned_matches" "pm"
                  WHERE (("pm"."planned_item_id" = "o"."planned_item_id") AND ("pm"."status" = 'confirmed'::"text") AND (NOT ("pm"."occurrence_on" IS DISTINCT FROM "o"."occurrence_on")))), (0)::numeric) AS "paid"
           FROM "occ" "o"
        )
 SELECT "d"."planned_item_id",
    "pi"."name",
    "pi"."project_id",
    "pr"."name" AS "project_name",
    "pi"."merchant_id",
    "m"."name" AS "merchant_name",
    "d"."recurring",
    "d"."due_on",
    "d"."occurrence_on",
    "pi"."stage",
    "pi"."amount",
    "round"(("sign"("pi"."amount") * "d"."paid"), 2) AS "confirmed_total",
    "round"("public"."wb_planned_left"("pi"."amount", "d"."paid", "pi"."amount_tolerance"), 2) AS "remaining",
    ("t"."d" - "d"."due_on") AS "days_late",
    (("t"."d" - "d"."due_on") <= "pi"."match_window_days") AS "within_window",
    (EXISTS ( SELECT 1
           FROM "public"."wb_planned_matches" "pm"
          WHERE (("pm"."planned_item_id" = "d"."planned_item_id") AND ("pm"."status" = 'suggested'::"text") AND (NOT ("pm"."occurrence_on" IS DISTINCT FROM "d"."occurrence_on"))))) AS "has_suggestion"
   FROM (((("done" "d"
     CROSS JOIN "t")
     JOIN "public"."wb_planned_items" "pi" ON (("pi"."id" = "d"."planned_item_id")))
     LEFT JOIN "public"."wb_projects" "pr" ON (("pr"."id" = "pi"."project_id")))
     LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "pi"."merchant_id")))
  WHERE (("public"."wb_planned_left"("pi"."amount", "d"."paid", "pi"."amount_tolerance") <> (0)::numeric) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."wb_planned_skips" "sk"
          WHERE (("sk"."planned_item_id" = "d"."planned_item_id") AND (NOT ("sk"."occurrence_on" IS DISTINCT FROM "d"."occurrence_on")))))));


ALTER VIEW "public"."wb_planned_unmatched" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_planned_unmatched" IS 'App: Warren Buffet. Missed dates: every due date before today (Pacific) that its confirmed matches do not cover (more than the item''s amount_tolerance left, A45). Recurring items give one row per past date from due_on (occurrence_on set); a one-off gives one row once its date is past, unless it is a draft, paid or cancelled (occurrence_on null). Recurring drafts are left out. A date in wb_planned_skips (Not needed) is left out. confirmed_total and remaining carry the item''s sign; days_late counts from the due date; within_window is true while a payment may still be suggested (days_late <= match_window_days); has_suggestion when one waits in Review. The weekly cleanup reads this view (A25). security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "safety_floor" numeric(14,2),
    "horizon_months" integer DEFAULT 12 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_settings_floor_check" CHECK ((("safety_floor" IS NULL) OR ("safety_floor" >= (0)::numeric))),
    CONSTRAINT "wb_settings_horizon_check" CHECK ((("horizon_months" >= 1) AND ("horizon_months" <= 24)))
);


ALTER TABLE "public"."wb_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_settings" IS 'App: Warren Buffet. One row per context of money settings. The floor value is entered by Alex at seeding and never written into a committed file.';



COMMENT ON COLUMN "public"."wb_settings"."safety_floor" IS 'Cash kept back: free cash = the lowest projected spending-cash balance over the horizon minus this. Positive.';



COMMENT ON COLUMN "public"."wb_settings"."horizon_months" IS 'Months the cash projection looks ahead. Default 12.';



CREATE TABLE IF NOT EXISTS "public"."wb_splits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "description" "text",
    "tax_year" integer,
    "position" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "project_id" "uuid",
    "project_source" "text",
    CONSTRAINT "wb_splits_project_source_check" CHECK (((("project_source" IS NULL) OR ("project_source" = ANY (ARRAY['rule'::"text", 'claude'::"text", 'manual'::"text"]))) AND (("project_id" IS NULL) OR ("project_source" IS NOT NULL)))),
    CONSTRAINT "wb_splits_tax_year_check" CHECK ((("tax_year" IS NULL) OR (("tax_year" >= 2000) AND ("tax_year" <= 2100))))
);


ALTER TABLE "public"."wb_splits" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_splits" IS 'App: Warren Buffet. Parts of a transaction; tags live here. Every transaction has at least one split, created by trigger, and its splits must sum to its amount (deferred check at commit). user_id and context_id are copied from the transaction by trigger.';



COMMENT ON COLUMN "public"."wb_splits"."tax_year" IS 'Null means the calendar year of the transaction.';



COMMENT ON COLUMN "public"."wb_splits"."project_id" IS 'Optional project this part of a transaction belongs to; set by hand or (Phase 3 Step 4) by a rule. Project-linked splits leave the burn rate.';



COMMENT ON COLUMN "public"."wb_splits"."project_source" IS 'Who set project_id: rule, claude or manual. claude and manual are never changed by processing; a null project_id with source claude or manual is a project removed by hand, which no rule puts back. A project written with no source counts as manual (trigger).';



CREATE OR REPLACE VIEW "public"."wb_project_summary" WITH ("security_invoker"='true') AS
 WITH "t" AS (
         SELECT (("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "d",
            COALESCE(( SELECT "wb_settings"."horizon_months"
                   FROM "public"."wb_settings"
                  ORDER BY "wb_settings"."created_at"
                 LIMIT 1), 12) AS "h"
        ), "pay" AS (
         SELECT "s"."project_id",
            COALESCE("sum"("s"."amount") FILTER (WHERE ("s"."amount" < (0)::numeric)), (0)::numeric) AS "spent",
            COALESCE("sum"("s"."amount") FILTER (WHERE ("s"."amount" > (0)::numeric)), (0)::numeric) AS "received",
            ("count"(*))::integer AS "payment_count",
            "max"(((COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text"))::"date") AS "last_payment_on"
           FROM ("public"."wb_splits" "s"
             JOIN "public"."wb_transactions" "x" ON (("x"."id" = "s"."transaction_id")))
          WHERE (("s"."project_id" IS NOT NULL) AND (NOT "x"."pending"))
          GROUP BY "s"."project_id"
        ), "items" AS (
         SELECT "pi"."project_id",
            ("count"(*) FILTER (WHERE (COALESCE("pi"."stage", ''::"text") <> 'cancelled'::"text")))::integer AS "item_count",
            ("count"(*) FILTER (WHERE (("pi"."stage" = 'draft'::"text") OR "pi"."is_draft")))::integer AS "draft_count"
           FROM "public"."wb_planned_items" "pi"
          WHERE ("pi"."project_id" IS NOT NULL)
          GROUP BY "pi"."project_id"
        ), "due" AS (
         SELECT "q"."project_id",
            "q"."draft",
            "sum"("q"."left_amt") FILTER (WHERE ("q"."left_amt" < (0)::numeric)) AS "due_out",
            "sum"("q"."left_amt") FILTER (WHERE ("q"."left_amt" > (0)::numeric)) AS "due_in"
           FROM ( SELECT "pi"."project_id",
                    ("pi"."stage" = 'draft'::"text") AS "draft",
                    "public"."wb_planned_left"("pi"."amount", ( SELECT "sum"("abs"("pm"."amount_applied")) AS "sum"
                           FROM "public"."wb_planned_matches" "pm"
                          WHERE (("pm"."planned_item_id" = "pi"."id") AND ("pm"."status" = 'confirmed'::"text"))), "pi"."amount_tolerance") AS "left_amt"
                   FROM "public"."wb_planned_items" "pi"
                  WHERE (("pi"."project_id" IS NOT NULL) AND ("pi"."interval_count" IS NULL) AND ("pi"."stage" <> ALL (ARRAY['paid'::"text", 'cancelled'::"text"])))
                UNION ALL
                 SELECT "pi"."project_id",
                    "pi"."is_draft",
                    "public"."wb_planned_left"("o"."amount", ( SELECT "sum"("abs"("pm"."amount_applied")) AS "sum"
                           FROM "public"."wb_planned_matches" "pm"
                          WHERE (("pm"."planned_item_id" = "o"."planned_item_id") AND ("pm"."status" = 'confirmed'::"text") AND ("pm"."occurrence_on" = "o"."occurrence_on"))), "pi"."amount_tolerance") AS "wb_planned_left"
                   FROM (("t"
                     CROSS JOIN LATERAL "public"."wb_planned_occurrences"("t"."d", ((("t"."d" + "make_interval"("months" => "t"."h")))::"date" - 1), true) "o"("planned_item_id", "occurrence_on", "amount", "recurring", "stage", "is_draft"))
                     JOIN "public"."wb_planned_items" "pi" ON (("pi"."id" = "o"."planned_item_id")))
                  WHERE ("o"."recurring" AND ("pi"."project_id" IS NOT NULL))) "q"
          GROUP BY "q"."project_id", "q"."draft"
        )
 SELECT "p"."id" AS "project_id",
    "p"."name",
    "p"."status",
    "p"."budget",
    "p"."starts_on",
    "p"."ends_on",
    "round"(COALESCE("pay"."spent", (0)::numeric), 2) AS "spent",
    "round"(COALESCE("pay"."received", (0)::numeric), 2) AS "received",
    "round"((COALESCE("pay"."spent", (0)::numeric) + COALESCE("pay"."received", (0)::numeric)), 2) AS "net",
        CASE
            WHEN ("p"."budget" IS NOT NULL) THEN "round"(("p"."budget" + COALESCE("pay"."spent", (0)::numeric)), 2)
            ELSE NULL::numeric
        END AS "budget_left",
    "round"(COALESCE(( SELECT "d"."due_out"
           FROM "due" "d"
          WHERE (("d"."project_id" = "p"."id") AND (NOT "d"."draft"))), (0)::numeric), 2) AS "planned_out_due",
    "round"(COALESCE(( SELECT "d"."due_in"
           FROM "due" "d"
          WHERE (("d"."project_id" = "p"."id") AND (NOT "d"."draft"))), (0)::numeric), 2) AS "planned_in_due",
    "round"(COALESCE(( SELECT "d"."due_out"
           FROM "due" "d"
          WHERE (("d"."project_id" = "p"."id") AND "d"."draft")), (0)::numeric), 2) AS "draft_out_due",
    "round"(COALESCE(( SELECT "d"."due_in"
           FROM "due" "d"
          WHERE (("d"."project_id" = "p"."id") AND "d"."draft")), (0)::numeric), 2) AS "draft_in_due",
    COALESCE("items"."item_count", 0) AS "item_count",
    COALESCE("items"."draft_count", 0) AS "draft_count",
    COALESCE("pay"."payment_count", 0) AS "payment_count",
    "pay"."last_payment_on",
    ((COALESCE("items"."item_count", 0) > 0) AND ("items"."draft_count" = "items"."item_count") AND (COALESCE("pay"."payment_count", 0) = 0)) AS "planning"
   FROM (("public"."wb_projects" "p"
     LEFT JOIN "pay" ON (("pay"."project_id" = "p"."id")))
     LEFT JOIN "items" ON (("items"."project_id" = "p"."id")));


ALTER VIEW "public"."wb_project_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_project_summary" IS 'App: Warren Buffet. One row per project. spent = posted money out on the project''s splits (negative); received = posted money in (positive, such as an insurer''s payment); net = spent + received. budget_left = budget + spent: the budget is measured against spent, not net (A36). planned_out_due and planned_in_due = what is still to come on its planned items, less what is confirmed (0 when within the item''s amount_tolerance, A45): one-offs not paid or cancelled (overdue included) and recurring dates over the horizon; draft_out_due and draft_in_due are the same for drafts, kept apart. item_count leaves out cancelled items. planning is true when every item is a draft and nothing has been paid on the project (A35); it is derived, never stored. security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_split_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "split_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "group_exclusive" boolean NOT NULL,
    "source" "text" NOT NULL,
    "rule_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "replaced_rule_id" "uuid",
    CONSTRAINT "wb_split_tags_replaced_check" CHECK ((("replaced_rule_id" IS NULL) OR ("source" <> 'rule'::"text"))),
    CONSTRAINT "wb_split_tags_rule_check" CHECK ((("rule_id" IS NULL) OR ("source" = 'rule'::"text"))),
    CONSTRAINT "wb_split_tags_source_check" CHECK (("source" = ANY (ARRAY['rule'::"text", 'claude'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."wb_split_tags" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_split_tags" IS 'App: Warren Buffet. Tags on splits, with their source (rule, claude, manual). group_id, group_exclusive, user_id and context_id are filled by trigger, never typed. Rules replace only their own tags; claude and manual tags are never overwritten by a rule.';



COMMENT ON COLUMN "public"."wb_split_tags"."replaced_rule_id" IS 'For a claude or manual tag that replaced a rule''s tag in the same group, or took over a rule''s tag: that rule. Counts overrides for rule health (Step 10).';



CREATE TABLE IF NOT EXISTS "public"."wb_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "plan" "text",
    "merchant_id" "uuid",
    "billed_through_id" "uuid",
    "bundle_id" "uuid",
    "cadence" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "expected_amount" numeric(12,2),
    "amount_tolerance" numeric(12,2) DEFAULT 0 NOT NULL,
    "term_end_date" "date",
    "auto_renew" boolean,
    "review_date" "date",
    "last_charged_on" "date",
    "next_expected_on" "date",
    "status" "text" DEFAULT 'watching'::"text" NOT NULL,
    "owner" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "interval_count" integer,
    "interval_unit" "text",
    CONSTRAINT "wb_subscriptions_billed_through_check" CHECK ((("billed_through_id" IS NULL) OR ("billed_through_id" <> "id"))),
    CONSTRAINT "wb_subscriptions_bundle_check" CHECK ((("bundle_id" IS NULL) OR ("bundle_id" <> "id"))),
    CONSTRAINT "wb_subscriptions_cadence_check" CHECK (("cadence" = ANY (ARRAY['monthly'::"text", 'quarterly'::"text", 'annual'::"text", 'other'::"text"]))),
    CONSTRAINT "wb_subscriptions_expected_check" CHECK ((("expected_amount" IS NULL) OR ("expected_amount" > (0)::numeric))),
    CONSTRAINT "wb_subscriptions_interval_check" CHECK (((("interval_count" IS NULL) = ("interval_unit" IS NULL)) AND (("interval_count" IS NULL) OR (("interval_count" >= 1) AND ("interval_count" <= 104))) AND (("interval_unit" IS NULL) OR ("interval_unit" = ANY (ARRAY['week'::"text", 'month'::"text"]))) AND (("cadence" = 'other'::"text") OR (("cadence" = 'monthly'::"text") AND ("interval_count" = 1) AND ("interval_unit" = 'month'::"text")) OR (("cadence" = 'quarterly'::"text") AND ("interval_count" = 3) AND ("interval_unit" = 'month'::"text")) OR (("cadence" = 'annual'::"text") AND ("interval_count" = 12) AND ("interval_unit" = 'month'::"text"))))),
    CONSTRAINT "wb_subscriptions_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_subscriptions_owner_check" CHECK ((("owner" IS NULL) OR ("owner" = ANY (ARRAY['alex'::"text", 'elise'::"text", 'joint'::"text"])))),
    CONSTRAINT "wb_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['watching'::"text", 'active'::"text", 'paused'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "wb_subscriptions_tolerance_check" CHECK (("amount_tolerance" >= (0)::numeric))
);


ALTER TABLE "public"."wb_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_subscriptions" IS 'App: Warren Buffet. The record of a recurring service: plan, cadence, prepaid term, auto-renew, review date, billed-through and bundle links, status and notes. The Subscription Label tag stays the per-transaction marker. Charges link through wb_transactions.subscription_id. Insurance gets no row (its merchants are not_subscription). Amounts are positive.';



COMMENT ON COLUMN "public"."wb_subscriptions"."amount_tolerance" IS 'A charge within this many dollars of the current price counts as that price, for linking and for price_change. 0 = exact cents.';



COMMENT ON COLUMN "public"."wb_subscriptions"."term_end_date" IS 'End of a prepaid term. No charge is expected, and none is overdue, before this date.';



COMMENT ON COLUMN "public"."wb_subscriptions"."last_charged_on" IS 'Kept by processing: the Pacific date of the newest posted linked charge.';



COMMENT ON COLUMN "public"."wb_subscriptions"."next_expected_on" IS 'Kept by processing: last_charged_on plus the cadence, or term_end_date when that is later. Null for cadence other with no term.';



COMMENT ON COLUMN "public"."wb_subscriptions"."status" IS 'watching = detected, not yet confirmed; active; paused; cancelled. Cancelled rows get no new charges linked.';



COMMENT ON COLUMN "public"."wb_subscriptions"."interval_count" IS 'Billing interval, with interval_unit: every N weeks or months. Fixed for a named cadence (monthly 1 month, quarterly 3, annual 12); free for cadence other, where null means no next date and never overdue.';



COMMENT ON COLUMN "public"."wb_subscriptions"."interval_unit" IS 'week or month; set together with interval_count.';



CREATE TABLE IF NOT EXISTS "public"."wb_tag_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "exclusive" boolean DEFAULT false NOT NULL,
    "required_for_kinds" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_tag_groups_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_tag_groups_required_kinds_check" CHECK (("required_for_kinds" <@ ARRAY['spend'::"text", 'income'::"text", 'transfer'::"text", 'refund'::"text", 'investment'::"text", 'interest'::"text", 'fee'::"text"]))
);


ALTER TABLE "public"."wb_tag_groups" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_tag_groups" IS 'App: Warren Buffet. Tag groups. An exclusive group allows one tag per split, enforced by a unique index on wb_split_tags; required_for_kinds keeps a transaction of those kinds in the review queue until each of its splits has a tag from the group.';



CREATE TABLE IF NOT EXISTS "public"."wb_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_tags_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_tags_not_own_parent" CHECK ((("parent_id" IS NULL) OR ("parent_id" <> "id")))
);


ALTER TABLE "public"."wb_tags" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_tags" IS 'App: Warren Buffet. Tags within a group. parent_id must be in the same group and never forms a cycle; reports roll children up to their top parent. Deactivate a used tag (is_active = false) rather than delete it.';



CREATE OR REPLACE VIEW "public"."wb_review_queue" WITH ("security_invoker"='true') AS
 WITH "base" AS (
         SELECT "x"."id" AS "transaction_id",
            "x"."account_id",
            COALESCE("a"."display_name", "a"."name") AS "account_label",
            ((COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "txn_date",
            "x"."amount",
            "x"."description",
            "x"."clean_description",
            "x"."payee",
            "x"."merchant_id",
            "m"."name" AS "merchant_name",
            "x"."merchant_source",
            "x"."kind",
            "x"."kind_source",
            "x"."pending",
            "x"."reviewed",
            "x"."transfer_candidate",
            "x"."transfer_pair_id"
           FROM (("public"."wb_transactions" "x"
             JOIN "public"."wb_accounts" "a" ON (("a"."id" = "x"."account_id")))
             LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "x"."merchant_id")))
        ), "reasons" AS (
         SELECT "b_1"."transaction_id",
            'no_kind'::"text" AS "reason",
            NULL::"text" AS "detail",
            NULL::"uuid" AS "planned_match_id"
           FROM "base" "b_1"
          WHERE ("b_1"."kind" IS NULL)
        UNION ALL
         SELECT "b_1"."transaction_id",
            'missing_required_tag'::"text",
            "g"."name",
            NULL::"uuid"
           FROM ("base" "b_1"
             JOIN "public"."wb_tag_groups" "g" ON (("b_1"."kind" = ANY ("g"."required_for_kinds"))))
          WHERE ((NOT "b_1"."pending") AND (NOT "b_1"."reviewed") AND (EXISTS ( SELECT 1
                   FROM "public"."wb_splits" "s"
                  WHERE (("s"."transaction_id" = "b_1"."transaction_id") AND (NOT (EXISTS ( SELECT 1
                           FROM "public"."wb_split_tags" "st"
                          WHERE (("st"."split_id" = "s"."id") AND ("st"."group_id" = "g"."id")))))))))
        UNION ALL
         SELECT "b_1"."transaction_id",
            'transfer_candidate'::"text",
            NULL::"text",
            NULL::"uuid"
           FROM "base" "b_1"
          WHERE ("b_1"."transfer_candidate" AND ("b_1"."transfer_pair_id" IS NULL) AND (NOT "b_1"."pending") AND (NOT "b_1"."reviewed"))
        UNION ALL
         SELECT "b_1"."transaction_id",
            'split_mismatch'::"text",
            "format"('%s split(s) sum to %s'::"text", COALESCE("s"."n", (0)::bigint), COALESCE("s"."total", (0)::numeric)) AS "format",
            NULL::"uuid"
           FROM ("base" "b_1"
             LEFT JOIN LATERAL ( SELECT "count"(*) AS "n",
                    "sum"("sp"."amount") AS "total"
                   FROM "public"."wb_splits" "sp"
                  WHERE ("sp"."transaction_id" = "b_1"."transaction_id")) "s" ON (true))
          WHERE ((COALESCE("s"."n", (0)::bigint) = 0) OR ("s"."total" <> "b_1"."amount"))
        UNION ALL
         SELECT "b_1"."transaction_id",
            'price_change'::"text",
            "format"('%s: expected %s'::"text", "s"."name", "p"."price") AS "format",
            NULL::"uuid"
           FROM ((("base" "b_1"
             JOIN "public"."wb_transactions" "x" ON (("x"."id" = "b_1"."transaction_id")))
             JOIN "public"."wb_subscriptions" "s" ON (("s"."id" = "x"."subscription_id")))
             CROSS JOIN LATERAL ( SELECT "public"."wb_subscription_price_on"("s"."id", "b_1"."txn_date") AS "price") "p")
          WHERE (("s"."status" = 'active'::"text") AND (NOT "b_1"."pending") AND (NOT "b_1"."reviewed") AND ("abs"(((- "b_1"."amount") - "p"."price")) > "s"."amount_tolerance"))
        UNION ALL
         SELECT "lc"."id",
            'new_recurring'::"text",
            "s"."name",
            NULL::"uuid"
           FROM (("public"."wb_subscriptions" "s"
             LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "s"."merchant_id")))
             CROSS JOIN LATERAL ( SELECT "x"."id",
                    "x"."reviewed"
                   FROM "public"."wb_transactions" "x"
                  WHERE (("x"."subscription_id" = "s"."id") AND (NOT "x"."pending"))
                  ORDER BY COALESCE("x"."posted_at", "x"."transacted_at") DESC, "x"."id" DESC
                 LIMIT 1) "lc")
          WHERE (("s"."status" = 'watching'::"text") AND (NOT COALESCE("m"."not_subscription", false)) AND (NOT "lc"."reviewed"))
        UNION ALL
         SELECT "pm_1"."transaction_id",
            'planned_match'::"text",
            "format"('%s, due %s'::"text", "pi_1"."name", "to_char"((COALESCE("pm_1"."occurrence_on", "pi_1"."due_on"))::timestamp with time zone, 'YYYY-MM-DD'::"text")) AS "format",
            "pm_1"."id"
           FROM ("public"."wb_planned_matches" "pm_1"
             JOIN "public"."wb_planned_items" "pi_1" ON (("pi_1"."id" = "pm_1"."planned_item_id")))
          WHERE ("pm_1"."status" = 'suggested'::"text")
        )
 SELECT "r"."reason",
    "r"."detail",
    "b"."transaction_id",
    "b"."account_id",
    "b"."account_label",
    "b"."txn_date",
    "b"."amount",
    "b"."description",
    "b"."clean_description",
    "b"."payee",
    "b"."merchant_id",
    "b"."merchant_name",
    "b"."merchant_source",
    "b"."kind",
    "b"."kind_source",
    "b"."pending",
    "b"."reviewed",
    "b"."transfer_candidate",
    "b"."transfer_pair_id",
    COALESCE(( SELECT "array_agg"(DISTINCT "tg"."name" ORDER BY "tg"."name") AS "array_agg"
           FROM (("public"."wb_splits" "s"
             JOIN "public"."wb_split_tags" "st" ON (("st"."split_id" = "s"."id")))
             JOIN "public"."wb_tags" "tg" ON (("tg"."id" = "st"."tag_id")))
          WHERE ("s"."transaction_id" = "b"."transaction_id")), '{}'::"text"[]) AS "tag_names",
    "r"."planned_match_id",
    "pm"."planned_item_id",
    "pi"."name" AS "planned_item_name",
    COALESCE("pm"."occurrence_on", "pi"."due_on") AS "planned_on",
    "pi"."amount" AS "planned_amount",
    "pm"."amount_applied" AS "match_amount",
    "pi"."amount_tolerance" AS "planned_tolerance",
    "pi"."match_window_days" AS "planned_window_days"
   FROM ((("reasons" "r"
     JOIN "base" "b" ON (("b"."transaction_id" = "r"."transaction_id")))
     LEFT JOIN "public"."wb_planned_matches" "pm" ON (("pm"."id" = "r"."planned_match_id")))
     LEFT JOIN "public"."wb_planned_items" "pi" ON (("pi"."id" = "pm"."planned_item_id")));


ALTER VIEW "public"."wb_review_queue" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_review_queue" IS 'App: Warren Buffet. One row per transaction and reason: no_kind, missing_required_tag (detail = group), transfer_candidate, split_mismatch, price_change (detail = subscription and expected price; active subscriptions, cleared by recording the new price or marking reviewed), new_recurring (detail = subscription; the newest charge of a watching subscription while it is unreviewed: "Keep watching" marks it reviewed, the next charge brings it back; confirming or dismissing ends it) and planned_match (one row per suggested planned match, detail = planned item and due date; planned_match_id and the planned_* and match_amount columns describe it; confirming or rejecting ends it). Tag, transfer and price reasons cover posted, unreviewed rows only; split_mismatch and planned_match show even when reviewed. security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_rule_health_acks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "finding" "text" NOT NULL,
    "subject_id" "uuid" NOT NULL,
    "acked_n" integer NOT NULL,
    "reason" "text" NOT NULL,
    "acked_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_rule_health_acks_finding_check" CHECK (("finding" = ANY (ARRAY['never_fires'::"text", 'too_broad'::"text", 'often_overridden'::"text", 'duplicate_rules'::"text", 'rule_missing'::"text", 'merchant_no_category'::"text"]))),
    CONSTRAINT "wb_rule_health_acks_n_check" CHECK (("acked_n" >= 0)),
    CONSTRAINT "wb_rule_health_acks_reason_check" CHECK (("btrim"("reason") <> ''::"text"))
);


ALTER TABLE "public"."wb_rule_health_acks" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_rule_health_acks" IS 'App: Warren Buffet. A rule-health finding acknowledged as deliberate: one row per finding and subject (subject_id is the rule for never_fires and often_overridden, the merchant for the merchant-level findings), with the finding''s n when acknowledged and why. The finding stays hidden from wb_rule_health until its n grows past acked_n. Deleting the row un-acknowledges it.';



COMMENT ON COLUMN "public"."wb_rule_health_acks"."acked_n" IS 'The finding''s n when it was acknowledged; a larger n shows the finding again.';



CREATE TABLE IF NOT EXISTS "public"."wb_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "match" "jsonb" NOT NULL,
    "set_kind" "text",
    "set_merchant_id" "uuid",
    "add_tag_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "created_by" "text" NOT NULL,
    "hit_count" integer DEFAULT 0 NOT NULL,
    "last_hit_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_from_transaction_id" "uuid",
    "set_project_id" "uuid",
    CONSTRAINT "wb_rules_created_by_check" CHECK (("created_by" = ANY (ARRAY['claude'::"text", 'manual'::"text"]))),
    CONSTRAINT "wb_rules_match_check" CHECK ((("jsonb_typeof"("match") = 'object'::"text") AND ("match" <> '{}'::"jsonb") AND (("match" - ARRAY['merchant_id'::"text", 'payee_contains'::"text", 'description_contains'::"text", 'account_ids'::"text", 'amount_min'::"text", 'amount_max'::"text", 'kind'::"text"]) = '{}'::"jsonb") AND ((NOT ("match" ? 'merchant_id'::"text")) OR ("jsonb_typeof"(("match" -> 'merchant_id'::"text")) = 'string'::"text")) AND ((NOT ("match" ? 'payee_contains'::"text")) OR ("length"("btrim"(("match" ->> 'payee_contains'::"text"))) > 0)) AND ((NOT ("match" ? 'description_contains'::"text")) OR ("length"("btrim"(("match" ->> 'description_contains'::"text"))) > 0)) AND ((NOT ("match" ? 'account_ids'::"text")) OR ("jsonb_typeof"(("match" -> 'account_ids'::"text")) = 'array'::"text")) AND ((NOT ("match" ? 'amount_min'::"text")) OR ("jsonb_typeof"(("match" -> 'amount_min'::"text")) = 'number'::"text")) AND ((NOT ("match" ? 'amount_max'::"text")) OR ("jsonb_typeof"(("match" -> 'amount_max'::"text")) = 'number'::"text")) AND ((NOT ("match" ? 'kind'::"text")) OR (("match" ->> 'kind'::"text") = ANY (ARRAY['spend'::"text", 'income'::"text", 'transfer'::"text", 'refund'::"text", 'investment'::"text", 'interest'::"text", 'fee'::"text"]))))),
    CONSTRAINT "wb_rules_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "wb_rules_set_kind_check" CHECK ((("set_kind" IS NULL) OR ("set_kind" = ANY (ARRAY['spend'::"text", 'income'::"text", 'transfer'::"text", 'refund'::"text", 'investment'::"text", 'interest'::"text", 'fee'::"text"]))))
);


ALTER TABLE "public"."wb_rules" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_rules" IS 'App: Warren Buffet. Categorization rules, run by wb_process_transactions in priority order (lower first, ties oldest first). All keys present in match must match. A rule never overwrites a claude or manual kind, merchant or tag; in an exclusive group the first rule wins. hit_count and last_hit_at are computed from wb_transactions.matched_rule_ids.';



COMMENT ON COLUMN "public"."wb_rules"."match" IS 'Keys: merchant_id, payee_contains, description_contains (raw or clean), account_ids (array), amount_min / amount_max (absolute amount, inclusive), kind.';



COMMENT ON COLUMN "public"."wb_rules"."last_hit_at" IS 'Date of the newest transaction this rule matches.';



COMMENT ON COLUMN "public"."wb_rules"."created_from_transaction_id" IS 'The transaction an "Always do this" fix was made from (spec §6.1). Null for rules written directly.';



COMMENT ON COLUMN "public"."wb_rules"."set_project_id" IS 'Optional project the rule puts on a single-split transaction. The first matching rule wins; a project set or removed by hand or by Claude is never changed.';



CREATE TABLE IF NOT EXISTS "public"."wb_tag_exclusions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL,
    "rule_id" "uuid",
    "source" "text" NOT NULL,
    "removed_by" "uuid" DEFAULT "auth"."uid"(),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_tag_exclusions_source_check" CHECK (("source" = ANY (ARRAY['claude'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."wb_tag_exclusions" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_tag_exclusions" IS 'App: Warren Buffet. Tags removed from a transaction by hand (or by Claude), so no rule puts them back. One row per transaction and tag, with the rule that had applied it (if any), the source, who (removed_by) and when (created_at). Adding the tag back by hand deletes the row. user_id and context_id are copied from the transaction by trigger.';



COMMENT ON COLUMN "public"."wb_tag_exclusions"."removed_by" IS 'The signed-in user who removed the tag; null when the SQL editor or the service role did it.';



CREATE OR REPLACE VIEW "public"."wb_rule_health_all" WITH ("security_invoker"='true') AS
 WITH "findings" AS (
         WITH "rule_merchant" AS (
                 SELECT "r"."id",
                    "r"."user_id",
                    "r"."context_id",
                    "r"."name",
                    "r"."priority",
                    "r"."active",
                    "r"."match",
                    "r"."set_kind",
                    "r"."set_merchant_id",
                    "r"."add_tag_ids",
                    "r"."created_by",
                    "r"."hit_count",
                    "r"."last_hit_at",
                    "r"."notes",
                    "r"."created_at",
                    "r"."updated_at",
                    "r"."created_from_transaction_id",
                    (("r"."match" ->> 'merchant_id'::"text"))::"uuid" AS "merchant_id"
                   FROM "public"."wb_rules" "r"
                  WHERE "r"."active"
                ), "hits" AS (
                 SELECT "r"."id" AS "rule_id",
                    "x"."id" AS "transaction_id",
                    "x"."kind",
                    "x"."kind_source"
                   FROM ("rule_merchant" "r"
                     JOIN "public"."wb_transactions" "x" ON ((("r"."id" = ANY ("x"."matched_rule_ids")) AND (NOT "x"."pending"))))
                ), "overrides" AS (
                 SELECT "h"."rule_id",
                    "h"."transaction_id",
                    (EXISTS ( SELECT 1
                           FROM (("public"."wb_splits" "s"
                             JOIN "public"."wb_split_tags" "st" ON (("st"."split_id" = "s"."id")))
                             JOIN "public"."wb_tags" "rt" ON (("rt"."id" = ANY ("r"."add_tag_ids"))))
                          WHERE (("s"."transaction_id" = "h"."transaction_id") AND ("st"."source" = ANY (ARRAY['claude'::"text", 'manual'::"text"])) AND "st"."group_exclusive" AND ("st"."group_id" = "rt"."group_id") AND ("st"."tag_id" <> ALL ("r"."add_tag_ids"))))) AS "tag_swap",
                    (EXISTS ( SELECT 1
                           FROM "public"."wb_tag_exclusions" "e"
                          WHERE (("e"."transaction_id" = "h"."transaction_id") AND ("e"."rule_id" = "h"."rule_id")))) AS "tag_removed",
                    (("r"."set_kind" IS NOT NULL) AND ("h"."kind_source" = ANY (ARRAY['claude'::"text", 'manual'::"text"])) AND ("h"."kind" IS DISTINCT FROM "r"."set_kind")) AS "kind_changed",
                    (("cardinality"("r"."add_tag_ids") > 0) AND (( SELECT "count"(*) AS "count"
                           FROM "public"."wb_splits" "s"
                          WHERE ("s"."transaction_id" = "h"."transaction_id")) > 1)) AS "re_split"
                   FROM ("hits" "h"
                     JOIN "rule_merchant" "r" ON (("r"."id" = "h"."rule_id")))
                ), "payee_keys" AS (
                 SELECT "x"."merchant_id",
                    NULLIF("btrim"("regexp_replace"("regexp_replace"("split_part"("lower"(COALESCE(NULLIF("btrim"("x"."payee"), ''::"text"), "x"."clean_description", ''::"text")), '*'::"text", 1), '[0-9]'::"text", ''::"text", 'g'::"text"), '\s+'::"text", ' '::"text", 'g'::"text")), ''::"text") AS "payee"
                   FROM "public"."wb_transactions" "x"
                  WHERE (("x"."merchant_id" IS NOT NULL) AND (NOT "x"."pending"))
                ), "merchant_payees" AS (
                 SELECT "k"."merchant_id",
                    ("count"(*))::integer AS "n_txns",
                    COALESCE("array_agg"(DISTINCT "k"."payee") FILTER (WHERE ("k"."payee" IS NOT NULL)), '{}'::"text"[]) AS "payees"
                   FROM "payee_keys" "k"
                  GROUP BY "k"."merchant_id"
                )
         SELECT 'never_fires'::"text" AS "finding",
            "r"."id" AS "rule_id",
            "r"."name" AS "rule_name",
            "r"."merchant_id",
            "m"."name" AS "merchant_name",
            0 AS "n",
            NULL::integer AS "of_n",
            "format"('No match since it was created on %s.'::"text", (("r"."created_at" AT TIME ZONE 'America/Los_Angeles'::"text"))::"date") AS "detail"
           FROM ("rule_merchant" "r"
             LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "r"."merchant_id")))
          WHERE (("r"."hit_count" = 0) AND ("r"."created_at" < ("now"() - '14 days'::interval)) AND (COALESCE("r"."notes", ''::"text") !~* '(quarter|annual|yearly)'::"text") AND (NOT (EXISTS ( SELECT 1
                   FROM "public"."wb_subscriptions" "s"
                  WHERE (("s"."merchant_id" = "r"."merchant_id") AND ("s"."status" <> 'cancelled'::"text") AND ((("s"."interval_unit" = 'month'::"text") AND ("s"."interval_count" >= 3)) OR (("s"."interval_unit" = 'week'::"text") AND ("s"."interval_count" >= 13))))))))
        UNION ALL
         SELECT 'too_broad'::"text",
            NULL::"uuid",
            NULL::"text",
            "mp"."merchant_id",
            "m"."name",
            "cardinality"("mp"."payees") AS "cardinality",
            "mp"."n_txns",
            ('Payees: '::"text" || "array_to_string"(( SELECT "array_agg"("p"."p" ORDER BY "p"."p") AS "array_agg"
                   FROM "unnest"("mp"."payees") "p"("p")), '; '::"text"))
           FROM ("merchant_payees" "mp"
             JOIN "public"."wb_merchants" "m" ON (("m"."id" = "mp"."merchant_id")))
          WHERE (("cardinality"("mp"."payees") >= 3) AND (EXISTS ( SELECT 1
                   FROM "rule_merchant" "r"
                  WHERE ("r"."merchant_id" = "mp"."merchant_id"))))
        UNION ALL
         SELECT 'often_overridden'::"text",
            "r"."id",
            "r"."name",
            "r"."merchant_id",
            "m"."name",
            "o"."n",
            "o"."of_n",
            "concat_ws"(', '::"text",
                CASE
                    WHEN ("o"."swaps" > 0) THEN "format"('%s tag swapped'::"text", "o"."swaps")
                    ELSE NULL::"text"
                END,
                CASE
                    WHEN ("o"."removals" > 0) THEN "format"('%s tag removed'::"text", "o"."removals")
                    ELSE NULL::"text"
                END,
                CASE
                    WHEN ("o"."kinds" > 0) THEN "format"('%s kind changed'::"text", "o"."kinds")
                    ELSE NULL::"text"
                END,
                CASE
                    WHEN ("o"."splits" > 0) THEN "format"('%s re-split'::"text", "o"."splits")
                    ELSE NULL::"text"
                END) AS "concat_ws"
           FROM (("rule_merchant" "r"
             LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "r"."merchant_id")))
             JOIN LATERAL ( SELECT ("count"(*) FILTER (WHERE ("ov"."tag_swap" OR "ov"."tag_removed" OR "ov"."kind_changed" OR "ov"."re_split")))::integer AS "n",
                    (( SELECT "count"(*) AS "count"
                           FROM "hits" "h"
                          WHERE ("h"."rule_id" = "r"."id")))::integer AS "of_n",
                    ("count"(*) FILTER (WHERE "ov"."tag_swap"))::integer AS "swaps",
                    ("count"(*) FILTER (WHERE "ov"."tag_removed"))::integer AS "removals",
                    ("count"(*) FILTER (WHERE "ov"."kind_changed"))::integer AS "kinds",
                    ("count"(*) FILTER (WHERE "ov"."re_split"))::integer AS "splits"
                   FROM "overrides" "ov"
                  WHERE ("ov"."rule_id" = "r"."id")) "o" ON (true))
          WHERE (("o"."n" >= 2) AND (("o"."n" * 4) >= "o"."of_n"))
        UNION ALL
         SELECT 'duplicate_rules'::"text",
            NULL::"uuid",
            NULL::"text",
            "r"."merchant_id",
            "m"."name",
            ("count"(*))::integer AS "count",
            NULL::integer,
            ('Rules: '::"text" || "string_agg"("r"."name", '; '::"text" ORDER BY "r"."priority", "r"."created_at"))
           FROM ("rule_merchant" "r"
             LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "r"."merchant_id")))
          WHERE ("r"."merchant_id" IS NOT NULL)
          GROUP BY "r"."merchant_id", "m"."name"
         HAVING ("count"(*) >= 2)
        UNION ALL
         SELECT 'rule_missing'::"text",
            NULL::"uuid",
            NULL::"text",
            "m"."id",
            "m"."name",
            "t"."n",
            NULL::integer,
            "format"('%s transactions tagged by hand or by Claude, and no rule.'::"text", "t"."n") AS "format"
           FROM ("public"."wb_merchants" "m"
             JOIN LATERAL ( SELECT ("count"(DISTINCT "x"."id"))::integer AS "n"
                   FROM (("public"."wb_transactions" "x"
                     JOIN "public"."wb_splits" "s" ON (("s"."transaction_id" = "x"."id")))
                     JOIN "public"."wb_split_tags" "st" ON (("st"."split_id" = "s"."id")))
                  WHERE (("x"."merchant_id" = "m"."id") AND (NOT "x"."pending") AND ("st"."source" = ANY (ARRAY['claude'::"text", 'manual'::"text"])))) "t" ON (true))
          WHERE (("t"."n" >= 3) AND (NOT (EXISTS ( SELECT 1
                   FROM "rule_merchant" "r"
                  WHERE ("r"."merchant_id" = "m"."id")))))
        UNION ALL
         SELECT 'merchant_no_category'::"text",
            NULL::"uuid",
            NULL::"text",
            "m"."id",
            "m"."name",
            "c"."n",
            NULL::integer,
            "format"('%s spend transactions, none with a Category.'::"text", "c"."n") AS "format"
           FROM ("public"."wb_merchants" "m"
             JOIN LATERAL ( SELECT ("count"(*))::integer AS "n",
                    "bool_or"((EXISTS ( SELECT 1
                           FROM (("public"."wb_splits" "s"
                             JOIN "public"."wb_split_tags" "st" ON (("st"."split_id" = "s"."id")))
                             JOIN "public"."wb_tag_groups" "g" ON (("g"."id" = "st"."group_id")))
                          WHERE (("s"."transaction_id" = "x"."id") AND ("g"."name" = 'Category'::"text"))))) AS "any_category"
                   FROM "public"."wb_transactions" "x"
                  WHERE (("x"."merchant_id" = "m"."id") AND (NOT "x"."pending") AND ("x"."kind" = ANY (ARRAY['spend'::"text", 'refund'::"text", 'fee'::"text"])))) "c" ON (true))
          WHERE (("c"."n" > 0) AND (NOT COALESCE("c"."any_category", false)))
        )
 SELECT "f"."finding",
    "f"."rule_id",
    "f"."rule_name",
    "f"."merchant_id",
    "f"."merchant_name",
    "f"."n",
    "f"."of_n",
    "f"."detail",
    COALESCE("f"."rule_id", "f"."merchant_id") AS "subject_id",
    (("a"."id" IS NOT NULL) AND ("f"."n" <= "a"."acked_n")) AS "acknowledged",
    "a"."acked_n",
    "a"."reason" AS "ack_reason",
    "a"."updated_at" AS "acked_at"
   FROM ("findings" "f"
     LEFT JOIN "public"."wb_rule_health_acks" "a" ON ((("a"."finding" = "f"."finding") AND ("a"."subject_id" = COALESCE("f"."rule_id", "f"."merchant_id")))));


ALTER VIEW "public"."wb_rule_health_all" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_rule_health_all" IS 'App: Warren Buffet. Every rule-health finding (see wb_rule_health) with subject_id (the rule, else the merchant) and its acknowledgement: acknowledged is true while n has not grown past acked_n, with ack_reason and acked_at. security_invoker, so wb_ RLS applies.';



CREATE OR REPLACE VIEW "public"."wb_rule_health" WITH ("security_invoker"='true') AS
 SELECT "finding",
    "rule_id",
    "rule_name",
    "merchant_id",
    "merchant_name",
    "n",
    "of_n",
    "detail"
   FROM "public"."wb_rule_health_all"
  WHERE (NOT "acknowledged");


ALTER VIEW "public"."wb_rule_health" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_rule_health" IS 'App: Warren Buffet. One row per finding not acknowledged (finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail): never_fires, too_broad (merchant-level: 3+ distinct normalized payees on a merchant with a rule), often_overridden (n of of_n hits beaten by hand, at least 2 and 25%), duplicate_rules, rule_missing, merchant_no_category. An acknowledged finding (wb_rule_health_acks) is hidden until its n grows past the acknowledged n; wb_rule_health_all has them all. Read by get_wb_rule_health and the weekly cleanup task, which proposes fixes and never writes them. security_invoker, so wb_ RLS applies.';



CREATE OR REPLACE VIEW "public"."wb_spending_by_tag" WITH ("security_invoker"='true') AS
 WITH RECURSIVE "tag_top" AS (
         SELECT "t"."id" AS "tag_id",
            "t"."id" AS "top_id"
           FROM "public"."wb_tags" "t"
          WHERE ("t"."parent_id" IS NULL)
        UNION ALL
         SELECT "c"."id",
            "tt"."top_id"
           FROM ("public"."wb_tags" "c"
             JOIN "tag_top" "tt" ON (("c"."parent_id" = "tt"."tag_id")))
        ), "spend_splits" AS (
         SELECT "s"."id" AS "split_id",
            "s"."amount",
            ("date_trunc"('month'::"text", (COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text")))::"date" AS "month"
           FROM ("public"."wb_splits" "s"
             JOIN "public"."wb_transactions" "x" ON (("x"."id" = "s"."transaction_id")))
          WHERE (("x"."kind" = ANY (ARRAY['spend'::"text", 'refund'::"text", 'fee'::"text"])) AND (NOT "x"."pending"))
        ), "tagged" AS (
         SELECT "ss"."month",
            "ss"."split_id",
            "ss"."amount",
            "st"."group_id",
            "st"."tag_id",
            "tt"."top_id"
           FROM (("spend_splits" "ss"
             JOIN "public"."wb_split_tags" "st" ON (("st"."split_id" = "ss"."split_id")))
             JOIN "tag_top" "tt" ON (("tt"."tag_id" = "st"."tag_id")))
        )
 SELECT "tg"."month",
    "g"."id" AS "group_id",
    "g"."name" AS "group_name",
    'leaf'::"text" AS "level",
    "t"."id" AS "tag_id",
    "t"."name" AS "tag_name",
    "sum"("tg"."amount") AS "amount",
    "count"(DISTINCT "tg"."split_id") AS "splits"
   FROM (("tagged" "tg"
     JOIN "public"."wb_tag_groups" "g" ON (("g"."id" = "tg"."group_id")))
     JOIN "public"."wb_tags" "t" ON (("t"."id" = "tg"."tag_id")))
  GROUP BY "tg"."month", "g"."id", "g"."name", "t"."id", "t"."name"
UNION ALL
 SELECT "tg"."month",
    "g"."id" AS "group_id",
    "g"."name" AS "group_name",
    'top'::"text" AS "level",
    "t"."id" AS "tag_id",
    "t"."name" AS "tag_name",
    "sum"("tg"."amount") AS "amount",
    "count"(DISTINCT "tg"."split_id") AS "splits"
   FROM (("tagged" "tg"
     JOIN "public"."wb_tag_groups" "g" ON (("g"."id" = "tg"."group_id")))
     JOIN "public"."wb_tags" "t" ON (("t"."id" = "tg"."top_id")))
  GROUP BY "tg"."month", "g"."id", "g"."name", "t"."id", "t"."name"
UNION ALL
 SELECT "ss"."month",
    "g"."id" AS "group_id",
    "g"."name" AS "group_name",
    "lvl"."level",
    NULL::"uuid" AS "tag_id",
    NULL::"text" AS "tag_name",
    "sum"("ss"."amount") AS "amount",
    "count"(*) AS "splits"
   FROM (("spend_splits" "ss"
     CROSS JOIN "public"."wb_tag_groups" "g")
     CROSS JOIN ( VALUES ('leaf'::"text"), ('top'::"text")) "lvl"("level"))
  WHERE ("g"."exclusive" AND (NOT (EXISTS ( SELECT 1
           FROM "public"."wb_split_tags" "st"
          WHERE (("st"."split_id" = "ss"."split_id") AND ("st"."group_id" = "g"."id"))))))
  GROUP BY "ss"."month", "g"."id", "g"."name", "lvl"."level";


ALTER VIEW "public"."wb_spending_by_tag" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_spending_by_tag" IS 'App: Warren Buffet. Per month, group and tag, the sum of split amounts for kinds spend, refund and fee (posted rows; negative = money out). level leaf = the tag itself, top = rolled up to its top parent. Exclusive groups also have an untagged row (tag_id null), so their rows add up to total spending; in open groups a split with two tags counts under both. security_invoker, so wb_ RLS applies.';



CREATE OR REPLACE VIEW "public"."wb_subscription_outflows" WITH ("security_invoker"='true') AS
 SELECT "o"."subscription_id",
    "o"."name",
    "o"."occurrence_on",
    "o"."amount",
    "o"."overdue_charge"
   FROM (( SELECT (("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "d",
            COALESCE(( SELECT "wb_settings"."horizon_months"
                   FROM "public"."wb_settings"
                  ORDER BY "wb_settings"."created_at"
                 LIMIT 1), 12) AS "h") "t"
     CROSS JOIN LATERAL "public"."wb_subscription_occurrences"("t"."d", ((("t"."d" + "make_interval"("months" => "t"."h")))::"date" - 1), "t"."d") "o"("subscription_id", "name", "occurrence_on", "amount", "overdue_charge"));


ALTER VIEW "public"."wb_subscription_outflows" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_subscription_outflows" IS 'App: Warren Buffet. Expected subscription charges from today across the horizon (wb_settings.horizon_months, else 12): wb_subscription_occurrences for today. security_invoker, so wb_ RLS applies.';



CREATE TABLE IF NOT EXISTS "public"."wb_subscription_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "context_id" "text" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "effective_on" "date" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "transaction_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wb_subscription_prices_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "wb_subscription_prices_source_check" CHECK (("source" = ANY (ARRAY['detected'::"text", 'claude'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."wb_subscription_prices" OWNER TO "postgres";


COMMENT ON TABLE "public"."wb_subscription_prices" IS 'App: Warren Buffet. One row per price change of a subscription, positive amounts. The price on a date is the newest row on or before it (else the oldest row, else expected_amount). A charge that differs by more than amount_tolerance is flagged price_change in wb_review_queue, never accepted automatically: recording the new price here clears it. user_id and context_id are copied from the subscription by trigger.';



CREATE OR REPLACE VIEW "public"."wb_subscription_overview" WITH ("security_invoker"='true') AS
 WITH "today" AS (
         SELECT (("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "d"
        )
 SELECT "s"."id",
    "s"."name",
    "s"."plan",
    "s"."status",
    "s"."cadence",
    "s"."merchant_id",
    "m"."name" AS "merchant_name",
    COALESCE("m"."not_subscription", false) AS "merchant_not_subscription",
    "s"."billed_through_id",
    "bt"."name" AS "billed_through_name",
    "s"."bundle_id",
    "bu"."name" AS "bundle_name",
    "public"."wb_subscription_price_on"("s"."id", "today"."d") AS "current_price",
    "pr"."previous_price",
    "pr"."last_change_on",
    "pr"."price_count",
    "s"."expected_amount",
    "s"."amount_tolerance",
    "s"."term_end_date",
    "s"."auto_renew",
    "s"."review_date",
    "s"."last_charged_on",
    "s"."next_expected_on",
    (( SELECT "count"(*) AS "count"
           FROM "public"."wb_transactions" "x"
          WHERE (("x"."subscription_id" = "s"."id") AND (NOT "x"."pending"))))::integer AS "charge_count",
    (("s"."status" = 'active'::"text") AND ("s"."next_expected_on" IS NOT NULL) AND ("today"."d" > ("s"."next_expected_on" + 7)) AND (("s"."term_end_date" IS NULL) OR (("today"."d" > "s"."term_end_date") AND ("s"."auto_renew" IS NOT FALSE)))) AS "overdue",
        CASE
            WHEN ("s"."next_expected_on" IS NOT NULL) THEN ("today"."d" - "s"."next_expected_on")
            ELSE NULL::integer
        END AS "days_past_expected",
    "s"."owner",
    "s"."notes",
    "s"."created_at",
    "s"."updated_at",
    "s"."interval_count",
    "s"."interval_unit"
   FROM ((((("public"."wb_subscriptions" "s"
     CROSS JOIN "today")
     LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "s"."merchant_id")))
     LEFT JOIN "public"."wb_subscriptions" "bt" ON (("bt"."id" = "s"."billed_through_id")))
     LEFT JOIN "public"."wb_subscriptions" "bu" ON (("bu"."id" = "s"."bundle_id")))
     LEFT JOIN LATERAL ( SELECT ("count"(*))::integer AS "price_count",
            ("array_agg"("p"."amount" ORDER BY "p"."effective_on" DESC))[2] AS "previous_price",
                CASE
                    WHEN ("count"(*) > 1) THEN "max"("p"."effective_on")
                    ELSE NULL::"date"
                END AS "last_change_on"
           FROM "public"."wb_subscription_prices" "p"
          WHERE (("p"."subscription_id" = "s"."id") AND ("p"."effective_on" <= "today"."d"))) "pr" ON (true));


ALTER VIEW "public"."wb_subscription_overview" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_subscription_overview" IS 'App: Warren Buffet. One row per subscription with merchant, billed-through and bundle names, current_price (today), previous_price and last_change_on, charge_count, the billing interval (interval_count, interval_unit), and overdue: active, more than 7 days past next_expected_on, and not before term_end_date (after it, only when auto_renew is not false). Cadence other with no interval has no next date and is never overdue. Missing charges live here, not in wb_review_queue. security_invoker, so wb_ RLS applies.';



CREATE OR REPLACE VIEW "public"."wb_transaction_list" WITH ("security_invoker"='true') AS
 SELECT "x"."id",
    "x"."account_id",
    COALESCE("a"."display_name", "a"."name") AS "account_label",
    "x"."posted_at",
    "x"."transacted_at",
    ((COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "txn_date",
    "x"."amount",
    "x"."description",
    "x"."clean_description",
    "x"."payee",
    "x"."memo",
    "x"."mcc",
    "x"."pending",
    "x"."merchant_id",
    "m"."name" AS "merchant_name",
    "x"."merchant_source",
    "x"."kind",
    "x"."kind_source",
    "x"."transfer_pair_id",
    "x"."transfer_candidate",
    "x"."reviewed",
    "x"."processed_at",
    "x"."first_seen_at",
    "x"."last_seen_at",
    COALESCE(( SELECT "array_agg"(DISTINCT "tg"."name" ORDER BY "tg"."name") AS "array_agg"
           FROM (("public"."wb_splits" "s"
             JOIN "public"."wb_split_tags" "st" ON (("st"."split_id" = "s"."id")))
             JOIN "public"."wb_tags" "tg" ON (("tg"."id" = "st"."tag_id")))
          WHERE ("s"."transaction_id" = "x"."id")), '{}'::"text"[]) AS "tag_names",
    (( SELECT "count"(*) AS "count"
           FROM "public"."wb_splits" "s"
          WHERE ("s"."transaction_id" = "x"."id")))::integer AS "split_count",
    ((("x"."kind" IS NULL) OR ((NOT "x"."pending") AND (NOT "x"."reviewed") AND "x"."transfer_candidate" AND ("x"."transfer_pair_id" IS NULL)) OR ((NOT "x"."pending") AND (NOT "x"."reviewed") AND (EXISTS ( SELECT 1
           FROM ("public"."wb_tag_groups" "g"
             JOIN "public"."wb_splits" "s" ON (("s"."transaction_id" = "x"."id")))
          WHERE (("x"."kind" = ANY ("g"."required_for_kinds")) AND (NOT (EXISTS ( SELECT 1
                   FROM "public"."wb_split_tags" "st"
                  WHERE (("st"."split_id" = "s"."id") AND ("st"."group_id" = "g"."id"))))))))) OR (COALESCE(( SELECT "sum"("s"."amount") AS "sum"
           FROM "public"."wb_splits" "s"
          WHERE ("s"."transaction_id" = "x"."id")), (0)::numeric) <> "x"."amount") OR ((NOT "x"."pending") AND (NOT "x"."reviewed") AND ("sub"."status" = 'active'::"text") AND ("abs"(((- "x"."amount") - "public"."wb_subscription_price_on"("sub"."id", ((COALESCE("x"."posted_at", "x"."transacted_at") AT TIME ZONE 'America/Los_Angeles'::"text"))::"date"))) > "sub"."amount_tolerance")) OR ((NOT "x"."pending") AND (NOT "x"."reviewed") AND ("sub"."status" = 'watching'::"text") AND (NOT COALESCE(( SELECT "sm"."not_subscription"
           FROM "public"."wb_merchants" "sm"
          WHERE ("sm"."id" = "sub"."merchant_id")), false)) AND ("x"."id" = ( SELECT "y"."id"
           FROM "public"."wb_transactions" "y"
          WHERE (("y"."subscription_id" = "sub"."id") AND (NOT "y"."pending"))
          ORDER BY COALESCE("y"."posted_at", "y"."transacted_at") DESC, "y"."id" DESC
         LIMIT 1))) OR (EXISTS ( SELECT 1
           FROM "public"."wb_planned_matches" "pm"
          WHERE (("pm"."transaction_id" = "x"."id") AND ("pm"."status" = 'suggested'::"text"))))) IS TRUE) AS "needs_review",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('tag_id', "e"."tag_id", 'tag_name', "tg"."name", 'rule_id', "e"."rule_id", 'source', "e"."source", 'removed_at', "e"."created_at") ORDER BY "tg"."name") AS "jsonb_agg"
           FROM ("public"."wb_tag_exclusions" "e"
             JOIN "public"."wb_tags" "tg" ON (("tg"."id" = "e"."tag_id")))
          WHERE ("e"."transaction_id" = "x"."id")), '[]'::"jsonb") AS "excluded_tags",
    "x"."notes",
    "x"."subscription_id",
    "x"."subscription_source",
    "sub"."name" AS "subscription_name",
    COALESCE(( SELECT "array_agg"(DISTINCT "p"."name" ORDER BY "p"."name") AS "array_agg"
           FROM ("public"."wb_splits" "s"
             JOIN "public"."wb_projects" "p" ON (("p"."id" = "s"."project_id")))
          WHERE ("s"."transaction_id" = "x"."id")), '{}'::"text"[]) AS "project_names"
   FROM ((("public"."wb_transactions" "x"
     JOIN "public"."wb_accounts" "a" ON (("a"."id" = "x"."account_id")))
     LEFT JOIN "public"."wb_merchants" "m" ON (("m"."id" = "x"."merchant_id")))
     LEFT JOIN "public"."wb_subscriptions" "sub" ON (("sub"."id" = "x"."subscription_id")));


ALTER VIEW "public"."wb_transaction_list" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_transaction_list" IS 'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue, including a suggested planned match), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at), notes, the linked subscription (subscription_id, subscription_source, subscription_name), and project_names (text[], the projects on any of its splits). No raw jsonb. security_invoker, so wb_ RLS applies.';



CREATE OR REPLACE VIEW "public"."wb_true_cost" WITH ("security_invoker"='true') AS
 WITH "t" AS (
         SELECT (("now"() AT TIME ZONE 'America/Los_Angeles'::"text"))::"date" AS "d"
        ), "burn" AS (
         SELECT "max"("b"."burn_median") AS "median",
            "max"("b"."burn_mean") AS "mean"
           FROM "public"."wb_burn_rate_on"(( SELECT "t"."d"
                   FROM "t")) "b"("month", "included", "project_excluded", "matched_excluded", "subscription_excluded", "burn_median", "burn_mean")
        ), "subs" AS (
         SELECT COALESCE("sum"("round"("public"."wb_monthly_equivalent"((- "public"."wb_subscription_price_on"("s"."id", "t"."d")), "s"."interval_count", "s"."interval_unit"), 2)), (0)::numeric) AS "monthly"
           FROM ("public"."wb_subscriptions" "s"
             CROSS JOIN "t")
          WHERE (("s"."status" = 'active'::"text") AND ("s"."interval_count" IS NOT NULL) AND ("public"."wb_subscription_price_on"("s"."id", "t"."d") IS NOT NULL))
        ), "planned" AS (
         SELECT COALESCE("sum"("round"("public"."wb_monthly_equivalent"("pi"."amount", "pi"."interval_count", "pi"."interval_unit"), 2)) FILTER (WHERE ("pi"."amount" < (0)::numeric)), (0)::numeric) AS "out_monthly",
            COALESCE("sum"("round"("public"."wb_monthly_equivalent"("pi"."amount", "pi"."interval_count", "pi"."interval_unit"), 2)) FILTER (WHERE ("pi"."amount" > (0)::numeric)), (0)::numeric) AS "income_monthly"
           FROM ("public"."wb_planned_items" "pi"
             CROSS JOIN "t")
          WHERE (("pi"."interval_count" IS NOT NULL) AND (NOT "pi"."is_draft") AND (("pi"."ends_on" IS NULL) OR ("pi"."ends_on" >= "t"."d")))
        )
 SELECT "burn"."median" AS "burn_monthly",
    "burn"."mean" AS "burn_mean",
    "subs"."monthly" AS "subscriptions_monthly",
    "planned"."out_monthly" AS "recurring_out_monthly",
    ((COALESCE("burn"."median", (0)::numeric) + "subs"."monthly") + "planned"."out_monthly") AS "true_cost_monthly",
    "planned"."income_monthly" AS "expected_income_monthly",
    ((("planned"."income_monthly" + COALESCE("burn"."median", (0)::numeric)) + "subs"."monthly") + "planned"."out_monthly") AS "net_monthly"
   FROM "burn",
    "subs",
    "planned";


ALTER VIEW "public"."wb_true_cost" OWNER TO "postgres";


COMMENT ON VIEW "public"."wb_true_cost" IS 'App: Warren Buffet. Monthly true cost (negative, money out) = burn rate (median) + active subscriptions as a monthly amount + recurring planned outflows as a monthly amount (wb_monthly_equivalent; drafts and ended items left out). expected_income_monthly is recurring planned income as a monthly amount (spec A8); net_monthly is income plus true cost. burn_mean is shown as working. security_invoker, so wb_ RLS applies.';



ALTER TABLE ONLY "platform"."audit_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"platform"."audit_log_id_seq"'::"regclass");



ALTER TABLE ONLY "platform"."mcp_call_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"platform"."mcp_call_log_id_seq"'::"regclass");



ALTER TABLE ONLY "platform"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "platform"."mcp_call_log"
    ADD CONSTRAINT "mcp_call_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "platform"."registry"
    ADD CONSTRAINT "registry_pkey" PRIMARY KEY ("table_name");



ALTER TABLE ONLY "public"."allowed_emails"
    ADD CONSTRAINT "allowed_emails_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."apps"
    ADD CONSTRAINT "apps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clips"
    ADD CONSTRAINT "clips_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_item_removals"
    ADD CONSTRAINT "collection_item_removals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_items"
    ADD CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contexts"
    ADD CONSTRAINT "contexts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_album_tracks"
    ADD CONSTRAINT "dj_album_tracks_album_id_position_key" UNIQUE ("album_id", "position");



ALTER TABLE ONLY "public"."dj_album_tracks"
    ADD CONSTRAINT "dj_album_tracks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_albums"
    ADD CONSTRAINT "dj_albums_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_artist_tags"
    ADD CONSTRAINT "dj_artist_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_artist_tags"
    ADD CONSTRAINT "dj_artist_tags_user_id_artist_tag_key" UNIQUE ("user_id", "artist", "tag");



ALTER TABLE ONLY "public"."dj_artists"
    ADD CONSTRAINT "dj_artists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_artists"
    ADD CONSTRAINT "dj_artists_user_id_name_key" UNIQUE ("user_id", "name");



ALTER TABLE ONLY "public"."dj_concerts"
    ADD CONSTRAINT "dj_concerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_feedback"
    ADD CONSTRAINT "dj_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_known_disagreements"
    ADD CONSTRAINT "dj_known_disagreements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_known_disagreements"
    ADD CONSTRAINT "dj_known_disagreements_user_id_video_id_stored_artist_submi_key" UNIQUE ("user_id", "video_id", "stored_artist", "submitted_artist");



ALTER TABLE ONLY "public"."dj_playlist_tracks"
    ADD CONSTRAINT "dj_playlist_tracks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_playlist_tracks"
    ADD CONSTRAINT "dj_playlist_tracks_playlist_id_role_position_key" UNIQUE ("playlist_id", "role", "position");



ALTER TABLE ONLY "public"."dj_playlists"
    ADD CONSTRAINT "dj_playlists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_playlists"
    ADD CONSTRAINT "dj_playlists_user_id_yt_playlist_id_key" UNIQUE ("user_id", "yt_playlist_id");



ALTER TABLE ONLY "public"."dj_plays"
    ADD CONSTRAINT "dj_plays_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_plays"
    ADD CONSTRAINT "dj_plays_user_id_track_id_played_on_occurrence_source_key" UNIQUE ("user_id", "track_id", "played_on", "occurrence", "source");



ALTER TABLE ONLY "public"."dj_tracks"
    ADD CONSTRAINT "dj_tracks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_tracks"
    ADD CONSTRAINT "dj_tracks_user_id_video_id_key" UNIQUE ("user_id", "video_id");



ALTER TABLE ONLY "public"."dj_venues"
    ADD CONSTRAINT "dj_venues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dj_venues"
    ADD CONSTRAINT "dj_venues_user_id_name_key" UNIQUE ("user_id", "name");



ALTER TABLE ONLY "public"."drive_mix_servings"
    ADD CONSTRAINT "drive_mix_servings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drive_mix_servings"
    ADD CONSTRAINT "drive_mix_servings_position_key" UNIQUE ("user_id", "served_on", "position");



ALTER TABLE ONLY "public"."drive_mix_servings"
    ADD CONSTRAINT "drive_mix_servings_song_key" UNIQUE ("user_id", "served_on", "song_id");



ALTER TABLE ONLY "public"."drive_mix_songs"
    ADD CONSTRAINT "drive_mix_songs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drive_mix_songs"
    ADD CONSTRAINT "drive_mix_songs_user_video_key" UNIQUE ("user_id", "video_id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."executions"
    ADD CONSTRAINT "executions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inbox"
    ADD CONSTRAINT "inbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."intents"
    ADD CONSTRAINT "intents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."item_collections"
    ADD CONSTRAINT "item_collections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_applications"
    ADD CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ken_areas"
    ADD CONSTRAINT "ken_areas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ken_attempts"
    ADD CONSTRAINT "ken_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ken_items"
    ADD CONSTRAINT "ken_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ken_misconceptions"
    ADD CONSTRAINT "ken_misconceptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_steps"
    ADD CONSTRAINT "notification_steps_execution_seq_key" UNIQUE ("execution_id", "seq");



ALTER TABLE ONLY "public"."notification_steps"
    ADD CONSTRAINT "notification_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_runs"
    ADD CONSTRAINT "platform_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_schedules"
    ADD CONSTRAINT "platform_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_schedules"
    ADD CONSTRAINT "platform_schedules_user_id_app_job_key" UNIQUE ("user_id", "app", "job");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE ("endpoint");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_goals"
    ADD CONSTRAINT "sam_goals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_practice_plan_items"
    ADD CONSTRAINT "sam_practice_plan_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_practice_plan_songs"
    ADD CONSTRAINT "sam_practice_plan_songs_id_plan_song_key" UNIQUE ("id", "plan_id", "song_id");



ALTER TABLE ONLY "public"."sam_practice_plan_songs"
    ADD CONSTRAINT "sam_practice_plan_songs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_practice_plan_songs"
    ADD CONSTRAINT "sam_practice_plan_songs_plan_song_key" UNIQUE ("plan_id", "song_id");



ALTER TABLE ONLY "public"."sam_practice_plans"
    ADD CONSTRAINT "sam_practice_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_session_events"
    ADD CONSTRAINT "sam_session_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_sessions"
    ADD CONSTRAINT "sam_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_snippets"
    ADD CONSTRAINT "sam_snippets_id_song_id_key" UNIQUE ("id", "song_id");



ALTER TABLE ONLY "public"."sam_snippets"
    ADD CONSTRAINT "sam_snippets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_song_fingerings"
    ADD CONSTRAINT "sam_song_fingerings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_song_lyrics"
    ADD CONSTRAINT "sam_song_lyrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_song_lyrics"
    ADD CONSTRAINT "sam_song_lyrics_song_id_word_order_key" UNIQUE ("song_id", "word_order");



ALTER TABLE ONLY "public"."sam_song_measures"
    ADD CONSTRAINT "sam_song_measures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sam_song_measures"
    ADD CONSTRAINT "sam_song_measures_song_id_number_key" UNIQUE ("song_id", "number");



ALTER TABLE ONLY "public"."sam_song_scores"
    ADD CONSTRAINT "sam_song_scores_pkey" PRIMARY KEY ("song_id", "measure_number");



ALTER TABLE ONLY "public"."sam_songs"
    ADD CONSTRAINT "sam_songs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_accounts"
    ADD CONSTRAINT "wb_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_accounts"
    ADD CONSTRAINT "wb_accounts_source_external_id_key" UNIQUE ("source", "external_id");



ALTER TABLE ONLY "public"."wb_balance_snapshots"
    ADD CONSTRAINT "wb_balance_snapshots_account_as_of_key" UNIQUE ("account_id", "as_of");



ALTER TABLE ONLY "public"."wb_balance_snapshots"
    ADD CONSTRAINT "wb_balance_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_holding_snapshots"
    ADD CONSTRAINT "wb_holding_snapshots_account_as_of_external_key" UNIQUE ("account_id", "as_of", "external_id");



ALTER TABLE ONLY "public"."wb_holding_snapshots"
    ADD CONSTRAINT "wb_holding_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_merchants"
    ADD CONSTRAINT "wb_merchants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_planned_items"
    ADD CONSTRAINT "wb_planned_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_key" UNIQUE NULLS NOT DISTINCT ("planned_item_id", "split_id", "occurrence_on");



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_planned_skips"
    ADD CONSTRAINT "wb_planned_skips_key" UNIQUE NULLS NOT DISTINCT ("planned_item_id", "occurrence_on");



ALTER TABLE ONLY "public"."wb_planned_skips"
    ADD CONSTRAINT "wb_planned_skips_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_projects"
    ADD CONSTRAINT "wb_projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_rule_health_acks"
    ADD CONSTRAINT "wb_rule_health_acks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_rule_health_acks"
    ADD CONSTRAINT "wb_rule_health_acks_subject_key" UNIQUE ("context_id", "finding", "subject_id");



ALTER TABLE ONLY "public"."wb_rules"
    ADD CONSTRAINT "wb_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_settings"
    ADD CONSTRAINT "wb_settings_context_key" UNIQUE ("context_id");



ALTER TABLE ONLY "public"."wb_settings"
    ADD CONSTRAINT "wb_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_split_tag_key" UNIQUE ("split_id", "tag_id");



ALTER TABLE ONLY "public"."wb_splits"
    ADD CONSTRAINT "wb_splits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_subscription_prices"
    ADD CONSTRAINT "wb_subscription_prices_day_key" UNIQUE ("subscription_id", "effective_on");



ALTER TABLE ONLY "public"."wb_subscription_prices"
    ADD CONSTRAINT "wb_subscription_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_subscriptions"
    ADD CONSTRAINT "wb_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_transaction_tag_key" UNIQUE ("transaction_id", "tag_id");



ALTER TABLE ONLY "public"."wb_tag_groups"
    ADD CONSTRAINT "wb_tag_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_tags"
    ADD CONSTRAINT "wb_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_account_external_key" UNIQUE ("account_id", "external_id");



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_audit_log_actor" ON "platform"."audit_log" USING "btree" ("actor", "occurred_at" DESC);



CREATE INDEX "idx_audit_log_recent" ON "platform"."audit_log" USING "btree" ("occurred_at" DESC);



CREATE INDEX "idx_audit_log_record" ON "platform"."audit_log" USING "btree" ("table_name", "record_id", "occurred_at" DESC);



CREATE INDEX "idx_audit_log_user" ON "platform"."audit_log" USING "btree" ("user_id", "occurred_at" DESC);



CREATE INDEX "idx_mcp_call_loop" ON "platform"."mcp_call_log" USING "btree" ("user_id", "tool_name", "args_hash", "called_at" DESC) WHERE (NOT "blocked");



CREATE INDEX "idx_mcp_call_user_time" ON "platform"."mcp_call_log" USING "btree" ("user_id", "called_at" DESC);



CREATE INDEX "clips_user_created_idx" ON "public"."clips" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "clips_user_source_created_idx" ON "public"."clips" USING "btree" ("user_id", "source", "created_at" DESC);



CREATE INDEX "collection_item_removals_recent_idx" ON "public"."collection_item_removals" USING "btree" ("collection_id", "removed_at" DESC);



CREATE INDEX "collection_items_collection_idx" ON "public"."collection_items" USING "btree" ("collection_id", "position");



CREATE UNIQUE INDEX "collection_items_unique_member" ON "public"."collection_items" USING "btree" ("collection_id", "item_id");



CREATE INDEX "dj_albums_artist_idx" ON "public"."dj_albums" USING "btree" ("artist_id");



CREATE INDEX "dj_albums_tags_idx" ON "public"."dj_albums" USING "gin" ("tags");



CREATE UNIQUE INDEX "dj_albums_user_yt_uniq" ON "public"."dj_albums" USING "btree" ("user_id", "yt_album_id") WHERE ("yt_album_id" IS NOT NULL);



CREATE INDEX "dj_artists_tags_idx" ON "public"."dj_artists" USING "gin" ("tags");



CREATE INDEX "dj_concerts_status_idx" ON "public"."dj_concerts" USING "btree" ("user_id", "status");



CREATE INDEX "dj_concerts_upcoming_idx" ON "public"."dj_concerts" USING "btree" ("user_id", "starts_on");



CREATE INDEX "dj_feedback_album_idx" ON "public"."dj_feedback" USING "btree" ("user_id", "album_id", "occurred_on" DESC);



CREATE INDEX "dj_feedback_artist_idx" ON "public"."dj_feedback" USING "btree" ("user_id", "artist_id", "occurred_on" DESC);



CREATE INDEX "dj_feedback_concert_idx" ON "public"."dj_feedback" USING "btree" ("user_id", "concert_id", "occurred_on" DESC);



CREATE INDEX "dj_known_disagreements_lookup" ON "public"."dj_known_disagreements" USING "btree" ("user_id", "video_id");



CREATE UNIQUE INDEX "dj_playlist_tracks_cram_track_uniq" ON "public"."dj_playlist_tracks" USING "btree" ("playlist_id", "track_id") WHERE ("role" = 'cram'::"text");



COMMENT ON INDEX "public"."dj_playlist_tracks_cram_track_uniq" IS 'A song may appear many times in a playlist BODY - party mixes repeat, and a discography compiled over years accumulates the same track. It may never appear twice in CRAM: cram is generated by the system, holds about eight slots, and a duplicate there wastes one and shows the same song twice in a focus list. Conditional on ZONE, deliberately, and never on playlist kind - the zones already mean different things, whereas making correctness depend on a human''s classification of a playlist would put the rule somewhere no caller can see it.';



CREATE INDEX "dj_playlist_tracks_playlist_idx" ON "public"."dj_playlist_tracks" USING "btree" ("playlist_id", "role", "position");



CREATE INDEX "dj_plays_played_on_idx" ON "public"."dj_plays" USING "btree" ("user_id", "played_on" DESC);



CREATE INDEX "dj_plays_recent_idx" ON "public"."dj_plays" USING "btree" ("user_id", "track_id", "played_on" DESC);



CREATE INDEX "dj_plays_track_idx" ON "public"."dj_plays" USING "btree" ("track_id");



CREATE INDEX "dj_tracks_canonical_idx" ON "public"."dj_tracks" USING "btree" ("canonical_track_id");



CREATE INDEX "dj_tracks_match_key_idx" ON "public"."dj_tracks" USING "btree" ("user_id", "match_key");



CREATE INDEX "drive_mix_servings_served_on_idx" ON "public"."drive_mix_servings" USING "btree" ("user_id", "served_on" DESC);



CREATE INDEX "drive_mix_servings_song_idx" ON "public"."drive_mix_servings" USING "btree" ("song_id");



CREATE INDEX "drive_mix_songs_artist_key_idx" ON "public"."drive_mix_songs" USING "btree" ("user_id", "artist_key");



CREATE INDEX "drive_mix_songs_status_idx" ON "public"."drive_mix_songs" USING "btree" ("user_id", "status");



CREATE UNIQUE INDEX "events_one_live_per_intent" ON "public"."events" USING "btree" ("intent_id") WHERE ("archived" IS NOT TRUE);



COMMENT ON INDEX "public"."events_one_live_per_intent" IS 'Restructure P1. At most one live (archived is not true; null counts as live) event per intention. An event is the plan for one day; the history is archived events. Recurrence archives before it creates the successor, so the order is safe.';



CREATE INDEX "events_source_inbox_idx" ON "public"."events" USING "btree" ("source_inbox_id") WHERE ("source_inbox_id" IS NOT NULL);



CREATE UNIQUE INDEX "executions_one_open_per_intent" ON "public"."executions" USING "btree" ("intent_id") WHERE ("status" = ANY (ARRAY['active'::"text", 'paused'::"text"]));



COMMENT ON INDEX "public"."executions_one_open_per_intent" IS 'Restructure P1. At most one open (active or paused) execution per intention. Closed executions are unlimited: they are the history.';



CREATE INDEX "idx_contexts_user" ON "public"."contexts" USING "btree" ("user_id");



CREATE INDEX "idx_events_archived" ON "public"."events" USING "btree" ("archived");



CREATE INDEX "idx_events_collection_id" ON "public"."events" USING "btree" ("collection_id");



CREATE INDEX "idx_events_intent" ON "public"."events" USING "btree" ("intent_id");



CREATE INDEX "idx_events_user" ON "public"."events" USING "btree" ("user_id");



CREATE INDEX "idx_executions_collection_id" ON "public"."executions" USING "btree" ("collection_id");



CREATE INDEX "idx_executions_event" ON "public"."executions" USING "btree" ("event_id");



CREATE INDEX "idx_executions_user" ON "public"."executions" USING "btree" ("user_id");



CREATE INDEX "idx_inbox_archived" ON "public"."inbox" USING "btree" ("archived") WHERE ("archived" = false);



CREATE INDEX "idx_inbox_user" ON "public"."inbox" USING "btree" ("user_id");



CREATE INDEX "idx_intents_collection_id" ON "public"."intents" USING "btree" ("collection_id");



CREATE INDEX "idx_intents_context" ON "public"."intents" USING "btree" ("context_id");



CREATE INDEX "idx_intents_item" ON "public"."intents" USING "btree" ("item_id");



CREATE INDEX "idx_intents_recurrence_config" ON "public"."intents" USING "gin" ("recurrence_config");



CREATE INDEX "idx_intents_tags" ON "public"."intents" USING "gin" ("tags");



CREATE INDEX "idx_intents_user" ON "public"."intents" USING "btree" ("user_id");



CREATE INDEX "idx_item_collections_context_id" ON "public"."item_collections" USING "btree" ("context_id");



CREATE INDEX "idx_item_collections_shared" ON "public"."item_collections" USING "btree" ("shared");



CREATE INDEX "idx_item_collections_user_id" ON "public"."item_collections" USING "btree" ("user_id");



CREATE INDEX "idx_items_context" ON "public"."items" USING "btree" ("context_id");



CREATE INDEX "idx_items_tags" ON "public"."items" USING "gin" ("tags");



CREATE INDEX "idx_items_user" ON "public"."items" USING "btree" ("user_id");



CREATE INDEX "idx_passes_snippet_completed" ON "public"."sam_passes" USING "btree" ("snippet_id", "completed_at" DESC);



CREATE INDEX "idx_passes_song_completed" ON "public"."sam_passes" USING "btree" ("song_id", "completed_at" DESC);



CREATE INDEX "idx_passes_song_effective_bpm" ON "public"."sam_passes" USING "btree" ("song_id", "effective_bpm");



CREATE INDEX "idx_passes_song_notes_played" ON "public"."sam_passes" USING "btree" ("song_id", "notes_played");



CREATE INDEX "idx_sam_songs_parent" ON "public"."sam_songs" USING "btree" ("parent_song_id") WHERE ("parent_song_id" IS NOT NULL);



CREATE INDEX "idx_sam_songs_type" ON "public"."sam_songs" USING "btree" ("song_type");



CREATE INDEX "idx_session_events_result" ON "public"."sam_session_events" USING "btree" ("song_id", "measure_number", "result");



CREATE INDEX "idx_session_events_session" ON "public"."sam_session_events" USING "btree" ("session_id");



CREATE INDEX "idx_session_events_song" ON "public"."sam_session_events" USING "btree" ("song_id");



CREATE INDEX "idx_sessions_snippet" ON "public"."sam_sessions" USING "btree" ("snippet_id");



CREATE INDEX "idx_sessions_song" ON "public"."sam_sessions" USING "btree" ("song_id");



CREATE INDEX "idx_sessions_started" ON "public"."sam_sessions" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_snippets_archived" ON "public"."sam_snippets" USING "btree" ("archived");



CREATE INDEX "idx_snippets_song" ON "public"."sam_snippets" USING "btree" ("song_id");



CREATE INDEX "idx_song_fingerings_song_measure" ON "public"."sam_song_fingerings" USING "btree" ("song_id", "measure_num", "rh_index");



CREATE INDEX "idx_song_lyrics_placed" ON "public"."sam_song_lyrics" USING "btree" ("song_id", "measure_num", "rh_index") WHERE ("measure_num" IS NOT NULL);



CREATE INDEX "idx_song_lyrics_song" ON "public"."sam_song_lyrics" USING "btree" ("song_id");



CREATE INDEX "idx_song_lyrics_unplaced" ON "public"."sam_song_lyrics" USING "btree" ("song_id") WHERE ("measure_num" IS NULL);



CREATE INDEX "idx_song_measures_song_id" ON "public"."sam_song_measures" USING "btree" ("song_id");



CREATE INDEX "idx_song_measures_song_number" ON "public"."sam_song_measures" USING "btree" ("song_id", "number");



CREATE INDEX "idx_songs_archived" ON "public"."sam_songs" USING "btree" ("archived");



CREATE UNIQUE INDEX "inbox_email_message_id_key" ON "public"."inbox" USING "btree" ("user_id", (("source_metadata" ->> 'messageId'::"text"))) WHERE ("source_type" = 'email'::"text");



COMMENT ON INDEX "public"."inbox_email_message_id_key" IS 'email_capture-f4m: one row per Postmark delivery (MessageID) per user. email-capture answers a violation with 200 duplicate so Postmark stops retrying. Null messageId is never in conflict.';



CREATE INDEX "intents_source_inbox_idx" ON "public"."intents" USING "btree" ("source_inbox_id") WHERE ("source_inbox_id" IS NOT NULL);



CREATE INDEX "items_source_inbox_idx" ON "public"."items" USING "btree" ("source_inbox_id") WHERE ("source_inbox_id" IS NOT NULL);



CREATE INDEX "job_applications_due_idx" ON "public"."job_applications" USING "btree" ("user_id", "next_action_due");



CREATE INDEX "job_applications_posting_url_idx" ON "public"."job_applications" USING "btree" ("user_id", "posting_url") WHERE ("posting_url" IS NOT NULL);



CREATE INDEX "job_applications_source_idx" ON "public"."job_applications" USING "btree" ("user_id", "source");



CREATE INDEX "job_applications_source_inbox_idx" ON "public"."job_applications" USING "btree" ("source_inbox_id") WHERE ("source_inbox_id" IS NOT NULL);



CREATE INDEX "job_applications_status_idx" ON "public"."job_applications" USING "btree" ("user_id", "status");



CREATE UNIQUE INDEX "ken_areas_source_ref_key" ON "public"."ken_areas" USING "btree" ("user_id", "source_ref") WHERE ("source_ref" IS NOT NULL);



CREATE INDEX "ken_areas_user_idx" ON "public"."ken_areas" USING "btree" ("user_id");



CREATE INDEX "ken_attempts_item_idx" ON "public"."ken_attempts" USING "btree" ("item_id", "asked_at" DESC);



CREATE INDEX "ken_items_area_idx" ON "public"."ken_items" USING "btree" ("user_id", "area_id", "status");



CREATE INDEX "ken_items_last_seen_idx" ON "public"."ken_items" USING "btree" ("user_id", "last_seen" NULLS FIRST);



CREATE INDEX "ken_items_superseded_idx" ON "public"."ken_items" USING "btree" ("superseded_by") WHERE ("superseded_by" IS NOT NULL);



CREATE INDEX "ken_items_tags_idx" ON "public"."ken_items" USING "gin" ("tags");



CREATE INDEX "ken_misconceptions_active_idx" ON "public"."ken_misconceptions" USING "btree" ("user_id", "status");



CREATE INDEX "ken_misconceptions_item_idx" ON "public"."ken_misconceptions" USING "btree" ("item_id") WHERE ("item_id" IS NOT NULL);



CREATE INDEX "ken_misconceptions_related_idx" ON "public"."ken_misconceptions" USING "btree" ("related_item_id") WHERE ("related_item_id" IS NOT NULL);



CREATE INDEX "notes_execution_idx" ON "public"."notes" USING "btree" ("execution_id") WHERE ("execution_id" IS NOT NULL);



CREATE INDEX "notes_target_idx" ON "public"."notes" USING "btree" ("target_type", "target_id");



CREATE INDEX "notification_steps_due_idx" ON "public"."notification_steps" USING "btree" ("due_at") WHERE ("state" = 'scheduled'::"text");



CREATE INDEX "notification_steps_execution_idx" ON "public"."notification_steps" USING "btree" ("execution_id", "seq");



CREATE INDEX "platform_runs_recent_idx" ON "public"."platform_runs" USING "btree" ("user_id", "app", "job", "started_at" DESC);



CREATE INDEX "platform_runs_unnotified_idx" ON "public"."platform_runs" USING "btree" ("user_id", "status", "notified_at") WHERE ("status" <> 'ok'::"text");



CREATE INDEX "reminders_inbox_idx" ON "public"."reminders" USING "btree" ("inbox_id") WHERE ("inbox_id" IS NOT NULL);



CREATE INDEX "reminders_intent_idx" ON "public"."reminders" USING "btree" ("intent_id") WHERE ("intent_id" IS NOT NULL);



CREATE INDEX "reminders_state_due_idx" ON "public"."reminders" USING "btree" ("state", "due_at");



CREATE INDEX "sam_goals_user_status" ON "public"."sam_goals" USING "btree" ("user_id", "status");



CREATE INDEX "sam_passes_plan" ON "public"."sam_passes" USING "btree" ("plan_id") WHERE ("plan_id" IS NOT NULL);



CREATE INDEX "sam_passes_plan_item" ON "public"."sam_passes" USING "btree" ("plan_item_id") WHERE ("plan_item_id" IS NOT NULL);



CREATE UNIQUE INDEX "sam_practice_plan_items_one_per_range" ON "public"."sam_practice_plan_items" USING "btree" ("plan_id", "song_id", COALESCE("snippet_id", '00000000-0000-0000-0000-000000000000'::"uuid"));



CREATE INDEX "sam_practice_plan_items_plan_position" ON "public"."sam_practice_plan_items" USING "btree" ("plan_id", "position");



CREATE INDEX "sam_practice_plan_items_snippet" ON "public"."sam_practice_plan_items" USING "btree" ("snippet_id") WHERE ("snippet_id" IS NOT NULL);



CREATE INDEX "sam_practice_plan_songs_song" ON "public"."sam_practice_plan_songs" USING "btree" ("song_id");



CREATE UNIQUE INDEX "sam_practice_plans_one_active" ON "public"."sam_practice_plans" USING "btree" ("user_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "sam_practice_plans_user_created" ON "public"."sam_practice_plans" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "sam_sessions_plan" ON "public"."sam_sessions" USING "btree" ("plan_id") WHERE ("plan_id" IS NOT NULL);



CREATE INDEX "sam_sessions_plan_item" ON "public"."sam_sessions" USING "btree" ("plan_item_id") WHERE ("plan_item_id" IS NOT NULL);



CREATE UNIQUE INDEX "sam_song_fingerings_coord_source_key" ON "public"."sam_song_fingerings" USING "btree" ("song_id", "measure_num", "rh_index", "note_index", "source");



CREATE INDEX "wb_accounts_context_idx" ON "public"."wb_accounts" USING "btree" ("context_id");



CREATE UNIQUE INDEX "wb_merchants_name_key" ON "public"."wb_merchants" USING "btree" ("context_id", "lower"("name"));



CREATE INDEX "wb_planned_items_due_idx" ON "public"."wb_planned_items" USING "btree" ("due_on");



CREATE INDEX "wb_planned_items_project_idx" ON "public"."wb_planned_items" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);



CREATE INDEX "wb_planned_matches_split_idx" ON "public"."wb_planned_matches" USING "btree" ("split_id");



CREATE INDEX "wb_planned_matches_transaction_idx" ON "public"."wb_planned_matches" USING "btree" ("transaction_id");



CREATE UNIQUE INDEX "wb_projects_name_key" ON "public"."wb_projects" USING "btree" ("context_id", "lower"("name"));



CREATE UNIQUE INDEX "wb_split_tags_one_per_exclusive_group" ON "public"."wb_split_tags" USING "btree" ("split_id", "group_id") WHERE "group_exclusive";



CREATE INDEX "wb_split_tags_tag_idx" ON "public"."wb_split_tags" USING "btree" ("tag_id");



CREATE INDEX "wb_splits_project_idx" ON "public"."wb_splits" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);



CREATE INDEX "wb_splits_transaction_idx" ON "public"."wb_splits" USING "btree" ("transaction_id", "position");



CREATE INDEX "wb_subscriptions_merchant_idx" ON "public"."wb_subscriptions" USING "btree" ("merchant_id");



CREATE INDEX "wb_tag_exclusions_tag_idx" ON "public"."wb_tag_exclusions" USING "btree" ("tag_id");



CREATE UNIQUE INDEX "wb_tag_groups_name_key" ON "public"."wb_tag_groups" USING "btree" ("context_id", "lower"("name"));



CREATE UNIQUE INDEX "wb_tags_group_name_key" ON "public"."wb_tags" USING "btree" ("group_id", "lower"("name"));



CREATE INDEX "wb_tags_parent_idx" ON "public"."wb_tags" USING "btree" ("parent_id");



CREATE INDEX "wb_transactions_account_posted_idx" ON "public"."wb_transactions" USING "btree" ("account_id", "posted_at" DESC);



CREATE INDEX "wb_transactions_kind_posted_idx" ON "public"."wb_transactions" USING "btree" ("kind", "posted_at");



CREATE INDEX "wb_transactions_pair_idx" ON "public"."wb_transactions" USING "btree" ("transfer_pair_id");



CREATE INDEX "wb_transactions_subscription_idx" ON "public"."wb_transactions" USING "btree" ("subscription_id");



CREATE OR REPLACE TRIGGER "apps_touch_updated_at" BEFORE UPDATE ON "public"."apps" FOR EACH ROW EXECUTE FUNCTION "public"."apps_touch_updated_at"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."apps" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."clips" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."collection_items" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."contexts" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_album_tracks" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_albums" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_artist_tags" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_artists" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_concerts" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_feedback" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_known_disagreements" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_playlist_tracks" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_playlists" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_tracks" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."dj_venues" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."drive_mix_servings" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."drive_mix_songs" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."executions" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."inbox" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."intents" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."item_collections" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."job_applications" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."ken_areas" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."ken_attempts" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."ken_items" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."ken_misconceptions" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."notes" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."notification_steps" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."platform_schedules" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."push_subscriptions" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."reminders" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_goals" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_passes" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_practice_plan_items" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_practice_plan_songs" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_practice_plans" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_sessions" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_snippets" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_song_fingerings" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_song_lyrics" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_song_measures" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_songs" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_accounts" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_merchants" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_planned_items" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_planned_matches" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_planned_skips" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_projects" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_rule_health_acks" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_rules" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_settings" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_split_tags" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_splits" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_subscription_prices" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_subscriptions" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_tag_exclusions" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_tag_groups" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_tags" FOR EACH ROW EXECUTE FUNCTION "platform"."audit_row"();



CREATE OR REPLACE TRIGGER "bump_parent_edited_at" AFTER UPDATE ON "public"."sam_song_measures" FOR EACH ROW EXECUTE FUNCTION "public"."bump_song_edited_at"();



CREATE OR REPLACE TRIGGER "drive_mix_songs_set_artist_key" BEFORE INSERT OR UPDATE ON "public"."drive_mix_songs" FOR EACH ROW EXECUTE FUNCTION "public"."drive_mix_songs_set_artist_key"();



CREATE OR REPLACE TRIGGER "events_status_activate" AFTER INSERT ON "public"."events" FOR EACH ROW WHEN (("new"."archived" IS NOT TRUE)) EXECUTE FUNCTION "public"."status_activate_on_event"();



CREATE OR REPLACE TRIGGER "executions_last_completed" AFTER INSERT OR DELETE OR UPDATE ON "public"."executions" FOR EACH ROW EXECUTE FUNCTION "public"."executions_last_completed"();



CREATE OR REPLACE TRIGGER "executions_status_activate" AFTER INSERT ON "public"."executions" FOR EACH ROW EXECUTE FUNCTION "public"."status_activate_on_execution"();



CREATE OR REPLACE TRIGGER "inbox_set_source_app" BEFORE INSERT ON "public"."inbox" FOR EACH ROW EXECUTE FUNCTION "public"."inbox_set_source_app"();



CREATE OR REPLACE TRIGGER "intents_delete_notes" AFTER DELETE ON "public"."intents" FOR EACH ROW EXECUTE FUNCTION "public"."notes_delete_for_target"('intention');



CREATE OR REPLACE TRIGGER "intents_last_completed" AFTER DELETE OR UPDATE OF "item_id" ON "public"."intents" FOR EACH ROW EXECUTE FUNCTION "public"."intents_last_completed"();



CREATE OR REPLACE TRIGGER "intents_last_completed_guard" BEFORE INSERT OR UPDATE ON "public"."intents" FOR EACH ROW EXECUTE FUNCTION "public"."last_completed_guard"();



CREATE OR REPLACE TRIGGER "intents_status_guard" BEFORE UPDATE ON "public"."intents" FOR EACH ROW EXECUTE FUNCTION "public"."status_guard"();



CREATE OR REPLACE TRIGGER "items_delete_notes" AFTER DELETE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "public"."notes_delete_for_target"('item');



CREATE OR REPLACE TRIGGER "items_last_completed_guard" BEFORE INSERT OR UPDATE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "public"."last_completed_guard"();



CREATE OR REPLACE TRIGGER "items_status_guard" BEFORE UPDATE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "public"."status_guard"();



CREATE OR REPLACE TRIGGER "notes_touch_updated_at" BEFORE UPDATE ON "public"."notes" FOR EACH ROW EXECUTE FUNCTION "public"."notes_touch_updated_at"();



CREATE OR REPLACE TRIGGER "reminders_follow_intent_archive" AFTER UPDATE OF "archived" ON "public"."intents" FOR EACH ROW WHEN (("old"."archived" IS DISTINCT FROM "new"."archived")) EXECUTE FUNCTION "public"."reminders_follow_intent_archive"();



CREATE OR REPLACE TRIGGER "reminders_touch_updated_at" BEFORE UPDATE ON "public"."reminders" FOR EACH ROW EXECUTE FUNCTION "public"."reminders_touch_updated_at"();



CREATE OR REPLACE TRIGGER "sam_goals_touch_updated_at" BEFORE UPDATE ON "public"."sam_goals" FOR EACH ROW EXECUTE FUNCTION "public"."sam_goals_touch_updated_at"();



CREATE OR REPLACE TRIGGER "sam_practice_plan_items_reject_update" BEFORE UPDATE ON "public"."sam_practice_plan_items" FOR EACH ROW EXECUTE FUNCTION "public"."sam_practice_reject_update"();



CREATE OR REPLACE TRIGGER "sam_practice_plan_songs_reject_update" BEFORE UPDATE ON "public"."sam_practice_plan_songs" FOR EACH ROW EXECUTE FUNCTION "public"."sam_practice_reject_update"();



CREATE OR REPLACE TRIGGER "sam_practice_plans_guard_update" BEFORE UPDATE ON "public"."sam_practice_plans" FOR EACH ROW EXECUTE FUNCTION "public"."sam_practice_plans_guard_update"();



CREATE OR REPLACE TRIGGER "sam_songs_fill_goal_tempo" BEFORE INSERT ON "public"."sam_songs" FOR EACH ROW EXECUTE FUNCTION "public"."sam_songs_fill_goal_tempo"();



CREATE OR REPLACE TRIGGER "sam_songs_mark_goal_set" BEFORE UPDATE OF "goal_bpm", "goal_playback_speed", "goal_set_at" ON "public"."sam_songs" FOR EACH ROW EXECUTE FUNCTION "public"."sam_songs_mark_goal_set"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."contexts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."executions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."inbox" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."intents" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."item_collections" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."sam_song_measures" FOR EACH ROW EXECUTE FUNCTION "public"."update_modified_column"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."sam_songs" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "stamp_song_on_measures_delete" AFTER DELETE ON "public"."sam_song_measures" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."stamp_songs_from_measure_statement"();



COMMENT ON TRIGGER "stamp_song_on_measures_delete" ON "public"."sam_song_measures" IS 'SAM analyzer (M6). Once per DELETE statement, stamps sam_songs.measures_edited_at for every song deleted from (a song being deleted matches no row).';



CREATE OR REPLACE TRIGGER "stamp_song_on_measures_insert" AFTER INSERT ON "public"."sam_song_measures" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."stamp_songs_from_measure_statement"();



COMMENT ON TRIGGER "stamp_song_on_measures_insert" ON "public"."sam_song_measures" IS 'SAM analyzer (M6). Once per INSERT statement, stamps sam_songs.measures_edited_at for every song inserted into.';



CREATE OR REPLACE TRIGGER "trg_lyrics_stamp_edited" AFTER INSERT OR DELETE OR UPDATE ON "public"."sam_song_lyrics" FOR EACH ROW EXECUTE FUNCTION "public"."stamp_song_edited"();



CREATE OR REPLACE TRIGGER "wb_accounts_touch_updated_at" BEFORE UPDATE ON "public"."wb_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_balance_snapshots_touch_updated_at" BEFORE UPDATE ON "public"."wb_balance_snapshots" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_merchants_touch_updated_at" BEFORE UPDATE ON "public"."wb_merchants" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_planned_items_touch_updated_at" BEFORE UPDATE ON "public"."wb_planned_items" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_planned_matches_fill" BEFORE INSERT OR UPDATE ON "public"."wb_planned_matches" FOR EACH ROW EXECUTE FUNCTION "public"."wb_planned_matches_fill"();



CREATE OR REPLACE TRIGGER "wb_planned_matches_touch_updated_at" BEFORE UPDATE ON "public"."wb_planned_matches" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_planned_skips_fill" BEFORE INSERT OR UPDATE ON "public"."wb_planned_skips" FOR EACH ROW EXECUTE FUNCTION "public"."wb_planned_skips_fill"();



CREATE OR REPLACE TRIGGER "wb_planned_skips_touch_updated_at" BEFORE UPDATE ON "public"."wb_planned_skips" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_projects_touch_updated_at" BEFORE UPDATE ON "public"."wb_projects" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_rule_health_acks_touch_updated_at" BEFORE UPDATE ON "public"."wb_rule_health_acks" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_rules_check_tags" BEFORE INSERT OR UPDATE OF "add_tag_ids" ON "public"."wb_rules" FOR EACH ROW EXECUTE FUNCTION "public"."wb_rules_check_tags"();



CREATE OR REPLACE TRIGGER "wb_rules_touch_updated_at" BEFORE UPDATE ON "public"."wb_rules" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_settings_touch_updated_at" BEFORE UPDATE ON "public"."wb_settings" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_split_tags_fill" BEFORE INSERT OR UPDATE ON "public"."wb_split_tags" FOR EACH ROW EXECUTE FUNCTION "public"."wb_split_tags_fill"();



CREATE OR REPLACE TRIGGER "wb_splits_copy_owner" BEFORE INSERT OR UPDATE ON "public"."wb_splits" FOR EACH ROW EXECUTE FUNCTION "public"."wb_splits_copy_owner"();



CREATE OR REPLACE TRIGGER "wb_splits_fill_project_source" BEFORE INSERT OR UPDATE OF "project_id", "project_source" ON "public"."wb_splits" FOR EACH ROW EXECUTE FUNCTION "public"."wb_splits_fill_project_source"();



CREATE CONSTRAINT TRIGGER "wb_splits_sum_check" AFTER INSERT OR DELETE OR UPDATE ON "public"."wb_splits" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."wb_splits_check_sum"();



CREATE OR REPLACE TRIGGER "wb_splits_touch_updated_at" BEFORE UPDATE ON "public"."wb_splits" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_subscription_prices_copy_owner" BEFORE INSERT OR UPDATE ON "public"."wb_subscription_prices" FOR EACH ROW EXECUTE FUNCTION "public"."wb_subscription_prices_copy_owner"();



CREATE OR REPLACE TRIGGER "wb_subscriptions_fill_interval" BEFORE INSERT OR UPDATE ON "public"."wb_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."wb_subscriptions_fill_interval"();



CREATE OR REPLACE TRIGGER "wb_subscriptions_fill_owner" BEFORE INSERT ON "public"."wb_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."wb_subscriptions_fill_owner"();



CREATE OR REPLACE TRIGGER "wb_subscriptions_touch_updated_at" BEFORE UPDATE ON "public"."wb_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_tag_exclusions_copy_owner" BEFORE INSERT OR UPDATE ON "public"."wb_tag_exclusions" FOR EACH ROW EXECUTE FUNCTION "public"."wb_tag_exclusions_copy_owner"();



CREATE OR REPLACE TRIGGER "wb_tag_groups_push_exclusive" AFTER UPDATE OF "exclusive" ON "public"."wb_tag_groups" FOR EACH ROW WHEN (("old"."exclusive" IS DISTINCT FROM "new"."exclusive")) EXECUTE FUNCTION "public"."wb_tag_groups_push_exclusive"();



CREATE OR REPLACE TRIGGER "wb_tag_groups_touch_updated_at" BEFORE UPDATE ON "public"."wb_tag_groups" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_tags_check" BEFORE INSERT OR UPDATE ON "public"."wb_tags" FOR EACH ROW EXECUTE FUNCTION "public"."wb_tags_check"();



CREATE OR REPLACE TRIGGER "wb_tags_touch_updated_at" BEFORE UPDATE ON "public"."wb_tags" FOR EACH ROW EXECUTE FUNCTION "public"."wb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "wb_transactions_amount_follow" AFTER UPDATE OF "amount" ON "public"."wb_transactions" FOR EACH ROW WHEN (("old"."amount" IS DISTINCT FROM "new"."amount")) EXECUTE FUNCTION "public"."wb_transactions_amount_follow"();



CREATE OR REPLACE TRIGGER "wb_transactions_default_split" AFTER INSERT ON "public"."wb_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."wb_transactions_default_split"();



ALTER TABLE ONLY "public"."clips"
    ADD CONSTRAINT "clips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."collection_item_removals"
    ADD CONSTRAINT "collection_item_removals_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."item_collections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_items"
    ADD CONSTRAINT "collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."item_collections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contexts"
    ADD CONSTRAINT "contexts_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contexts"
    ADD CONSTRAINT "contexts_default_collection_id_fkey" FOREIGN KEY ("default_collection_id") REFERENCES "public"."item_collections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contexts"
    ADD CONSTRAINT "contexts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."dj_album_tracks"
    ADD CONSTRAINT "dj_album_tracks_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "public"."dj_albums"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_album_tracks"
    ADD CONSTRAINT "dj_album_tracks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_albums"
    ADD CONSTRAINT "dj_albums_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."dj_artists"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dj_artist_tags"
    ADD CONSTRAINT "dj_artist_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_concerts"
    ADD CONSTRAINT "dj_concerts_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."dj_artists"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."dj_concerts"
    ADD CONSTRAINT "dj_concerts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."dj_venues"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dj_feedback"
    ADD CONSTRAINT "dj_feedback_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "public"."dj_albums"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_feedback"
    ADD CONSTRAINT "dj_feedback_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."dj_artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_feedback"
    ADD CONSTRAINT "dj_feedback_concert_id_fkey" FOREIGN KEY ("concert_id") REFERENCES "public"."dj_concerts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_feedback"
    ADD CONSTRAINT "dj_feedback_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "public"."dj_tracks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_feedback"
    ADD CONSTRAINT "dj_feedback_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."dj_venues"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_known_disagreements"
    ADD CONSTRAINT "dj_known_disagreements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_playlist_tracks"
    ADD CONSTRAINT "dj_playlist_tracks_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "public"."dj_playlists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_playlist_tracks"
    ADD CONSTRAINT "dj_playlist_tracks_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "public"."dj_tracks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_playlists"
    ADD CONSTRAINT "dj_playlists_concert_id_fkey" FOREIGN KEY ("concert_id") REFERENCES "public"."dj_concerts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dj_plays"
    ADD CONSTRAINT "dj_plays_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "public"."dj_tracks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dj_tracks"
    ADD CONSTRAINT "dj_tracks_canonical_track_id_fkey" FOREIGN KEY ("canonical_track_id") REFERENCES "public"."dj_tracks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drive_mix_servings"
    ADD CONSTRAINT "drive_mix_servings_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."drive_mix_songs"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."drive_mix_servings"
    ADD CONSTRAINT "drive_mix_servings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."drive_mix_songs"
    ADD CONSTRAINT "drive_mix_songs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_source_inbox_id_fkey" FOREIGN KEY ("source_inbox_id") REFERENCES "public"."inbox"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."executions"
    ADD CONSTRAINT "executions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inbox"
    ADD CONSTRAINT "inbox_source_app_fkey" FOREIGN KEY ("source_app") REFERENCES "public"."apps"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inbox"
    ADD CONSTRAINT "inbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."intents"
    ADD CONSTRAINT "intents_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."intents"
    ADD CONSTRAINT "intents_source_inbox_id_fkey" FOREIGN KEY ("source_inbox_id") REFERENCES "public"."inbox"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."intents"
    ADD CONSTRAINT "intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."item_collections"
    ADD CONSTRAINT "item_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_source_inbox_id_fkey" FOREIGN KEY ("source_inbox_id") REFERENCES "public"."inbox"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."job_applications"
    ADD CONSTRAINT "job_applications_duplicate_of_fkey" FOREIGN KEY ("duplicate_of") REFERENCES "public"."job_applications"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_applications"
    ADD CONSTRAINT "job_applications_source_inbox_id_fkey" FOREIGN KEY ("source_inbox_id") REFERENCES "public"."inbox"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ken_attempts"
    ADD CONSTRAINT "ken_attempts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."ken_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ken_items"
    ADD CONSTRAINT "ken_items_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "public"."ken_areas"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ken_items"
    ADD CONSTRAINT "ken_items_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."ken_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ken_misconceptions"
    ADD CONSTRAINT "ken_misconceptions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."ken_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ken_misconceptions"
    ADD CONSTRAINT "ken_misconceptions_related_item_id_fkey" FOREIGN KEY ("related_item_id") REFERENCES "public"."ken_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sam_goals"
    ADD CONSTRAINT "sam_goals_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_goals"
    ADD CONSTRAINT "sam_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."sam_practice_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "public"."sam_practice_plan_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sam_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_snippet_id_fkey" FOREIGN KEY ("snippet_id") REFERENCES "public"."sam_snippets"("id");



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_passes"
    ADD CONSTRAINT "sam_passes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_practice_plan_items"
    ADD CONSTRAINT "sam_practice_plan_items_plan_song_fkey" FOREIGN KEY ("plan_song_id", "plan_id", "song_id") REFERENCES "public"."sam_practice_plan_songs"("id", "plan_id", "song_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_practice_plan_items"
    ADD CONSTRAINT "sam_practice_plan_items_snippet_fkey" FOREIGN KEY ("snippet_id", "song_id") REFERENCES "public"."sam_snippets"("id", "song_id");



ALTER TABLE ONLY "public"."sam_practice_plan_items"
    ADD CONSTRAINT "sam_practice_plan_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_practice_plan_songs"
    ADD CONSTRAINT "sam_practice_plan_songs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."sam_practice_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_practice_plan_songs"
    ADD CONSTRAINT "sam_practice_plan_songs_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_practice_plan_songs"
    ADD CONSTRAINT "sam_practice_plan_songs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_practice_plans"
    ADD CONSTRAINT "sam_practice_plans_supersedes_plan_id_fkey" FOREIGN KEY ("supersedes_plan_id") REFERENCES "public"."sam_practice_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_practice_plans"
    ADD CONSTRAINT "sam_practice_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_session_events"
    ADD CONSTRAINT "sam_session_events_measure_id_fkey" FOREIGN KEY ("measure_id") REFERENCES "public"."sam_song_measures"("id");



ALTER TABLE ONLY "public"."sam_session_events"
    ADD CONSTRAINT "sam_session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sam_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_session_events"
    ADD CONSTRAINT "sam_session_events_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id");



ALTER TABLE ONLY "public"."sam_sessions"
    ADD CONSTRAINT "sam_sessions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."sam_practice_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_sessions"
    ADD CONSTRAINT "sam_sessions_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "public"."sam_practice_plan_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_sessions"
    ADD CONSTRAINT "sam_sessions_snippet_id_fkey" FOREIGN KEY ("snippet_id") REFERENCES "public"."sam_snippets"("id");



ALTER TABLE ONLY "public"."sam_sessions"
    ADD CONSTRAINT "sam_sessions_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id");



ALTER TABLE ONLY "public"."sam_sessions"
    ADD CONSTRAINT "sam_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_snippets"
    ADD CONSTRAINT "sam_snippets_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_snippets"
    ADD CONSTRAINT "sam_snippets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sam_song_fingerings"
    ADD CONSTRAINT "sam_song_fingerings_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_song_lyrics"
    ADD CONSTRAINT "sam_song_lyrics_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_song_measures"
    ADD CONSTRAINT "sam_song_measures_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_song_scores"
    ADD CONSTRAINT "sam_song_scores_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "public"."sam_songs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sam_songs"
    ADD CONSTRAINT "sam_songs_parent_song_id_fkey" FOREIGN KEY ("parent_song_id") REFERENCES "public"."sam_songs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sam_songs"
    ADD CONSTRAINT "sam_songs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."wb_accounts"
    ADD CONSTRAINT "wb_accounts_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_accounts"
    ADD CONSTRAINT "wb_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_balance_snapshots"
    ADD CONSTRAINT "wb_balance_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."wb_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_balance_snapshots"
    ADD CONSTRAINT "wb_balance_snapshots_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_balance_snapshots"
    ADD CONSTRAINT "wb_balance_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_holding_snapshots"
    ADD CONSTRAINT "wb_holding_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."wb_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_holding_snapshots"
    ADD CONSTRAINT "wb_holding_snapshots_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_holding_snapshots"
    ADD CONSTRAINT "wb_holding_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_merchants"
    ADD CONSTRAINT "wb_merchants_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_merchants"
    ADD CONSTRAINT "wb_merchants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_planned_items"
    ADD CONSTRAINT "wb_planned_items_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_planned_items"
    ADD CONSTRAINT "wb_planned_items_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."wb_merchants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_planned_items"
    ADD CONSTRAINT "wb_planned_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."wb_projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_planned_items"
    ADD CONSTRAINT "wb_planned_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_planned_item_id_fkey" FOREIGN KEY ("planned_item_id") REFERENCES "public"."wb_planned_items"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_split_id_fkey" FOREIGN KEY ("split_id") REFERENCES "public"."wb_splits"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."wb_transactions"("id");



ALTER TABLE ONLY "public"."wb_planned_matches"
    ADD CONSTRAINT "wb_planned_matches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_planned_skips"
    ADD CONSTRAINT "wb_planned_skips_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_planned_skips"
    ADD CONSTRAINT "wb_planned_skips_planned_item_id_fkey" FOREIGN KEY ("planned_item_id") REFERENCES "public"."wb_planned_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_planned_skips"
    ADD CONSTRAINT "wb_planned_skips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_projects"
    ADD CONSTRAINT "wb_projects_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_projects"
    ADD CONSTRAINT "wb_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_rule_health_acks"
    ADD CONSTRAINT "wb_rule_health_acks_acked_by_fkey" FOREIGN KEY ("acked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_rule_health_acks"
    ADD CONSTRAINT "wb_rule_health_acks_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_rule_health_acks"
    ADD CONSTRAINT "wb_rule_health_acks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_rules"
    ADD CONSTRAINT "wb_rules_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_rules"
    ADD CONSTRAINT "wb_rules_created_from_transaction_id_fkey" FOREIGN KEY ("created_from_transaction_id") REFERENCES "public"."wb_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_rules"
    ADD CONSTRAINT "wb_rules_set_merchant_id_fkey" FOREIGN KEY ("set_merchant_id") REFERENCES "public"."wb_merchants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_rules"
    ADD CONSTRAINT "wb_rules_set_project_id_fkey" FOREIGN KEY ("set_project_id") REFERENCES "public"."wb_projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_rules"
    ADD CONSTRAINT "wb_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_settings"
    ADD CONSTRAINT "wb_settings_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_settings"
    ADD CONSTRAINT "wb_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."wb_tag_groups"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_replaced_rule_id_fkey" FOREIGN KEY ("replaced_rule_id") REFERENCES "public"."wb_rules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."wb_rules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_split_id_fkey" FOREIGN KEY ("split_id") REFERENCES "public"."wb_splits"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."wb_tags"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_split_tags"
    ADD CONSTRAINT "wb_split_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_splits"
    ADD CONSTRAINT "wb_splits_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_splits"
    ADD CONSTRAINT "wb_splits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."wb_projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_splits"
    ADD CONSTRAINT "wb_splits_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."wb_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_splits"
    ADD CONSTRAINT "wb_splits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_subscription_prices"
    ADD CONSTRAINT "wb_subscription_prices_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_subscription_prices"
    ADD CONSTRAINT "wb_subscription_prices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."wb_subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_subscription_prices"
    ADD CONSTRAINT "wb_subscription_prices_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."wb_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_subscription_prices"
    ADD CONSTRAINT "wb_subscription_prices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_subscriptions"
    ADD CONSTRAINT "wb_subscriptions_billed_through_id_fkey" FOREIGN KEY ("billed_through_id") REFERENCES "public"."wb_subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_subscriptions"
    ADD CONSTRAINT "wb_subscriptions_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."wb_subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_subscriptions"
    ADD CONSTRAINT "wb_subscriptions_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_subscriptions"
    ADD CONSTRAINT "wb_subscriptions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."wb_merchants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_subscriptions"
    ADD CONSTRAINT "wb_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."wb_rules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."wb_tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."wb_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_tag_exclusions"
    ADD CONSTRAINT "wb_tag_exclusions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_tag_groups"
    ADD CONSTRAINT "wb_tag_groups_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_tag_groups"
    ADD CONSTRAINT "wb_tag_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_tags"
    ADD CONSTRAINT "wb_tags_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_tags"
    ADD CONSTRAINT "wb_tags_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."wb_tag_groups"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_tags"
    ADD CONSTRAINT "wb_tags_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."wb_tags"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_tags"
    ADD CONSTRAINT "wb_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."wb_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id");



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."wb_merchants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."wb_subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_transfer_pair_id_fkey" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."wb_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."wb_transactions"
    ADD CONSTRAINT "wb_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE "platform"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_owner_read" ON "platform"."audit_log" FOR SELECT TO "authenticated" USING ((("user_id" IS NULL) OR ("user_id" = ("auth"."uid"())::"text")));



CREATE POLICY "Users see own session events" ON "public"."sam_session_events" USING ((EXISTS ( SELECT 1
   FROM "public"."sam_sessions"
  WHERE (("sam_sessions"."id" = "sam_session_events"."session_id") AND ("sam_sessions"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users see own sessions" ON "public"."sam_sessions" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users see own snippets" ON "public"."sam_snippets" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users see own song fingerings" ON "public"."sam_song_fingerings" USING ((EXISTS ( SELECT 1
   FROM "public"."sam_songs"
  WHERE (("sam_songs"."id" = "sam_song_fingerings"."song_id") AND ("sam_songs"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users see own song lyrics" ON "public"."sam_song_lyrics" USING ((EXISTS ( SELECT 1
   FROM "public"."sam_songs"
  WHERE (("sam_songs"."id" = "sam_song_lyrics"."song_id") AND ("sam_songs"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users see own song measures" ON "public"."sam_song_measures" USING ((EXISTS ( SELECT 1
   FROM "public"."sam_songs"
  WHERE (("sam_songs"."id" = "sam_song_measures"."song_id") AND ("sam_songs"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users see own song scores" ON "public"."sam_song_scores" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."sam_songs"
  WHERE (("sam_songs"."id" = "sam_song_scores"."song_id") AND ("sam_songs"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users see own songs" ON "public"."sam_songs" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."allowed_emails" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anyone_can_read_allowed_emails" ON "public"."allowed_emails" FOR SELECT USING (true);



ALTER TABLE "public"."apps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "apps_read" ON "public"."apps" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."clips" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clips_owner_access" ON "public"."clips" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."collection_item_removals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_item_removals_parent_access" ON "public"."collection_item_removals" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."item_collections" "c"
  WHERE (("c"."id" = "collection_item_removals"."collection_id") AND (("c"."user_id" = "auth"."uid"()) OR ("c"."shared" = true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."item_collections" "c"
  WHERE (("c"."id" = "collection_item_removals"."collection_id") AND (("c"."user_id" = "auth"."uid"()) OR ("c"."shared" = true))))));



ALTER TABLE "public"."collection_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_items_parent_access" ON "public"."collection_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."item_collections" "c"
  WHERE (("c"."id" = "collection_items"."collection_id") AND (("c"."user_id" = "auth"."uid"()) OR ("c"."shared" = true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."item_collections" "c"
  WHERE (("c"."id" = "collection_items"."collection_id") AND (("c"."user_id" = "auth"."uid"()) OR ("c"."shared" = true))))));



ALTER TABLE "public"."contexts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contexts_access" ON "public"."contexts" USING ((("user_id" = "auth"."uid"()) OR ("shared" = true)));



ALTER TABLE "public"."dj_album_tracks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_album_tracks_owner_access" ON "public"."dj_album_tracks" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_albums" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_albums_owner_access" ON "public"."dj_albums" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_artist_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_artist_tags_owner_access" ON "public"."dj_artist_tags" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_artists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_artists_owner_access" ON "public"."dj_artists" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_concerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_concerts_owner_access" ON "public"."dj_concerts" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_feedback" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_feedback_owner_access" ON "public"."dj_feedback" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_known_disagreements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_known_disagreements_owner_access" ON "public"."dj_known_disagreements" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_playlist_tracks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_playlist_tracks_owner" ON "public"."dj_playlist_tracks" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."dj_playlists" "p"
  WHERE (("p"."id" = "dj_playlist_tracks"."playlist_id") AND ("p"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."dj_playlists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_playlists_owner_access" ON "public"."dj_playlists" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_plays" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_plays_owner_access" ON "public"."dj_plays" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_tracks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_tracks_owner_access" ON "public"."dj_tracks" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dj_venues" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dj_venues_owner_access" ON "public"."dj_venues" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."drive_mix_servings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drive_mix_servings_owner_access" ON "public"."drive_mix_servings" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."drive_mix_songs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drive_mix_songs_owner_access" ON "public"."drive_mix_songs" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "events_access" ON "public"."events" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."executions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "executions_access" ON "public"."executions" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."inbox" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inbox_access" ON "public"."inbox" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."intents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "intents_access" ON "public"."intents" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."item_collections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "item_collections_owner" ON "public"."item_collections" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "item_collections_shared_read" ON "public"."item_collections" FOR SELECT USING (("shared" = true));



CREATE POLICY "item_collections_shared_update" ON "public"."item_collections" FOR UPDATE USING (("shared" = true)) WITH CHECK (("shared" = true));



ALTER TABLE "public"."items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "items_access" ON "public"."items" USING ((("user_id" = "auth"."uid"()) OR (("context_id" IS NOT NULL) AND ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR (("context_id" IS NOT NULL) AND ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))));



ALTER TABLE "public"."job_applications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_applications_owner_access" ON "public"."job_applications" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ken_areas" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ken_areas_owner_access" ON "public"."ken_areas" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ken_attempts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ken_attempts_owner_access" ON "public"."ken_attempts" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ken_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ken_items_owner_access" ON "public"."ken_items" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ken_misconceptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ken_misconceptions_owner_access" ON "public"."ken_misconceptions" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notes_delete" ON "public"."notes" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "notes_insert" ON "public"."notes" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND ((("target_type" = 'item'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."items" "i"
  WHERE (("i"."id" = "notes"."target_id") AND (COALESCE("i"."archived", false) = false))))) OR (("target_type" = 'intention'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."intents" "t"
  WHERE (("t"."id" = "notes"."target_id") AND (COALESCE("t"."archived", false) = false)))))) AND (("execution_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."executions" "x"
  WHERE ("x"."id" = "notes"."execution_id"))))));



CREATE POLICY "notes_select" ON "public"."notes" FOR SELECT TO "authenticated" USING (((("target_type" = 'item'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."items" "i"
  WHERE ("i"."id" = "notes"."target_id")))) OR (("target_type" = 'intention'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."intents" "t"
  WHERE ("t"."id" = "notes"."target_id"))))));



CREATE POLICY "notes_update" ON "public"."notes" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK ((("user_id" = "auth"."uid"()) AND ((("target_type" = 'item'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."items" "i"
  WHERE ("i"."id" = "notes"."target_id")))) OR (("target_type" = 'intention'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."intents" "t"
  WHERE ("t"."id" = "notes"."target_id")))))));



ALTER TABLE "public"."notification_steps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_steps_owner_access" ON "public"."notification_steps" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."platform_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_runs_owner_access" ON "public"."platform_runs" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."platform_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_schedules_owner_access" ON "public"."platform_schedules" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "push_subscriptions_owner_access" ON "public"."push_subscriptions" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."reminders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reminders_owner_access" ON "public"."reminders" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."sam_goals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sam_goals_owner_access" ON "public"."sam_goals" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."sam_passes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sam_passes_owner_access" ON "public"."sam_passes" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."sam_practice_plan_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sam_practice_plan_items_owner_access" ON "public"."sam_practice_plan_items" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."sam_practice_plan_songs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sam_practice_plan_songs_owner_access" ON "public"."sam_practice_plan_songs" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."sam_practice_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sam_practice_plans_owner_access" ON "public"."sam_practice_plans" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."sam_session_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_snippets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_song_fingerings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_song_lyrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_song_measures" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_song_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sam_songs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wb_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_accounts_access" ON "public"."wb_accounts" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_balance_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_balance_snapshots_access" ON "public"."wb_balance_snapshots" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_holding_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_holding_snapshots_access" ON "public"."wb_holding_snapshots" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_merchants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_merchants_access" ON "public"."wb_merchants" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_planned_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_planned_items_access" ON "public"."wb_planned_items" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_planned_matches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_planned_matches_access" ON "public"."wb_planned_matches" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_planned_skips" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_planned_skips_access" ON "public"."wb_planned_skips" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_projects_access" ON "public"."wb_projects" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_rule_health_acks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_rule_health_acks_access" ON "public"."wb_rule_health_acks" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_rules_access" ON "public"."wb_rules" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_settings_access" ON "public"."wb_settings" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_split_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_split_tags_access" ON "public"."wb_split_tags" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_splits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_splits_access" ON "public"."wb_splits" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_subscription_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_subscription_prices_access" ON "public"."wb_subscription_prices" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_subscriptions_access" ON "public"."wb_subscriptions" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_tag_exclusions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_tag_exclusions_access" ON "public"."wb_tag_exclusions" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_tag_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_tag_groups_access" ON "public"."wb_tag_groups" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_tags_access" ON "public"."wb_tags" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



ALTER TABLE "public"."wb_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wb_transactions_access" ON "public"."wb_transactions" USING ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true))))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("context_id" IN ( SELECT "contexts"."id"
   FROM "public"."contexts"
  WHERE ("contexts"."shared" = true)))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."alfred_recent_completions"("p_item_id" "text", "p_intent_id" "text", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."alfred_recent_completions"("p_item_id" "text", "p_intent_id" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."alfred_recent_completions"("p_item_id" "text", "p_intent_id" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."apps_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."apps_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."apps_touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."bump_song_edited_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."bump_song_edited_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bump_song_edited_at"() TO "service_role";



GRANT ALL ON TABLE "public"."reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."reminders" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_reminder"("p_text" "text", "p_due_at" timestamp with time zone, "p_inbox_id" "text", "p_intent_id" "text", "p_created_by" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_reminder"("p_text" "text", "p_due_at" timestamp with time zone, "p_inbox_id" "text", "p_intent_id" "text", "p_created_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_reminder"("p_text" "text", "p_due_at" timestamp with time zone, "p_inbox_id" "text", "p_intent_id" "text", "p_created_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_album_coverage"("p_status" "text", "p_tag" "text", "p_limit" integer, "p_album_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dj_album_coverage"("p_status" "text", "p_tag" "text", "p_limit" integer, "p_album_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_album_coverage"("p_status" "text", "p_tag" "text", "p_limit" integer, "p_album_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_artist_activity"("p_window_days" integer, "p_limit" integer, "p_tag" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."dj_artist_activity"("p_window_days" integer, "p_limit" integer, "p_tag" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_artist_activity"("p_window_days" integer, "p_limit" integer, "p_tag" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_fold_artist"("p_artist" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."dj_fold_artist"("p_artist" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_fold_artist"("p_artist" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_playlist_engagement"("p_playlist_ids" "uuid"[], "p_window_days" integer, "p_recent_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dj_playlist_engagement"("p_playlist_ids" "uuid"[], "p_window_days" integer, "p_recent_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_playlist_engagement"("p_playlist_ids" "uuid"[], "p_window_days" integer, "p_recent_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_tag_candidates"("p_window_days" integer, "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dj_tag_candidates"("p_window_days" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_tag_candidates"("p_window_days" integer, "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_tag_coverage"("p_tag" "text", "p_window_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dj_tag_coverage"("p_tag" "text", "p_window_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_tag_coverage"("p_tag" "text", "p_window_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."dj_tag_review"("p_tag" "text", "p_source" "text", "p_window_days" integer, "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dj_tag_review"("p_tag" "text", "p_source" "text", "p_window_days" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dj_tag_review"("p_tag" "text", "p_source" "text", "p_window_days" integer, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."drive_mix_pick"("p_date" "date", "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean, "p_recency" "jsonb", "p_last_serving" "jsonb", "p_play_days" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."drive_mix_pick"("p_date" "date", "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean, "p_recency" "jsonb", "p_last_serving" "jsonb", "p_play_days" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."drive_mix_pick"("p_date" "date", "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean, "p_recency" "jsonb", "p_last_serving" "jsonb", "p_play_days" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."drive_mix_simulate"("p_start" "date", "p_days" integer, "p_heard_per_day" integer, "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."drive_mix_simulate"("p_start" "date", "p_days" integer, "p_heard_per_day" integer, "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."drive_mix_simulate"("p_start" "date", "p_days" integer, "p_heard_per_day" integer, "p_count" integer, "p_artist_cap" integer, "p_quotas" "jsonb", "p_cooldown_days" integer, "p_new_share" numeric, "p_familiar_days" integer, "p_familiar_gap_days" integer, "p_familiar_slices_exempt" "text"[], "p_familiar_breaks_cooldown" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."drive_mix_songs_set_artist_key"() TO "anon";
GRANT ALL ON FUNCTION "public"."drive_mix_songs_set_artist_key"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."drive_mix_songs_set_artist_key"() TO "service_role";



GRANT ALL ON TABLE "public"."drive_mix_songs" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_mix_songs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."drive_mix_sweep"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."drive_mix_sweep"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."drive_mix_sweep"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."executions_last_completed"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."executions_last_completed"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_platform_contract"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_platform_contract"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_platform_contract"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_schema_info"("target_table" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_schema_info"("target_table" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_schema_info"("target_table" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."inbox_outcome_valid"("p_outcome" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."inbox_outcome_valid"("p_outcome" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inbox_outcome_valid"("p_outcome" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."inbox_set_source_app"() TO "anon";
GRANT ALL ON FUNCTION "public"."inbox_set_source_app"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."inbox_set_source_app"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."intents_last_completed"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."intents_last_completed"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ken_record_attempts"("p_attempts" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."ken_record_attempts"("p_attempts" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ken_record_attempts"("p_attempts" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."ken_items" TO "authenticated";
GRANT ALL ON TABLE "public"."ken_items" TO "service_role";



GRANT ALL ON FUNCTION "public"."ken_select_batch"("p_limit" integer, "p_area_id" "uuid", "p_mode" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."ken_select_batch"("p_limit" integer, "p_area_id" "uuid", "p_mode" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ken_select_batch"("p_limit" integer, "p_area_id" "uuid", "p_mode" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."last_completed_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."last_completed_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."last_completed_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notes_delete_for_target"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notes_delete_for_target"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notes_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."notes_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notes_touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."platform_check_call_budget"("p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."platform_check_call_budget"("p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."platform_check_call_budget"("p_tool" "text", "p_args_hash" "text", "p_window_seconds" integer, "p_max_calls" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."platform_check_conformance"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."platform_check_conformance"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."platform_check_conformance"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."platform_recent_audit"("p_limit" integer, "p_actor" "text", "p_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."platform_recent_audit"("p_limit" integer, "p_actor" "text", "p_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."platform_recent_audit"("p_limit" integer, "p_actor" "text", "p_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."platform_search_executions"("p_intent_id" "text", "p_context_id" "text", "p_date_from" "date", "p_date_to" "date", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."platform_search_executions"("p_intent_id" "text", "p_context_id" "text", "p_date_from" "date", "p_date_to" "date", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."platform_search_executions"("p_intent_id" "text", "p_context_id" "text", "p_date_from" "date", "p_date_to" "date", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."platform_search_items"("p_context_id" "text", "p_search_text" "text", "p_tags" "text"[], "p_limit" integer, "p_status" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."platform_search_items"("p_context_id" "text", "p_search_text" "text", "p_tags" "text"[], "p_limit" integer, "p_status" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."platform_search_items"("p_context_id" "text", "p_search_text" "text", "p_tags" "text"[], "p_limit" integer, "p_status" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."recalc_last_completed_intent"("p_intent_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recalc_last_completed_intent"("p_intent_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."recalc_last_completed_item"("p_item_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recalc_last_completed_item"("p_item_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_lookup_tables"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_lookup_tables"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_lookup_tables"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reminders_follow_intent_archive"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reminders_follow_intent_archive"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reminders_follow_intent_archive"() TO "service_role";



GRANT ALL ON FUNCTION "public"."reminders_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."reminders_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reminders_touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_sam_song_scores"("p_song_id" "uuid", "p_scores_version" integer, "p_computed_from" timestamp with time zone, "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_sam_song_scores"("p_song_id" "uuid", "p_scores_version" integer, "p_computed_from" timestamp with time zone, "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_sam_song_scores"("p_song_id" "uuid", "p_scores_version" integer, "p_computed_from" timestamp with time zone, "p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_record"("p_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_record"("p_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_record"("p_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_create_practice_plan"("p_plan" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_create_practice_plan"("p_plan" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_create_practice_plan"("p_plan" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_default_warmup_ladder"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_default_warmup_ladder"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_default_warmup_ladder"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sam_goals_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."sam_goals_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_goals_touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_plan_item_progress"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_plan_item_progress"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_plan_item_progress"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_plan_unplanned_practice"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_plan_unplanned_practice"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_plan_unplanned_practice"("p_plan_id" "uuid", "p_from" "date", "p_to" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."sam_practice_plans_guard_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."sam_practice_plans_guard_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_practice_plans_guard_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sam_practice_reject_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."sam_practice_reject_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_practice_reject_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_resolve_warmup_ladder"("p_song_id" "uuid", "p_snippet_id" "uuid", "p_plan_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_resolve_warmup_ladder"("p_song_id" "uuid", "p_snippet_id" "uuid", "p_plan_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_resolve_warmup_ladder"("p_song_id" "uuid", "p_snippet_id" "uuid", "p_plan_item_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_song_scores_freshness"("p_song_id" "uuid", "p_scores_version" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_song_scores_freshness"("p_song_id" "uuid", "p_scores_version" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_song_scores_freshness"("p_song_id" "uuid", "p_scores_version" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sam_songs_fill_goal_tempo"() TO "anon";
GRANT ALL ON FUNCTION "public"."sam_songs_fill_goal_tempo"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_songs_fill_goal_tempo"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sam_songs_mark_goal_set"() TO "anon";
GRANT ALL ON FUNCTION "public"."sam_songs_mark_goal_set"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_songs_mark_goal_set"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sam_warmup_ladder_is_valid"("p_ladder" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sam_warmup_ladder_is_valid"("p_ladder" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sam_warmup_ladder_is_valid"("p_ladder" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."stamp_song_edited"() TO "anon";
GRANT ALL ON FUNCTION "public"."stamp_song_edited"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."stamp_song_edited"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."stamp_songs_from_measure_statement"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."stamp_songs_from_measure_statement"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."stamp_songs_from_measure_statement"() TO "service_role";



GRANT ALL ON FUNCTION "public"."status_activate_on_event"() TO "anon";
GRANT ALL ON FUNCTION "public"."status_activate_on_event"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."status_activate_on_event"() TO "service_role";



GRANT ALL ON FUNCTION "public"."status_activate_on_execution"() TO "anon";
GRANT ALL ON FUNCTION "public"."status_activate_on_execution"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."status_activate_on_execution"() TO "service_role";



GRANT ALL ON FUNCTION "public"."status_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."status_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."status_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_modified_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_modified_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_modified_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_apply_fix"("p_transaction_id" "uuid", "p_set_kind" "text", "p_add_tag_ids" "uuid"[], "p_pattern" "text", "p_merchant_name" "text", "p_update_rule_id" "uuid", "p_add_new_rule" boolean, "p_notes" "text", "p_created_by" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_apply_fix"("p_transaction_id" "uuid", "p_set_kind" "text", "p_add_tag_ids" "uuid"[], "p_pattern" "text", "p_merchant_name" "text", "p_update_rule_id" "uuid", "p_add_new_rule" boolean, "p_notes" "text", "p_created_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_apply_fix"("p_transaction_id" "uuid", "p_set_kind" "text", "p_add_tag_ids" "uuid"[], "p_pattern" "text", "p_merchant_name" "text", "p_update_rule_id" "uuid", "p_add_new_rule" boolean, "p_notes" "text", "p_created_by" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_apply_tags"("p_transaction_ids" "uuid"[], "p_tag_ids" "uuid"[], "p_source" "text", "p_remove_tag_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_apply_tags"("p_transaction_ids" "uuid"[], "p_tag_ids" "uuid"[], "p_source" "text", "p_remove_tag_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_apply_tags"("p_transaction_ids" "uuid"[], "p_tag_ids" "uuid"[], "p_source" "text", "p_remove_tag_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_bulk_create"("p_payload" "jsonb", "p_context_id" "text", "p_dry_run" boolean, "p_created_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_bulk_create"("p_payload" "jsonb", "p_context_id" "text", "p_dry_run" boolean, "p_created_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_bulk_create"("p_payload" "jsonb", "p_context_id" "text", "p_dry_run" boolean, "p_created_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_burn_rate_on"("p_today" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_burn_rate_on"("p_today" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_burn_rate_on"("p_today" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_cash_projection"("p_include_drafts" boolean, "p_today" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_cash_projection"("p_include_drafts" boolean, "p_today" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_cash_projection"("p_include_drafts" boolean, "p_today" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_clean_description"("p_raw" "text", "p_strip_location" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_clean_description"("p_raw" "text", "p_strip_location" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_clean_description"("p_raw" "text", "p_strip_location" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_confirm_planned_match"("p_match_id" "uuid", "p_action" "text", "p_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."wb_confirm_planned_match"("p_match_id" "uuid", "p_action" "text", "p_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_confirm_planned_match"("p_match_id" "uuid", "p_action" "text", "p_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_default_kind"("p_account_role" "text", "p_amount" numeric, "p_description" "text", "p_payee" "text", "p_merchant_kind" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_default_kind"("p_account_role" "text", "p_amount" numeric, "p_description" "text", "p_payee" "text", "p_merchant_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_default_kind"("p_account_role" "text", "p_amount" numeric, "p_description" "text", "p_payee" "text", "p_merchant_kind" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_detect_subscriptions"("p_today" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_detect_subscriptions"("p_today" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_detect_subscriptions"("p_today" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_fix_plan"("p_transaction_id" "uuid", "p_pattern" "text", "p_merchant_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_fix_plan"("p_transaction_id" "uuid", "p_pattern" "text", "p_merchant_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_fix_plan"("p_transaction_id" "uuid", "p_pattern" "text", "p_merchant_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_free_cash"("p_include_drafts" boolean, "p_today" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_free_cash"("p_include_drafts" boolean, "p_today" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_free_cash"("p_include_drafts" boolean, "p_today" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_is_fee_phrase"("p_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_is_fee_phrase"("p_text" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_is_fee_phrase"("p_text" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_is_interest_phrase"("p_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_is_interest_phrase"("p_text" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_is_interest_phrase"("p_text" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_is_p2p_phrase"("p_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_is_p2p_phrase"("p_text" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_is_p2p_phrase"("p_text" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_is_transfer_phrase"("p_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_is_transfer_phrase"("p_text" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_is_transfer_phrase"("p_text" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_link_subscription"("p_transaction_ids" "uuid"[], "p_subscription_id" "uuid", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_link_subscription"("p_transaction_ids" "uuid"[], "p_subscription_id" "uuid", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_link_subscription"("p_transaction_ids" "uuid"[], "p_subscription_id" "uuid", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_monthly_equivalent"("p_amount" numeric, "p_interval_count" integer, "p_interval_unit" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_monthly_equivalent"("p_amount" numeric, "p_interval_count" integer, "p_interval_unit" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_monthly_equivalent"("p_amount" numeric, "p_interval_count" integer, "p_interval_unit" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_pair_decision"("p_forward" integer, "p_reverse" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_pair_decision"("p_forward" integer, "p_reverse" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_pair_decision"("p_forward" integer, "p_reverse" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_planned_left"("p_amount" numeric, "p_paid" numeric, "p_tolerance" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."wb_planned_left"("p_amount" numeric, "p_paid" numeric, "p_tolerance" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_planned_left"("p_amount" numeric, "p_paid" numeric, "p_tolerance" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_planned_matches_fill"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_planned_matches_fill"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_planned_matches_fill"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_planned_occurrences"("p_from" "date", "p_to" "date", "p_include_drafts" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."wb_planned_occurrences"("p_from" "date", "p_to" "date", "p_include_drafts" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_planned_occurrences"("p_from" "date", "p_to" "date", "p_include_drafts" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_planned_skips_fill"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_planned_skips_fill"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_planned_skips_fill"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_planned_start_from_history"("p_merchant_id" "uuid", "p_amount" numeric, "p_amount_tolerance" numeric, "p_today" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_planned_start_from_history"("p_merchant_id" "uuid", "p_amount" numeric, "p_amount_tolerance" numeric, "p_today" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_planned_start_from_history"("p_merchant_id" "uuid", "p_amount" numeric, "p_amount_tolerance" numeric, "p_today" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_process_transactions"("ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_process_transactions"("ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_process_transactions"("ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_refresh_subscriptions"("p_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."wb_refresh_subscriptions"("p_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_refresh_subscriptions"("p_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_replace_splits"("p_transaction_id" "uuid", "p_splits" "jsonb", "p_source" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_replace_splits"("p_transaction_id" "uuid", "p_splits" "jsonb", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_replace_splits"("p_transaction_id" "uuid", "p_splits" "jsonb", "p_source" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_rule_matches"("p_match" "jsonb", "p_account_id" "uuid", "p_amount" numeric, "p_payee" "text", "p_description" "text", "p_clean" "text", "p_merchant_id" "uuid", "p_kind" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_rule_matches"("p_match" "jsonb", "p_account_id" "uuid", "p_amount" numeric, "p_payee" "text", "p_description" "text", "p_clean" "text", "p_merchant_id" "uuid", "p_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_rule_matches"("p_match" "jsonb", "p_account_id" "uuid", "p_amount" numeric, "p_payee" "text", "p_description" "text", "p_clean" "text", "p_merchant_id" "uuid", "p_kind" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_rule_preview"("p_match" "jsonb", "p_pattern" "text", "p_samples" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_rule_preview"("p_match" "jsonb", "p_pattern" "text", "p_samples" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_rule_preview"("p_match" "jsonb", "p_pattern" "text", "p_samples" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_rules_check_tags"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_rules_check_tags"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_rules_check_tags"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_set_transfer_pair"("p_id" "uuid", "p_pair_with" "uuid", "p_source" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_set_transfer_pair"("p_id" "uuid", "p_pair_with" "uuid", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_set_transfer_pair"("p_id" "uuid", "p_pair_with" "uuid", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_split_tags_fill"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_split_tags_fill"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_split_tags_fill"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_splits_check_sum"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_splits_check_sum"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_splits_check_sum"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_splits_copy_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_splits_copy_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_splits_copy_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_splits_fill_project_source"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_splits_fill_project_source"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_splits_fill_project_source"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_subscription_occurrences"("p_from" "date", "p_to" "date", "p_today" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_subscription_occurrences"("p_from" "date", "p_to" "date", "p_today" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_subscription_occurrences"("p_from" "date", "p_to" "date", "p_today" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_subscription_price_on"("p_subscription_id" "uuid", "p_on" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_subscription_price_on"("p_subscription_id" "uuid", "p_on" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_subscription_price_on"("p_subscription_id" "uuid", "p_on" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_subscription_prices_copy_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_subscription_prices_copy_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_subscription_prices_copy_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_subscriptions_fill_interval"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_subscriptions_fill_interval"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_subscriptions_fill_interval"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_subscriptions_fill_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_subscriptions_fill_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_subscriptions_fill_owner"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_suggest_pattern"("p_payee" "text", "p_clean" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_suggest_pattern"("p_payee" "text", "p_clean" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_suggest_pattern"("p_payee" "text", "p_clean" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_suggest_planned_matches"("p_transaction_ids" "uuid"[], "p_planned_item_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."wb_suggest_planned_matches"("p_transaction_ids" "uuid"[], "p_planned_item_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_suggest_planned_matches"("p_transaction_ids" "uuid"[], "p_planned_item_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_tag_exclusions_copy_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_tag_exclusions_copy_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_tag_exclusions_copy_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_tag_groups_push_exclusive"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_tag_groups_push_exclusive"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_tag_groups_push_exclusive"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_tags_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_tags_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_tags_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_transactions_amount_follow"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_transactions_amount_follow"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_transactions_amount_follow"() TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_transactions_default_split"() TO "anon";
GRANT ALL ON FUNCTION "public"."wb_transactions_default_split"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_transactions_default_split"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."wb_transfer_match"("p_a_account" "uuid", "p_a_amount" numeric, "p_a_date" "date", "p_b_account" "uuid", "p_b_amount" numeric, "p_b_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."wb_transfer_match"("p_a_account" "uuid", "p_a_amount" numeric, "p_a_date" "date", "p_b_account" "uuid", "p_b_amount" numeric, "p_b_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_transfer_match"("p_a_account" "uuid", "p_a_amount" numeric, "p_a_date" "date", "p_b_account" "uuid", "p_b_amount" numeric, "p_b_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."wb_unconfirm_planned_match"("p_match_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."wb_unconfirm_planned_match"("p_match_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."wb_unconfirm_planned_match"("p_match_id" "uuid") TO "service_role";



GRANT SELECT ON TABLE "platform"."audit_log" TO "authenticated";



GRANT ALL ON TABLE "public"."allowed_emails" TO "authenticated";
GRANT ALL ON TABLE "public"."allowed_emails" TO "service_role";
GRANT SELECT ON TABLE "public"."allowed_emails" TO "anon";



GRANT ALL ON TABLE "public"."apps" TO "authenticated";
GRANT ALL ON TABLE "public"."apps" TO "service_role";



GRANT ALL ON TABLE "public"."clips" TO "authenticated";
GRANT ALL ON TABLE "public"."clips" TO "service_role";



GRANT ALL ON TABLE "public"."collection_item_removals" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_item_removals" TO "service_role";



GRANT ALL ON TABLE "public"."collection_items" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_items" TO "service_role";



GRANT ALL ON TABLE "public"."contexts" TO "authenticated";
GRANT ALL ON TABLE "public"."contexts" TO "service_role";



GRANT ALL ON TABLE "public"."dj_album_tracks" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_album_tracks" TO "service_role";



GRANT ALL ON TABLE "public"."dj_albums" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_albums" TO "service_role";



GRANT ALL ON TABLE "public"."dj_artist_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_artist_tags" TO "service_role";



GRANT ALL ON TABLE "public"."dj_artists" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_artists" TO "service_role";



GRANT ALL ON TABLE "public"."dj_concerts" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_concerts" TO "service_role";



GRANT ALL ON TABLE "public"."dj_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."dj_known_disagreements" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_known_disagreements" TO "service_role";



GRANT ALL ON TABLE "public"."dj_playlist_tracks" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_playlist_tracks" TO "service_role";



GRANT ALL ON TABLE "public"."dj_playlists" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_playlists" TO "service_role";



GRANT ALL ON TABLE "public"."dj_plays" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_plays" TO "service_role";



GRANT ALL ON TABLE "public"."dj_tracks" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_tracks" TO "service_role";



GRANT ALL ON TABLE "public"."dj_venues" TO "authenticated";
GRANT ALL ON TABLE "public"."dj_venues" TO "service_role";



GRANT ALL ON TABLE "public"."drive_mix_servings" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_mix_servings" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."executions" TO "authenticated";
GRANT ALL ON TABLE "public"."executions" TO "service_role";



GRANT ALL ON TABLE "public"."inbox" TO "authenticated";
GRANT ALL ON TABLE "public"."inbox" TO "service_role";



GRANT ALL ON TABLE "public"."intents" TO "authenticated";
GRANT ALL ON TABLE "public"."intents" TO "service_role";



GRANT ALL ON TABLE "public"."item_collections" TO "authenticated";
GRANT ALL ON TABLE "public"."item_collections" TO "service_role";



GRANT ALL ON TABLE "public"."items" TO "authenticated";
GRANT ALL ON TABLE "public"."items" TO "service_role";



GRANT ALL ON TABLE "public"."job_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."job_applications" TO "service_role";



GRANT ALL ON TABLE "public"."ken_areas" TO "authenticated";
GRANT ALL ON TABLE "public"."ken_areas" TO "service_role";



GRANT ALL ON TABLE "public"."ken_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."ken_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."ken_misconceptions" TO "authenticated";
GRANT ALL ON TABLE "public"."ken_misconceptions" TO "service_role";



GRANT ALL ON TABLE "public"."notes" TO "authenticated";
GRANT ALL ON TABLE "public"."notes" TO "service_role";



GRANT ALL ON TABLE "public"."notification_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_steps" TO "service_role";



GRANT ALL ON TABLE "public"."platform_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_runs" TO "service_role";



GRANT ALL ON TABLE "public"."platform_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."sam_goals" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_goals" TO "service_role";



GRANT ALL ON TABLE "public"."sam_passes" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_passes" TO "service_role";



GRANT ALL ON TABLE "public"."sam_practice_plan_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_practice_plan_items" TO "service_role";



GRANT ALL ON TABLE "public"."sam_practice_plan_songs" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_practice_plan_songs" TO "service_role";



GRANT ALL ON TABLE "public"."sam_practice_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_practice_plans" TO "service_role";



GRANT ALL ON TABLE "public"."sam_session_events" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_session_events" TO "service_role";



GRANT ALL ON TABLE "public"."sam_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."sam_snippets" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_snippets" TO "service_role";



GRANT ALL ON TABLE "public"."sam_song_fingerings" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_song_fingerings" TO "service_role";



GRANT ALL ON TABLE "public"."sam_song_lyrics" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_song_lyrics" TO "service_role";



GRANT ALL ON TABLE "public"."sam_song_measures" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_song_measures" TO "service_role";



GRANT ALL ON TABLE "public"."sam_song_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_song_scores" TO "service_role";



GRANT ALL ON TABLE "public"."sam_songs" TO "authenticated";
GRANT ALL ON TABLE "public"."sam_songs" TO "service_role";



GRANT ALL ON TABLE "public"."wb_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."wb_balance_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_balance_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."wb_account_latest" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_account_latest" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_burn_rate" TO "anon";
GRANT ALL ON TABLE "public"."wb_burn_rate" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_burn_rate" TO "service_role";



GRANT ALL ON TABLE "public"."wb_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."wb_cash_flow_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_cash_flow_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."wb_holding_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_holding_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."wb_merchants" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_merchants" TO "service_role";



GRANT ALL ON TABLE "public"."wb_net_worth_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_net_worth_daily" TO "service_role";



GRANT ALL ON TABLE "public"."wb_planned_items" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_planned_items" TO "service_role";



GRANT ALL ON TABLE "public"."wb_planned_matches" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_planned_matches" TO "service_role";



GRANT ALL ON TABLE "public"."wb_planned_skips" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_planned_skips" TO "service_role";



GRANT ALL ON TABLE "public"."wb_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_projects" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_planned_unmatched" TO "anon";
GRANT ALL ON TABLE "public"."wb_planned_unmatched" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_planned_unmatched" TO "service_role";



GRANT ALL ON TABLE "public"."wb_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_settings" TO "service_role";



GRANT ALL ON TABLE "public"."wb_splits" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_splits" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_project_summary" TO "anon";
GRANT ALL ON TABLE "public"."wb_project_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_project_summary" TO "service_role";



GRANT ALL ON TABLE "public"."wb_split_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_split_tags" TO "service_role";



GRANT ALL ON TABLE "public"."wb_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."wb_tag_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_tag_groups" TO "service_role";



GRANT ALL ON TABLE "public"."wb_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_tags" TO "service_role";



GRANT ALL ON TABLE "public"."wb_review_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_review_queue" TO "service_role";



GRANT ALL ON TABLE "public"."wb_rule_health_acks" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_rule_health_acks" TO "service_role";



GRANT ALL ON TABLE "public"."wb_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_rules" TO "service_role";



GRANT ALL ON TABLE "public"."wb_tag_exclusions" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_tag_exclusions" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_rule_health_all" TO "anon";
GRANT ALL ON TABLE "public"."wb_rule_health_all" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_rule_health_all" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_rule_health" TO "anon";
GRANT ALL ON TABLE "public"."wb_rule_health" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_rule_health" TO "service_role";



GRANT ALL ON TABLE "public"."wb_spending_by_tag" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_spending_by_tag" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_subscription_outflows" TO "anon";
GRANT ALL ON TABLE "public"."wb_subscription_outflows" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_subscription_outflows" TO "service_role";



GRANT ALL ON TABLE "public"."wb_subscription_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_subscription_prices" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_subscription_overview" TO "anon";
GRANT ALL ON TABLE "public"."wb_subscription_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_subscription_overview" TO "service_role";



GRANT ALL ON TABLE "public"."wb_transaction_list" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_transaction_list" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."wb_true_cost" TO "anon";
GRANT ALL ON TABLE "public"."wb_true_cost" TO "authenticated";
GRANT ALL ON TABLE "public"."wb_true_cost" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







