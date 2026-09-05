-- OPTIONAL second gate — does pg_net actually reach an edge function?
--
-- The cron probe proves the scheduler runs. It does NOT prove pg_net can make
-- an outbound HTTP call, and those are separate failure modes: the dispatcher
-- needs both. Discovering pg_net is blocked after the function is written is
-- the expensive order to find out.
--
-- This calls the EXISTING push-send function, which requires a JWT it will not
-- get, so a 401 comes back. That is a PASS: a 401 proves the request left the
-- database and an edge function answered. Nothing is sent.

-- Fire one request.
select net.http_post(
  url     := 'https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/push-send',
  headers := '{"Content-Type": "application/json"}'::jsonb,
  body    := '{}'::jsonb
) as request_id;

-- Read the response a few seconds later.
-- PASS: status_code is 401 (or any HTTP status) — the call completed.
-- FAIL: no row, or an error_msg about connectivity — pg_net cannot reach out,
--       and the dispatcher will need a different trigger mechanism.
select id, status_code, content_type, timed_out, error_msg,
       left(content, 200) as body_preview
from net._http_response
order by id desc
limit 5;
