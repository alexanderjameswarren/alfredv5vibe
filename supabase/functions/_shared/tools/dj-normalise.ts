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
//
// ---------------------------------------------------------------------------
// ⚠️ 2026-09-19 — THE DAVE BRUBECK ENTRY IS AN EXCEPTION, NOT AN APPLICATION
// ---------------------------------------------------------------------------
//
// An earlier version of this note claimed the poll had CHANGED its vocabulary
// for this act. That was wrong and is retracted (spec §4.1.4). Migration 058
// returned all 26 Brubeck rows written on ONE DAY, 2026-08-31, by the Takeout
// import — THE POLL HAS NEVER WRITTEN A BRUBECK ROW. The 2025-05-05 date that
// suggested otherwise is an earliest PLAY, back-dated by the import, not a write
// date.
//
// So this is the designed case: Takeout wrote one form, the poll sends another.
// 🛑 APPLIED UNAMENDED, THE RULE ABOVE WOULD GIVE THE OPPOSITE ENTRY —
// "Dave Brubeck Quartet" -> "The Dave Brubeck Quartet".
//
// WHY THE EXCEPTION STANDS ANYWAY: the rule's justification is that translating
// toward the poll "applies the map once at import and never again". FOR THIS ACT
// THAT BENEFIT IS ALREADY SPENT — the import ran without the entry, so 26 rows
// are stored untranslated against a frozen match_key (§4.1.2). Following the rule
// now means a BACKFILL of those rows plus every artist-string dependent
// (dj_artist_tags, playlist membership), which is precisely what the rule exists
// to avoid.
//
// ⚠️ THE COST OF THE EXCEPTION IS REAL AND IS NOT HIDDEN: this map is no longer
// uniformly Takeout->poll, which is why two invariants below had to be falsified.
// Reversing it is a live option if uniformity is worth the backfill. Nothing
// downstream is wrong either way today — both spellings converge on one
// match_key, because normalisePart lowercases.

interface ArtistAlias {
  /** The spelling to REPLACE. ⚠️ NO LONGER ALWAYS A TAKEOUT CHANNEL NAME — see
   *  the Dave Brubeck entry, where the POLL is the source sending this form.
   *  The invariant "the poll never submits an alias key" was true for the first
   *  two entries and is false from the third. */
  from: string;
  /** The spelling to KEEP. Canonically what YouTube Music's metadata says —
   *  EXCEPT where the poll changed its own vocabulary after rows were written,
   *  in which case it is what is already stored and cannot be re-keyed. */
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
    from: "The Dave Brubeck Quartet",
    to: "Dave Brubeck Quartet",
    why:
      "⚠️ THE FIRST ENTRY WHOSE `from` IS A POLL STRING, NOT A TAKEOUT CHANNEL " +
      "NAME. The poll reported this act as 'Dave Brubeck Quartet' from " +
      "2025-05-05 and began sending 'The Dave Brubeck Quartet' by 2026-09-19; " +
      "one page of live history carried three tracks under the new form " +
      "(Blue Rondo A La Turk, Three to Get Ready, Koto Song), all stored under " +
      "the old one. This is not two vocabularies disagreeing — it is ONE " +
      "vocabulary changing era, which the DIRECTION rule above did not " +
      "anticipate and has been amended for. " +
      "DIRECTION IS TOWARD WHAT IS ALREADY STORED because 86 play rows across " +
      "24 groups carry the bare form and match_key is frozen at write (§4.1.2); " +
      "mapping the other way would re-key every one of them. " +
      "MusicBrainz is not an argument either way: get_dj_setlists is keyed on " +
      "mbid and refuses names outright, so no display name ever reaches " +
      "setlist.fm. " +
      "⚠️ ONLY ONE TRACK WAS FLAGGED because artist_disagreements fires per " +
      "SUBMITTED row and the sync submits only unheld plays — the other 23 " +
      "groups will flag one at a time as each is next played, and are the same " +
      "finding rather than new ones.",
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
  {
    from: "Art Blakey & The Jazz Messengers",
    to: "Art Blakey",
    why:
      "The Jazz Messengers were Blakey's own working band for 35 years, led by " +
      "him throughout and named as his vehicle; the Blue Note sides in this " +
      "library are billed both ways on the same recordings. Unlike Miles Davis " +
      "there is no catalogue split to lose — no era of Blakey here is NOT the " +
      "Messengers, so merging them cannot make a familiarity answer wrong. " +
      "DIRECTION IS TOWARD WHAT IS ALREADY STORED, as with Dave Brubeck and " +
      "against the default rule: fsJ3JjpZyoA is stored 'Art Blakey' and the " +
      "poll is sending the ensemble form, so mapping this way needs no backfill " +
      "and re-keys nothing (§4.1.2).",
  },
  {
    from: "Ahmad Jamal Trio",
    to: "Ahmad Jamal",
    why:
      "Ahmad Jamal the pianist and the Ahmad Jamal Trio are one act for " +
      "familiarity purposes — the trio is his working group and the Argo " +
      "recordings here are his, the same argument as Red Garland one entry up. " +
      "DIRECTION IS TOWARD WHAT IS ALREADY STORED: JDOUyH7VJ3Y is stored " +
      "'Ahmad Jamal' and the poll is sending 'Ahmad Jamal Trio', so this needs " +
      "no backfill. Note this is the OPPOSITE direction to Eddie Higgins on the " +
      "identical shape of name, which is §4.1.4's whole point: the vocabularies " +
      "reverse per act and no automatic Trio rule can work.",
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

// ---------------------------------------------------------------------------
// Placeholder bylines — NOT aliases, and deliberately beside them
// ---------------------------------------------------------------------------
//
// ⚠️ A PLACEHOLDER IS THE OPPOSITE OF AN ALIAS AND MUST NEVER BECOME ONE.
// An alias says "these two spellings are one act". A placeholder says "this
// string names no act at all" — it is a compilation's stand-in billing, and the
// six 2026-09-22 rows are the case: stored "Various Artists", submitted
// "Charlie Parker, Dizzy Gillespie, Bud Powell, Max Roach". Aliasing
// "Various Artists" to Charlie Parker would assert that every compilation in
// the library is a Parker record. So these are SUPPRESSED FROM THE DETECTOR,
// not translated: nothing is claimed about identity, and no match_key moves.
//
// 🛑 DELIBERATELY NOT HERE: "Release", and the page labels beside it in
// scripts/dj-label-artist-audit.js ("Topic", "Album", "Single", "Mix", …).
// Those are a DIFFERENT defect — a scraped YouTube page label that the parser
// correctly read from wrong source data (§14.9) — and the 12 unrepaired
// `Release` rows are a DECIDED, PERMANENT disagreement recorded in
// dj_known_disagreements and listed in docs/dj-known-disagreements.md. They are
// meant to keep surfacing through that partition, which is what proves the
// pipeline ran and CHOSE silence. Folding them in here would delete that
// evidence and repair nothing.
//
// Matched on the NORMALISED PRIMARY, so case, punctuation and the ", " tail of
// a byline are already handled. Every entry must be a string that cannot also
// be a real act: "Live" is a real band (§ the same audit script's own note), so
// nothing of that shape belongs here.
export const PLACEHOLDER_ARTISTS: string[] = [
  "Various Artists",  // the compilation billing YouTube Music sends; in the data
  "Various",
  "VA",
  "Unknown Artist",
  "Unknown",
  "No Artist",
];

const PLACEHOLDER_KEYS = new Set(PLACEHOLDER_ARTISTS.map((p) => normalisePart(p)));

/** True when a normalised primary names no act — a compilation stand-in rather
 *  than a spelling. Takes the ALREADY-NORMALISED primary, so callers cannot
 *  match on a second, differently-derived form. */
export function isPlaceholderArtist(normalisedPrimary: string | null): boolean {
  return normalisedPrimary !== null && PLACEHOLDER_KEYS.has(normalisedPrimary);
}

const ALIAS_BY_KEY = new Map(
  ARTIST_ALIASES.map((a) => [a.from.trim().toLowerCase(), a.to]),
);

/**
 * Translate an artist name into the canonical vocabulary. Applied to the
 * PRIMARY artist only, since that is what match_key uses.
 *
 * Deliberately NOT conditional on source. A source-conditional rule could be
 * bypassed by a mislabelled import.
 *
 * ⚠️ IT IS NO LONGER A NO-OP ON THE POLL. That was true while every `from` was a
 * Takeout channel name; the Dave Brubeck entry is a poll string, so this now
 * translates on every poll for that act — by design, and the reason is in the
 * DIRECTION note above. Source-conditional would have been ACTIVELY WRONG here,
 * which is a second argument for the unconditional form rather than only the
 * mislabelled-import one.
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
// WHY NOT COMPARE dj_tracks.artist DIRECTLY, UNSPLIT. That column holds the
// JOINED display string - `artists.join(", ")`. A poll row for a collaboration
// stores "Coldplay, BTS"; a Takeout row for the same video submits "Coldplay",
// because the export carries only the "- Topic" channel and so knows exactly one
// artist. Comparing those two whole strings fires on EVERY collaboration while
// nothing is actually wrong: only the primary artist decides identity, both
// sides agree on it, and the two rows group together.
//
// A detector that fires on every collaboration is one its reader learns to
// ignore, and then it will not catch the real case. Same shape as marking an
// empty day "failed".
//
// ⚠️ IT USED TO READ BOTH PRIMARIES OUT OF A match_key, AND THAT IS THE BUG
// FIXED HERE (run 91151897, 2026-09-23: 19 of 21 flags false). A match_key is
// built by whichever call site wrote the row, and the call sites disagree about
// what `artists[]` is. record_dj_album passes the whole byline as ONE element
// (`artists: ["Clifford Brown, Max Roach"]`), so its key carries
// "clifford brown max roach" as the primary; the poll passes the names SPLIT
// (`["Clifford Brown", "Max Roach"]`), so its key carries "clifford brown".
// Two identical bylines, two different primaries, a disagreement reported
// between a string and itself. Reading a stored key is reading whatever
// tokenisation the writer happened to use.
//
// ⚠️ AND WHY SPLITTING ON THE COMMA IS SAFE HERE, THOUGH THE NOTE THIS REPLACES
// ARGUED IT WAS NOT. The old argument: "Earth, Wind & Fire", "Crosby, Stills &
// Nash" and "Tyler, The Creator" contain commas, so a split yields a wrong
// primary. True — but a wrong primary is only a wrong ANSWER if the two sides
// derive it differently. Both sides go through the one function below, so the
// same string always yields the same primary and IDENTICAL INPUT CANNOT BE
// FLAGGED, whatever the split does to it. "Count Basie Orchestra, Joe Williams,
// Lambert, Hendricks & Ross" is the live case: the split mangles it, both sides
// identically, and it agrees with itself. The residual risk is the opposite and
// much milder - two genuinely different acts sharing a first comma-token would
// agree quietly, where before they would have been reported.
//
// The comparison is on NORMALISED primaries with the alias map applied,
// deliberately. Two spellings that normalise or alias identically group
// identically, so they are not a split and there is nothing to report.

/** The stored primary artist, normalised, recovered from a match_key. Returns
 *  null when there is no key or the artist half is empty (a track stored with
 *  no artist at all).
 *
 *  ⚠️ NOT THE BASIS OF THE DISAGREEMENT CHECK ANY MORE, and must not become it
 *  again - see the note above. It reflects the tokenisation of whichever call
 *  site wrote the row, which is a fact about the writer, not about the act. */
export function primaryArtistOfMatchKey(matchKey: string | null | undefined): string | null {
  if (!matchKey) return null;
  const i = matchKey.indexOf("|");
  if (i <= 0) return null;
  return matchKey.slice(0, i);
}

/** The primary artist, normalised and alias-translated, from a display byline
 *  (`dj_tracks.artist`, or the same string as submitted).
 *
 *  ⚠️ THE ONE DERIVATION. Both sides of detectArtistDisagreement call this and
 *  nothing else, so identical inputs give identical primaries BY CONSTRUCTION
 *  rather than by two call sites remembering to agree - which is exactly what
 *  they stopped doing.
 *
 *  Alias translation runs AFTER the split and BEFORE normalisation, matching
 *  buildMatchKey, so the map keys stay readable. No alias `from` may contain a
 *  comma or the split would reach it first; a test pins that. */
export function primaryArtistOfDisplay(display: string | null | undefined): string | null {
  if (!display) return null;
  const first = display.split(",")[0].trim();
  if (!first) return null;
  return normalisePart(canonicalArtist(first)) || null;
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
 *  BOTH primaries come from primaryArtistOfDisplay, so both have been through
 *  the identical derivation - split, alias translation, qualifier stripping,
 *  tidy. Passing a stored match_key here instead would re-derive one side a
 *  second way, which is how a detector starts reporting differences that are
 *  its own. */
export function detectArtistDisagreement(
  videoId: string,
  storedArtistDisplay: string | null,
  submittedArtistDisplay: string | null,
): ArtistDisagreement | null {
  const storedPrimary = primaryArtistOfDisplay(storedArtistDisplay);
  const submittedPrimary = primaryArtistOfDisplay(submittedArtistDisplay);
  // Cannot compare is NOT the same as agrees; report neither.
  if (!storedPrimary || !submittedPrimary) return null;
  // A placeholder on EITHER side is also cannot-compare, not disagreement: one
  // of the two strings names no act, so there is no second vocabulary to be in
  // conflict with. See PLACEHOLDER_ARTISTS - it suppresses, it does not alias.
  if (isPlaceholderArtist(storedPrimary) || isPlaceholderArtist(submittedPrimary)) return null;
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
