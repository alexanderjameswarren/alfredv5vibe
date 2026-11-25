// sb3_pages-h6v C1 (s19): the small formatters today's approve page and the run pages share. They lived in
// ApprovePage.jsx; look.js imported them from there, so ApprovePage couldn't import look.js without a circular import.
// ApprovePage.jsx re-exports them, so its callers are unchanged.

/** The stamp's first 12 characters, as sb prints it. */
export const shortStamp = (stamp) => String(stamp ?? '').slice(0, 12);

/** A hash's first 12 characters. */
export const shortHash = (h) => String(h ?? '').slice(0, 12);

/** An ISO time in the viewer's local time, or the text as given if it doesn't parse. */
export function localTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? String(iso ?? '') : new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
