-- Remove the stale push_subscriptions row left by a rotation that predates the
-- repair code.
--
-- Only needed once, for rows created before the endpoint ledger existed. From
-- now on the reconciler reaps this browser's own dead rows automatically,
-- because it records every endpoint it stores.
--
-- ⚠️ NEVER delete "every row that is not the current endpoint". Other rows are
-- other DEVICES. Deleting one silently unsubscribes that device with no
-- indication anywhere. Identify the row first, then delete it by id.

-- ── 1. LOOK FIRST. What is actually there? ────────────────────────────────
select id,
       right(endpoint, 20) as endpoint_tail,
       user_agent,
       created_at,
       last_used_at
from public.push_subscriptions
order by created_at;

-- Match this against the diagnostic screen: Games -> Push Notification Test ->
-- "Show table rows" lists the same endpoints and marks which one this device
-- is actually holding. The row marked "THIS DEVICE (live)" is the keeper.

-- ── 2. Confirm the one you mean, by id ────────────────────────────────────
-- Paste the id of the row the app did NOT mark as live.
select id,
       right(endpoint, 20) as endpoint_tail,
       user_agent,
       created_at,
       last_used_at
from public.push_subscriptions
where id = '<STALE_ROW_ID>';

-- Sanity checks before deleting — read these, do not skip them:
--   * endpoint_tail is NOT the tail the app showed as live;
--   * created_at is older than the live row's;
--   * if user_agent differs from your phone's, STOP — it is another device.

-- ── 3. Delete it ──────────────────────────────────────────────────────────
-- delete from public.push_subscriptions where id = '<STALE_ROW_ID>';

-- ── 4. Verify ─────────────────────────────────────────────────────────────
-- Expect exactly the rows you meant to keep — one per real device.
select id, right(endpoint, 20) as endpoint_tail, user_agent, created_at
from public.push_subscriptions
order by created_at;

-- ── Alternative: no SQL at all, from the phone ────────────────────────────
-- Games -> Push Notification Test -> "Show table rows" lists every row with its
-- endpoint tail, marks which one this device is holding, and puts a "Remove"
-- button on the others. The live row cannot be removed that way.
--
-- That is a HUMAN-CONFIRMED delete, not an inferred one: the reconciler still
-- refuses to remove a row it cannot prove this browser created, because a wrong
-- guess silently unsubscribes another device. A person looking at the list can
-- make the judgement the code must not.
