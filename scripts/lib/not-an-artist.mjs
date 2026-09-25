// Bylines that are a scraped YouTube page run rather than an act — spec §14.9.
//
// ytmusicapi returns a video's subtitle runs as `artists`. For a "- Topic"
// channel song those runs really are artists; for an ordinary uploaded video
// they are `channel · views · upload date`, and record_dj_playlist passes them
// through unfiltered (dj-playlists.ts filters by TYPE, never content). So
// dj_tracks.artist carries strings like "Jazz and Blues Experience, 1.7M views"
// and "Dec 29, 2023".
//
// 🛑 THIS IS A BACKFILL-SCOPE FILTER, NOT A NORMALISATION RULE, AND IT LIVES
// HERE RATHER THAN IN dj-normalise.ts DELIBERATELY. Nothing shipped may start
// silently dropping a byline: the row would then look repaired when the artist
// is still wrong. All this does is keep such rows OUT of the re-key, because
// re-keying "Dec 29, 2023" to `dec 29` is meaningless — it moves a wrong row to
// a differently wrong key. Repairing the artist itself is a hand-built value
// table, the shape of migration 007.
//
// Every pattern must match a WHOLE byline segment. A rule that matched a
// substring would eat real names.

const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

export const NOT_AN_ARTIST_PATTERNS = [
  // Upload dates, in the forms YouTube renders them.
  new RegExp(`^(?:${MONTH})[a-z]*\\.?\\s+\\d{1,2},?\\s*\\d{4}$`, "i"),  // Dec 29, 2023
  new RegExp(`^\\d{1,2}\\s+(?:${MONTH})[a-z]*\\.?,?\\s*\\d{4}$`, "i"),  // 29 Dec 2023
  new RegExp(`^(?:${MONTH})[a-z]*\\.?\\s+\\d{4}$`, "i"),                // Dec 2023
  /^\d{4}-\d{2}-\d{2}$/,                                               // 2023-12-29
  /^(?:premiered|streamed live|updated)\b.*$/i,
  // View counts. "No views" is a real YouTube string on an unwatched upload.
  /^(?:no|\d[\d.,]*\s*[km]?)\s+views?$/i,
  // Other page furniture seen on non-Topic uploads.
  /^\d+\s+(?:songs?|videos?|tracks?|episodes?)$/i,
];

/** True when a byline segment is page furniture rather than an act. */
export function isNotAnArtist(segment) {
  const s = String(segment ?? "").trim();
  if (!s) return false;
  return NOT_AN_ARTIST_PATTERNS.some((re) => re.test(s));
}

/** True when ANY segment of a byline is page furniture. One bad run condemns
 *  the row: "Jazz and Blues Experience, 1.7M views" is not a collaboration
 *  between a channel and a view count. */
export function bylineHasPageFurniture(byline, parts) {
  return isNotAnArtist(byline) || (parts ?? []).some(isNotAnArtist);
}
