// Talking to the clip-capture edge function.
//
// Two endpoints and one upload, in the order spec decision 7 requires: START,
// which writes nothing and hands back single-use upload links; the uploads
// themselves; then FINISH, which verifies the slices are really in storage before
// it writes a row. No row can ever point at a file that is not there.

/**
 * POST JSON with the shared secret.
 *
 * The secret rides in `x-clipboard-secret`, which the function checks with a
 * length test plus timingSafeEqual before it reads the body. A 401 comes back as
 * a bare `{"ok":false,"error":"unauthorized"}` with no hint about why, so the
 * message below supplies the likely cause rather than passing that through.
 */
async function post(baseUrl, secret, path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-clipboard-secret": secret },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${baseUrl}${path}: ${e.message}. Check the address on the ` +
        `options page, and that you are online.`,
    );
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall through to the raw text */ }

  if (!res.ok || json?.ok === false) {
    if (res.status === 401) {
      throw new Error(
        "The server refused the secret (401). Open the options page and re-paste " +
          "CLIPBOARD_SECRET — it must match the value set with `supabase secrets set` exactly.",
      );
    }
    const detail = json?.error || text.slice(0, 300) || `HTTP ${res.status}`;
    // `missing` comes from /finish's slice verification and names the files it
    // could not find, which is the one thing worth surfacing verbatim.
    const missing = Array.isArray(json?.missing) && json.missing.length
      ? ` Missing: ${json.missing.join(", ")}.`
      : "";
    throw new Error(`${path} failed (${res.status}): ${detail}${missing}`);
  }
  if (!json) throw new Error(`${path} returned something that is not JSON: ${text.slice(0, 200)}`);
  return json;
}

export function startClip(baseUrl, secret, sliceCount) {
  return post(baseUrl, secret, "/start", { slice_count: sliceCount });
}

export function finishClip(baseUrl, secret, payload) {
  return post(baseUrl, secret, "/finish", payload);
}

/**
 * PUT one slice to its single-use signed link.
 *
 * Straight to Supabase Storage, not through the function: the extension never
 * holds a Supabase key or session (decision 6), and a multi-megabyte body has no
 * business passing through an edge function that would only forward it.
 */
export async function uploadSlice(signedUrl, blob) {
  let res;
  try {
    res = await fetch(signedUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
  } catch (e) {
    throw new Error(`A slice upload could not reach storage: ${e.message}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // 400 here is usually the bucket's own rules: 2 MB per object, image/jpeg
    // only. Both are set in migration 063.
    throw new Error(
      `A slice upload was refused (${res.status}): ${body}. The clipboard bucket ` +
        `accepts image/jpeg up to 2 MB per slice.`,
    );
  }
}
