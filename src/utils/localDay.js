/**
 * The Pacific day boundary.
 *
 * Pure functions — no side effects, no app imports, no React.
 *
 * "Since midnight" in Alfred means midnight in America/Los_Angeles. Not UTC,
 * and not whatever timezone the device happens to be set to: a phone carried to
 * another timezone, or one with a wrong clock, must still see the same
 * shopping list as the phone sitting at home.
 *
 * Nothing here reads the device's timezone or its clock, except as the default
 * "what time is it now" argument. Every calculation is anchored to an explicit
 * IANA zone through Intl, so the result is identical on every device.
 *
 * ─── Why this is not SAM's helper ───────────────────────────────────────────
 *
 * `src/sam/lib/practiceTimeFormat.js` already has a Pacific date toolkit and it
 * is good, but it returns date KEYS ("2026-09-14"), not instants, and it lives
 * under `src/sam/`. Alfred reaching into SAM's internals would create a new
 * cross-app dependency in the wrong direction. This is a separate, small,
 * tested function; SAM is not touched. If the two are ever unified, that is its
 * own errand.
 */

const TZ = "America/Los_Angeles";

const PACIFIC_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const PACIFIC_DATE_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * How far Pacific wall-clock time sits from UTC at a given instant, in
 * milliseconds. Negative west of Greenwich: -7h during PDT, -8h during PST.
 *
 * Works by asking Intl what the Pacific wall clock reads at that instant, then
 * treating that reading as though it were UTC. The gap between that and the
 * real instant is the offset.
 *
 * `+p.hour % 24` is not paranoia: with hour12:false some ICU versions render
 * midnight as "24" rather than "00".
 */
function zoneOffsetMs(instant) {
  const p = Object.fromEntries(
    PACIFIC_PARTS.formatToParts(instant).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour % 24,
    +p.minute,
    +p.second,
  );
  return asUTC - instant.getTime();
}

/**
 * The instant at which the current Pacific calendar day began.
 *
 * Returns a Date — a real point in time — suitable for comparing against a
 * server timestamp. `collection_item_removals.removed_at` is filled by a
 * Postgres column default, so comparing it against this value trusts the
 * server's clock on one side and an IANA rule on the other, and the device's
 * clock nowhere except in deciding which day "today" is.
 *
 * The offset is resolved twice on purpose. The first pass asks for the offset
 * at midnight UTC on the target date, which is mid-afternoon the day before in
 * Pacific terms; on a daylight-saving changeover that can be the wrong side of
 * the transition. The second pass re-asks at the instant the first pass
 * produced, which is the actual candidate midnight, and is therefore correct.
 *
 * @param {Date} [now] - Defaults to the current time. Only used to decide which
 *   Pacific calendar day we are in.
 * @returns {Date} Midnight Pacific, as an instant.
 */
export function startOfPacificDay(now = new Date()) {
  const key = PACIFIC_DATE_KEY.format(now);
  const naive = Date.parse(`${key}T00:00:00Z`);
  const firstPass = naive - zoneOffsetMs(new Date(naive));
  return new Date(naive - zoneOffsetMs(new Date(firstPass)));
}
