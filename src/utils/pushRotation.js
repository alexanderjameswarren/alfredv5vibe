/**
 * The rotation handoff between the service worker and the app.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Chrome fires `pushsubscriptionchange` in the SERVICE WORKER when it
 * invalidates a subscription. The worker can resubscribe immediately — that
 * part it can do alone — but it cannot reliably write the result to Supabase:
 * supabase-js keeps the session in localStorage, which a service worker has no
 * access to. So the worker records what happened and the app performs the
 * database swap on its next load.
 *
 * IndexedDB is the handoff, because it is the only store both contexts can
 * reach. The worker also postMessages any open client so a rotation while the
 * app is open is repaired immediately rather than on next launch.
 *
 * ⚠️ TWIN SITE: `public/notify-sw.js` opens the same database and store by
 * name. The three constants below are duplicated there, in the worker's own
 * tiny IDB helper, because a service worker cannot import from `src/`. If you
 * rename one, rename both — there is a test asserting the worker's source
 * still contains these exact literals.
 */

export const ROTATION_DB = "alfred-push";
export const ROTATION_STORE = "rotation";
export const ROTATION_KEY = "pending";
/**
 * Where the worker leaves a URL for the app to open on boot.
 *
 * ⚠️ TWIN SITE: also declared in `public/notify-sw.js`. Same store, different
 * key, same rename-both rule — guarded by test.
 */
export const NAV_KEY = "pendingNavigation";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(ROTATION_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROTATION_STORE)) {
        db.createObjectStore(ROTATION_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * The rotation the worker recorded, or null.
 *
 * Shape: `{ oldEndpoint, newEndpoint, at }`. `oldEndpoint` is the row to
 * remove; without it a rotated device leaves a dead row behind that the
 * dispatcher may never clean up — a dead FCM endpoint can answer 201 forever
 * rather than the 410 that would prune it.
 */
export async function readPendingRotation() {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(ROTATION_STORE, "readonly");
      const req = tx.objectStore(ROTATION_STORE).get(ROTATION_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    // Private mode, blocked storage, or a browser without IDB. The reconciler
    // still repairs the common case from the endpoints alone.
    return null;
  }
}

/** Drop the record once the database swap has actually landed. */
export async function clearPendingRotation() {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(ROTATION_STORE, "readwrite");
      tx.objectStore(ROTATION_STORE).delete(ROTATION_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch {
    /* nothing recoverable; a stale record is re-applied harmlessly next load */
  }
}

/**
 * Write a rotation record from the APP side.
 *
 * Used by the rotation drill in the diagnostic, so that forcing a rotation
 * leaves exactly the state a real one does. Without it the drill exercised the
 * insert path only and reported a pass while the delete path had never run.
 */
export async function writePendingRotation(record) {
  try {
    const db = await openDb();
    if (!db) return false;
    return await new Promise((resolve) => {
      const tx = db.transaction(ROTATION_STORE, "readwrite");
      tx.objectStore(ROTATION_STORE).put(record, ROTATION_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/* ── The endpoint ledger ────────────────────────────────────────────────────
 *
 * Every endpoint THIS browser has ever stored in push_subscriptions.
 *
 * It exists to answer one question safely: "is this table row mine, and dead?"
 *
 * The reconciler must never delete a row just because it is not the current
 * endpoint — other rows belong to the user's other devices, and deleting them
 * would silently unsubscribe another phone. The worker's rotation record proves
 * ownership when it exists, but it does not exist for a rotation that happened
 * before this code shipped, or if IndexedDB was unavailable when it fired.
 *
 * The ledger is the durable version of that proof. An endpoint in here was put
 * in the table BY THIS BROWSER, so if it is no longer the endpoint this browser
 * holds, it is this browser's dead row and is safe to remove.
 *
 * localStorage is per-origin and per-browser-profile, so two Chrome installs on
 * the same phone keep separate ledgers — which is exactly why this is safe
 * where matching on user_agent is not.
 *
 * If it is lost (cleared storage, private mode) nothing breaks: the reconciler
 * falls back to inserting the current endpoint, which is today's behaviour.
 */

const LEDGER_KEY = "alfred.push.endpoints";
// Bounded so a browser that rotates often cannot grow this without limit.
const LEDGER_MAX = 20;

export function readKnownEndpoints() {
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Record that this browser put `endpoint` in the table. Newest last. */
export function rememberEndpoint(endpoint) {
  if (!endpoint) return;
  try {
    const list = readKnownEndpoints().filter((e) => e !== endpoint);
    list.push(endpoint);
    window.localStorage.setItem(
      LEDGER_KEY,
      JSON.stringify(list.slice(-LEDGER_MAX))
    );
  } catch {
    /* storage unavailable; the reconciler degrades to insert-only */
  }
}

/** Drop an endpoint once its row has actually been deleted. */
export function forgetEndpoint(endpoint) {
  try {
    const list = readKnownEndpoints().filter((e) => e !== endpoint);
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(list));
  } catch {
    /* nothing recoverable */
  }
}

/* ── The deep-link landing fallback ─────────────────────────────────────────
 *
 * Tapping a chain notification with Alfred CLOSED launched the installed PWA on
 * the home page instead of the execution. Everything upstream was correct — the
 * payload carried the URL, `notification.data` carried it into the click
 * handler, and the same URL pasted into a browser opened the right screen. The
 * loss happens inside `clients.openWindow()`: on Android, launching an
 * installed PWA that is not already running lands on the manifest's `start_url`
 * rather than the requested URL. With Alfred already open the worker navigates
 * an existing window instead, which is why that path always worked.
 *
 * So the worker records where it wanted to go, and the app reads it on boot.
 *
 * Two rules keep it from firing when it should not:
 *
 *   - **Freshness.** A tap-to-boot takes seconds. A record older than the
 *     window below is ignored, so opening Alfred from its icon an hour later
 *     never jumps somewhere unexpected.
 *   - **Consume once.** It is deleted as it is read, before anything navigates,
 *     so a single tap can only ever move the app once.
 */

const NAV_MAX_AGE_MS = 60_000;

/**
 * Take the URL the worker wanted to open, if it is recent.
 *
 * Always clears the record, even when it is too old to use — a stale one has no
 * further purpose and leaving it risks it being consumed by a later launch.
 *
 * @returns {Promise<string|null>} The path to navigate to, or null.
 */
export async function takePendingNavigation(now = Date.now()) {
  try {
    const db = await openDb();
    if (!db) return null;

    const record = await new Promise((resolve) => {
      const tx = db.transaction(ROTATION_STORE, "readonly");
      const req = tx.objectStore(ROTATION_STORE).get(NAV_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!record) return null;

    await new Promise((resolve) => {
      const tx = db.transaction(ROTATION_STORE, "readwrite");
      tx.objectStore(ROTATION_STORE).delete(NAV_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });

    const at = Date.parse(record.at);
    if (!record.url || !Number.isFinite(at)) return null;
    if (now - at > NAV_MAX_AGE_MS) return null;   // an unrelated launch
    return record.url;
  } catch {
    // No IndexedDB, or blocked storage. The app simply lands where the browser
    // put it, which is today's behaviour.
    return null;
  }
}
