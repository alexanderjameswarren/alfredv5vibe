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


// ---------------------------------------------------------------------------
// Variant cuts — A READ-TIME RULE, AND IT DOES NOT FEED match_key
// ---------------------------------------------------------------------------
//
// ⚠️ SEPARATE FROM QUALIFIER_RES ABOVE, DELIBERATELY, BECAUSE THEY ANSWER
// DIFFERENT QUESTIONS. QUALIFIER_RES asks "are these the same song for
// GROUPING" and is frozen at write (§4.1.2). This asks "is this recording a
// variant cut" at READ time — nothing here is stored, so editing it is a deploy
// and not a backfill.
//
// It mirrors `_VARIANT_RE` in workshop/workshop/tools/dj_setlists.py, which uses
// it to refuse resolving a setlist entry to a live or karaoke recording. The
// same vocabulary now decides §12.10's per-title cram tie-break: you learn a
// song from the studio cut, not from a 2006 live recording of it.
//
// ⚠️ TWO RUNTIMES AGAIN, SO IT IS PINNED THE SAME WAY. `shared/dj-title-cases.json`
// carries a `variant_cuts` block asserted by BOTH suites. This is the exact
// duplication that let the qualifier vocabulary drift (§14.6); it does not get a
// second chance to do it quietly.
//
// `instrumental` IS here and is deliberately ABSENT from QUALIFIER_RES. An
// instrumental cut is plausibly a distinct recording worth counting on its own
// (grouping), and is still not what a setlist entry is asking for (resolution).
// The two rules disagree because the two questions do.
export const VARIANT_MARKER_RE =
  /\b(live|acoustic|remix|karaoke|instrumental|demo|radio edit|session|cover|tribute|originally performed)\b/i;

/** Is this title a variant cut rather than the studio recording? */
export function isVariantCut(title: string | null | undefined): boolean {
  return VARIANT_MARKER_RE.test(title ?? "");
}

// ---------------------------------------------------------------------------
// Artist aliases — one act, two vocabularies
// ---------------------------------------------------------------------------
//
// ⚠️ SAME MIGRATION RULE AS THE STRIPPING VOCABULARY (spec §4.1.2). This feeds
// match_key AND dj_tracks.artist, both written once and never updated. Adding
// or changing an entry does NOT re-key rows already stored. Edit spec §4.1.4 in
// the same commit.
//
// WHY A CONSTANT AND NOT A TABLE. A table is read at RUNTIME while match_key is
// frozen at WRITE, so an edit on a Tuesday makes rows written Monday and
// Wednesday differ — with no code change, no deploy, and nothing recording why.
// That is spec §11.6 with the worst possible axis: table state as a silent
// input to identity, leaving no trace at all. A constant is in git, versioned
// with the code that reads it, and cannot drift from its reader.
//
// WHY THESE ARE HAND-CURATED AND NOT DERIVED. A rule like "strip a trailing
// Trio/Quartet" cannot be validated and would merge genuinely distinct acts.
// Every entry here is a human decision about a real act, which is the only
// thing that makes the map checkable — see the note on Miles Davis below.
//
// DIRECTION: canonicalise to the POLL's vocabulary (YouTube Music's artist
// metadata), NOT the Takeout channel name — even though the export is the
// larger population. Takeout is a ONE-TIME import; the poll writes forever. So
// translating toward the poll applies the map once at import and never again,
// while translating toward the export would apply it on every future poll and
// require rewriting rows already stored.
//
// Measured 2026-08-30: the two vocabularies are each internally consistent —
// 0 split pairs among the export's 1,206 artists, and 0 among the poll's — so
// this is not a naming mess. It is two consistent systems meeting at one
// boundary, which is why the map needs so few entries.

interface ArtistAlias {
  /** The spelling to REPLACE — the Takeout `- Topic` channel name. */
  from: string;
  /** The spelling to KEEP — what YouTube Music's artist metadata says. */
  to: string;
  /** Why these are the same act. Recorded because the next entry will be added
   *  by someone without today's context, and hand-curation is only better than
   *  a derived rule if the reasoning survives. */
  why: string;
}

export const ARTIST_ALIASES: ArtistAlias[] = [
  {
    from: "Eddie Higgins",
    to: "Eddie Higgins Trio",
    why:
      "Eddie Higgins was a jazz pianist who recorded almost exclusively in a " +
      "piano-trio format; the Venus Records albums in this library are billed " +
      "to the trio. YouTube's - Topic channel carries the bare personal name " +
      "while YouTube Music's metadata carries the billed ensemble name. Same " +
      "act, same recordings — 5 tracks already stored under the ensemble name " +
      "against 25 further videos on the channel.",
  },
  {
    from: "The Red Garland Trio",
    to: "Red Garland",
    why:
      "Red Garland the pianist and the Red Garland Trio are the same act for " +
      "familiarity purposes — the trio is his working group and the Prestige " +
      "recordings here are his. Note the DIRECTION IS OPPOSITE to Eddie " +
      "Higgins: here the channel carries the ensemble name and the metadata " +
      "carries the personal one. That reversal is why no automatic rule works " +
      "— 'prefer the longer form' would fix one entry and break the other.",
  },
];

// ⚠️ MILES DAVIS IS DELIBERATELY NOT AN ENTRY, and is the case that shows this
// map cannot be automated.
//
// Miles Davis (132 videos, the largest artist in the export) has led the First
// and Second Great Quintets, sextets, and large-ensemble sessions across four
// decades. "Miles Davis" and "The Miles Davis Quintet" are not obviously one
// act for familiarity purposes: a listener deep in Kind of Blue has not thereby
// heard Bitches Brew. Whether to merge them is a JUDGMENT CALL about how this
// user thinks about that catalogue, and it has not arisen — no such split
// exists in the data today. If it ever does, it needs deciding, not inferring.

const ALIAS_BY_KEY = new Map(
  ARTIST_ALIASES.map((a) => [a.from.trim().toLowerCase(), a.to]),
);

/**
 * Translate an artist name into the canonical vocabulary. Applied to the
 * PRIMARY artist only, since that is what match_key uses.
 *
 * Deliberately NOT conditional on source. A source-conditional rule could be
 * bypassed by a mislabelled import, and the poll never submits an alias key
 * anyway, so applying it universally is a no-op there.
 */
export function canonicalArtist(name: string): string {
  if (!name) return name;
  return ALIAS_BY_KEY.get(name.trim().toLowerCase()) ?? name;
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
  // Alias translation happens BEFORE normalisation, so the map keys stay
  // readable ('The Red Garland Trio') rather than normalised mush.
  const primary = canonicalArtist(artists && artists.length > 0 ? artists[0] : "");
  let t = normalisePart(title);
  // A title that is ENTIRELY a qualifier ("(Live)") strips to nothing. Fall
  // back to plain tidying so it still groups with itself across variants.
  if (!t) t = tidy(title.toLowerCase());
  if (!t) return null;
  return `${normalisePart(primary)}|${t}`;
}

// ---------------------------------------------------------------------------
// Artist-vocabulary disagreement - spec 4.1.4
// ---------------------------------------------------------------------------
//
// ONE implementation, used by the write path AND the dry run. If the two
// compared on different bases the dry run would predict disagreements the write
// would not report, which is the failure mode the shared prepareRows exists to
// prevent.
//
// WHY NOT COMPARE dj_tracks.artist DIRECTLY. That column holds the JOINED
// display string - `artists.join(", ")`. A poll row for a collaboration stores
// "Coldplay, BTS"; a Takeout row for the same video submits "Coldplay", because
// the export carries only the "- Topic" channel and so knows exactly one artist.
// Comparing those two strings fires on EVERY collaboration while nothing is
// actually wrong: match_key uses artists[0] alone, both sides agree on the
// primary, and the two rows group identically.
//
// A detector that fires on every collaboration is one its reader learns to
// ignore, and then it will not catch the real case. Same shape as marking an
// empty day "failed".
//
// WHY THE MATCH KEY AND NOT A SPLIT OF THE JOINED COLUMN. Splitting
// "Coldplay, BTS" on ", " looks equivalent and is not: artist names contain
// commas. "Earth, Wind & Fire", "Crosby, Stills & Nash" and "Tyler, The
// Creator" would each yield a wrong primary and a false disagreement - the
// exact bug being fixed, moved somewhere harder to see.
//
// match_key is `normalisePart(canonicalArtist(artists[0])) + "|" + normalisePart(title)`,
// and `tidy` replaces every non-letter/non-digit run, so a "|" CANNOT survive
// normalisation. The first "|" is therefore unambiguously the separator, and
// the text before it is the stored primary artist exactly as the grouping rules
// saw it. No parsing guess involved.
//
// The comparison is on NORMALISED primaries, deliberately. Two spellings that
// normalise identically group identically, so they are not a split and there is
// nothing to report.

/** The stored primary artist, normalised, recovered from a match_key. Returns
 *  null when there is no key or the artist half is empty (a track stored with
 *  no artist at all). */
export function primaryArtistOfMatchKey(matchKey: string | null | undefined): string | null {
  if (!matchKey) return null;
  const i = matchKey.indexOf("|");
  if (i <= 0) return null;
  return matchKey.slice(0, i);
}

export interface ArtistDisagreement {
  video_id: string;
  /** Human-readable, for the report: the full joined strings. */
  stored: string | null;
  submitted: string | null;
  /** What actually differs, and what the comparison was made on. */
  stored_primary: string;
  submitted_primary: string;
}

/** Returns a disagreement only when the NORMALISED PRIMARY artists differ.
 *  Null when they agree, or when either side cannot be determined.
 *
 *  BOTH primaries are read out of a match_key, so both have been through the
 *  identical derivation - alias translation, qualifier stripping, tidy - by
 *  construction rather than by two call sites remembering to agree. Passing the
 *  submitted artists[] here instead would re-derive it a second way, which is
 *  how a detector starts reporting differences that are its own. */
export function detectArtistDisagreement(
  videoId: string,
  storedArtistDisplay: string | null,
  storedMatchKey: string | null | undefined,
  submittedArtistDisplay: string | null,
  submittedMatchKey: string | null | undefined,
): ArtistDisagreement | null {
  const storedPrimary = primaryArtistOfMatchKey(storedMatchKey);
  const submittedPrimary = primaryArtistOfMatchKey(submittedMatchKey);
  // Cannot compare is NOT the same as agrees; report neither.
  if (!storedPrimary || !submittedPrimary) return null;
  if (storedPrimary === submittedPrimary) return null;
  return {
    video_id: videoId,
    stored: storedArtistDisplay,
    submitted: submittedArtistDisplay,
    stored_primary: storedPrimary,
    submitted_primary: submittedPrimary,
  };
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
