// Copy a record for pasting into a new Claude chat (Restructure P3 step 7).

export const RECORD_LINK_BASE = "https://alfredv5vibe.vercel.app/";

/** "<title>\n\n<description>\n\n<link>", the description block left out when empty. */
export function recordCopyText({ title, description, id }) {
  const parts = [(title || "").trim()];
  const desc = (description || "").trim();
  if (desc) parts.push(desc);
  parts.push(`${RECORD_LINK_BASE}${id}`);
  return parts.join("\n\n");
}

/**
 * Writes the text and reports through `notify(message, { error })`. Without a
 * notify, a failure falls back to an alert so it is never silent.
 */
export async function copyRecord(record, notify) {
  try {
    await navigator.clipboard.writeText(recordCopyText(record));
    notify?.("Copied");
    return true;
  } catch (err) {
    console.error("[copyRecord]", err);
    const message = "Could not copy. The browser refused the clipboard.";
    if (notify) notify(message, { error: true });
    else window.alert(message);
    return false;
  }
}
