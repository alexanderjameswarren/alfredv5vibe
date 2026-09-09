/**
 * A short, safe fingerprint of a VAPID public key.
 *
 * ── Why this exists, permanently ───────────────────────────────────────────
 *
 * The browser subscribes against `REACT_APP_VAPID_PUBLIC_KEY`, baked into the
 * Vercel build. The server signs with `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
 * from Supabase secrets. **If those are not the same keypair, FCM rejects every
 * send as expired — a 410 on a subscription created seconds earlier**, which
 * looks exactly like a dead subscription and is not one.
 *
 * The dispatcher's keypair assertion cannot catch this: it compares the two
 * SUPABASE values against each other and has no way to see Vercel's. That gap
 * has now cost debugging time at two separate points, so the comparison is
 * built in rather than added and removed each time.
 *
 * `process.env` cannot be read from a browser console — CRA substitutes at
 * build time — so there is no way to compare the two values from a phone unless
 * both sides report them. Both sides now do, through THIS function, so they
 * cannot format differently and make matching keys look mismatched.
 *
 * ⚠️ Never log a whole key. The public half is not a secret, but a log that
 * habitually prints whole keys is one edit away from printing the private one.
 */
export function vapidFingerprint(key) {
  if (typeof key !== "string" || key.length === 0) return "(none)";
  if (key.length <= 16) return `${key} (${key.length} chars)`;
  return `${key.slice(0, 8)}…${key.slice(-8)} (${key.length} chars)`;
}

/**
 * Is this actually a P-256 public key, or merely a string of the right length?
 *
 * An uncompressed P-256 point is **65 bytes**: `0x04`, then a 32-byte X and a
 * 32-byte Y. Unpadded base64url of 65 bytes is 87 characters — which is why
 * "87 chars" reads as reassuring and proves nothing. A truncated, re-encoded or
 * wrong-curve key can be 87 characters and still be rejected by
 * `pushManager.subscribe`, or accepted and then fail at send time.
 *
 * @param {Uint8Array} bytes The decoded applicationServerKey.
 */
export function describeVapidKeyBytes(bytes) {
  if (!bytes || typeof bytes.length !== "number") {
    return { ok: false, detail: "could not decode the key at all" };
  }
  if (bytes.length !== 65) {
    return {
      ok: false,
      detail: `decoded to ${bytes.length} bytes, expected 65 (an uncompressed P-256 point)`,
    };
  }
  if (bytes[0] !== 0x04) {
    return {
      ok: false,
      detail: `first byte is 0x${bytes[0].toString(16).padStart(2, "0")}, expected 0x04 (uncompressed point marker)`,
    };
  }
  return { ok: true, detail: "65 bytes, starts 0x04 — a valid uncompressed P-256 point" };
}
