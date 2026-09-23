// Where the extension keeps its two settings, and nothing else.
//
// 🛑 NEITHER VALUE IS EVER IN THE CODE. The secret is typed into the options page
// on each machine and lives only in `chrome.storage.local`. It is not in this
// repository, not in the manifest, and not in any committed file — which is the
// whole reason the options page exists rather than a constant somewhere.
//
// `local` and NOT `sync`: chrome.storage.sync travels through the Google account
// to every signed-in machine. A shared secret should be pasted once per machine
// deliberately, not spread by a browser feature.

/**
 * Pre-filled into the address field so there is one less thing to get wrong.
 * It is only a default — whatever is saved wins, and the field is editable.
 */
export const DEFAULT_BASE_URL =
  "https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/clip-capture";

const KEYS = ["baseUrl", "secret"];

/** @returns {Promise<{baseUrl: string, secret: string}>} trimmed; "" when unset. */
export async function getConfig() {
  const stored = await chrome.storage.local.get(KEYS);
  return {
    baseUrl: (stored.baseUrl || "").trim().replace(/\/+$/, ""),
    secret: (stored.secret || "").trim(),
  };
}

export async function saveConfig({ baseUrl, secret }) {
  await chrome.storage.local.set({
    baseUrl: (baseUrl || "").trim().replace(/\/+$/, ""),
    secret: (secret || "").trim(),
  });
}

/**
 * Is this usable? Returns a human sentence naming what is wrong, or null.
 *
 * The 32-character floor mirrors the check the edge function does on
 * CLIPBOARD_SECRET, so a too-short secret is caught here with a sentence that
 * explains itself rather than as a 500 from the server.
 */
export function configProblem({ baseUrl, secret }) {
  if (!baseUrl) return "No function address saved yet.";
  if (!/^https:\/\/.+/.test(baseUrl)) return "The function address must start with https://";
  if (!secret) return "No secret saved yet.";
  if (secret.length < 32) {
    return `The secret is only ${secret.length} characters. The server requires at least 32, so this would be refused.`;
  }
  return null;
}
