/**
 * The Web Push send options, shared by notify-dispatch and push-send.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The two functions had DIFFERENT options — the dispatcher sent `TTL: 3600`,
 * the diagnostic `TTL: 60` — so the button used to test delivery was not
 * testing the path that actually delivers. A diagnostic that exercises
 * different behaviour from the thing it diagnoses is worse than none.
 *
 * ── 🛑 Urgency, and the ten-minute-late notification ───────────────────────
 *
 * A step was sent at 17:25 and arrived at 17:35, the moment the phone was
 * picked up. The endpoint was live, the subscription was current, and FCM's 201
 * was truthful. This was **Android Doze** holding the message until the device
 * woke.
 *
 * Web Push carries an `Urgency` header and FCM uses it to decide whether a
 * message may break through Doze. `very-low`, `low` and `normal` are all
 * deferrable; **`high` is delivered promptly**.
 *
 * web-push defaults Urgency to **`normal`**, so every notification this system
 * has ever sent was in the deferrable class. For a timed reminder, arriving on
 * time is the entire point — there is no weaker urgency that makes sense here.
 *
 * Verified against npm:web-push@3.6.7 rather than assumed:
 *
 *   - the option key is lowercase `urgency`; `Urgency` throws
 *     "'Urgency' is an invalid option";
 *   - values are lowercase from `very-low | low | normal | high`; `HIGH` throws
 *     "Unsupported urgency specified";
 *   - it becomes the `Urgency` request header;
 *   - the default TTL with no options at all is **2419200 seconds — 28 days**.
 *
 * ── TTL ────────────────────────────────────────────────────────────────────
 *
 * 28 days is absurd for a reminder: a phone that has been off since Tuesday
 * would be told to take Tuesday's dose. A reminder that arrives hours late is
 * worse than one that never arrives, so this is deliberately short.
 *
 * ⚠️ The interaction worth knowing: a step is marked `sent` as soon as ONE
 * endpoint returns 201, and it is never re-sent. So if the TTL expires while
 * the device is unreachable, that notification is lost permanently — the row
 * stays `sent` and the chain waits for a manual tick. A shorter TTL trades
 * "late" for "never", which is the trade being chosen here on purpose.
 */

export const PUSH_SEND_OPTIONS = {
  // Break through Doze. Anything lower is deferrable, which is what caused a
  // ten-minute-late reminder on an idle phone.
  urgency: "high" as const,

  // 15 minutes. Long enough to survive a tunnel or a brief drop, short enough
  // that a stale reminder is dropped rather than delivered hours later.
  TTL: 900,
};
