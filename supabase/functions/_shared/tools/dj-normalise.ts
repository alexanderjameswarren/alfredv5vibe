// DJ normalisation — match_key construction and bucket→date resolution.
//
// Deliberately import-free. Everything here is pure, and keeping it clear of
// the Supabase client means it can be unit-tested under plain Node with type
// stripping (see dj-normalise.test.mjs) without a Deno toolchain. dj-courier.ts
// imports from here; nothing else should need to.
//
// ⚠️ READ SPEC §4.1.2 BEFORE CHANGING ANY RULE IN THIS FILE.
//
// dj_tracks is insert-only and match_key / canonical_track_id are written ONCE,
// never updated. So improving a stripping rule here does NOT regroup tracks
// already imported — the old and new populations would disagree invisibly.
// A change to this file is a backfill migration, not a deploy. The rules are
// mirrored in prose in spec §4.1.1; edit both in the same commit.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The ONLY tokens that trigger stripping. Anything unrecognised is kept.
 *
 * Matching is by vocabulary, never by position. A rule like "strip everything
 * after a dash" destroys `Undone - The Sweater Song` — a real title in the
 * Weezer playlist, where the dashed half IS the song name. It matches nothing
 * here, so it survives. `(Reprise)` survives too: a reprise is different music.
 *
 * `instrumental` is deliberately absent. In a library with a jazz arm an
 * instrumental cut is plausibly a distinct recording worth counting on its own.
 * Revisit with evidence, not by assumption.
 */
export const QUALIFIER_RES: RegExp[] = [
  /^(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?$/,
  /^live(?:\s+(?:at|from|in)\b.*)?$/,
  /^(?:deluxe|anniversary|expanded)(?:\s+edition)?$/,
  /^(?:single|album)\s+version$/,
  /^radio\s+(?:edit|version)$/,
  /^extended(?:\s+(?:version|mix))?$/,
  /^(?:mono|stereo)$/,
  /^bonus\s+track$/,
  /^(?:explicit|clean|acoustic|demo)$/,
];

// `with` marks a feature ONLY inside a parenthetical — "Go Away (with Bethany
// Cosentino)". Bare, it is ordinary English ("Sitting With You"), and stripping
// on it would eat real titles.
const FEATURE_PAREN_RE = /^(?:feat\.?|ft\.?|featuring|with)\b/;
const FEATURE_INLINE_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/;

function isQualifier(inner: string): boolean {
  return QUALIFIER_RES.some((re) => re.test(inner));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Drop (…) and […] groups whose contents match the vocabulary. Others stay. */
export function stripQualifierGroups(s: string): string {
  return s.replace(/[([]([^)\]]*)[)\]]/g, (whole, inner: string) => {
    const c = inner.trim();
    return isQualifier(c) || FEATURE_PAREN_RE.test(c) ? " " : whole;
  });
}

/** Drop trailing " - <qualifier>", repeatedly: "Song - Live - Remaster 2011". */
export function stripDashQualifiers(s: string): string {
  let out = s;
  for (;;) {
    const m = /\s[-–—]\s*([^-–—]+)$/.exec(out);
    if (!m) break;
    const c = m[1].trim();
    if (!isQualifier(c) && !FEATURE_PAREN_RE.test(c)) break;
    out = out.slice(0, m.index);
  }
  return out;
}

/** Ampersands, punctuation, whitespace. Apostrophes close up: ain't → aint. */
export function tidy(s: string): string {
  return s
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalisePart(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = stripQualifierGroups(s);
  s = stripDashQualifiers(s);
  s = s.replace(FEATURE_INLINE_RE, "");
  return tidy(s);
}

/**
 * `match_key = normalise(primary artist) + "|" + normalise(title)`.
 *
 * PRIMARY artist only: `artists[]` varies between variants of the same song
 * ("Weezer" on one cut, "Weezer, Bethany Cosentino" on another) and those must
 * group. The full list is still stored in dj_tracks.artist.
 *
 * Returns null when the title normalises away entirely — better no key at all
 * than a key that groups unrelated rows under "".
 */
export function buildMatchKey(
  artists: string[] | undefined,
  title: string,
): string | null {
  const primary = artists && artists.length > 0 ? artists[0] : "";
  let t = normalisePart(title);
  // A title that is ENTIRELY a qualifier ("(Live)") strips to nothing. Fall
  // back to plain tidying so it still groups with itself across variants.
  if (!t) t = tidy(title.toLowerCase());
  if (!t) return null;
  return `${normalisePart(primary)}|${t}`;
}

// ---------------------------------------------------------------------------
// Bucket → date + precision — spec §4.2
// ---------------------------------------------------------------------------

// Estimates skew to the RECENT end of the bucket, deliberately: the question
// this data answers is "how long since I heard this", and a recent-skewed guess
// makes that answer conservative rather than falsely alarming.
export const BUCKET_RESOLUTION: Record<
  string,
  { precision: string; backDays: number }
> = {
  "Today": { precision: "day", backDays: 0 },
  "Yesterday": { precision: "day", backDays: 1 },
  "This week": { precision: "week", backDays: 2 },
  "Last week": { precision: "fortnight", backDays: 9 },
};

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const VALID_PRECISION = ["exact", "day", "week", "fortnight"];
export const VALID_SOURCE = ["poll", "takeout", "manual"];

/** All arithmetic in UTC, so a server timezone can never shift a date. */
export function shiftDate(isoDate: string, backDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - backDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function resolvePlayDate(
  bucket: string,
  pollDate: string,
): { played_on: string; precision: string } {
  const spec = BUCKET_RESOLUTION[bucket];
  if (!spec) {
    throw new Error(
      `unknown played_bucket "${bucket}". Expected one of ` +
        `${Object.keys(BUCKET_RESOLUTION).map((b) => `"${b}"`).join(", ")}. ` +
        `To write a row with a real timestamp instead, pass played_on and ` +
        `precision explicitly.`,
    );
  }
  return {
    played_on: shiftDate(pollDate, spec.backDays),
    precision: spec.precision,
  };
}
