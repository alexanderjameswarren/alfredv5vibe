/* Alfred — notification service worker.
 *
 * Two jobs, both of which can only be done by a worker:
 *
 *   1. Android Chrome throws on `new Notification()`, so a notification can
 *      only be raised through a ServiceWorkerRegistration.
 *   2. A `push` event is delivered to the worker with no page open at all,
 *      which is the only way a notification arrives once Alfred is closed.
 *
 * DELIBERATELY NO `fetch` HANDLER. A worker without one never intercepts a
 * request, so the app is served exactly as it was before this file existed —
 * no offline caching, no stale bundle after a deploy, no change in behaviour.
 * Do not add one.
 */

// Take over as soon as installed rather than waiting for every tab to close,
// so the first visit can raise a notification instead of the second.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The defaults. A push that carries no payload, or a payload that will not
// parse, still has to produce a notification — see the handler below.
const FALLBACK = {
  title: 'Alfred',
  body: 'Time for: squats',
  tag: 'alfred-push',
  icon: '/android-chrome-192x192.png',
  url: '/',
};

/* Web Push. This is the handler that fires when Alfred is closed.
 *
 * 🛑 EVERY PATH THROUGH THIS MUST SHOW A NOTIFICATION. The subscription was
 * made with `userVisibleOnly: true`, which is a promise to the browser that
 * every push becomes something the user can see. Chrome enforces it: a push
 * that raises nothing earns a "site updated in the background" notification
 * the first few times and then gets the subscription throttled or dropped.
 * So the parse is defensive and the fallback is a real notification, never a
 * silent return.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    // `event.data` is null for a push sent with no body at all — reading
    // .json() on it would throw, and so would a body that is not JSON.
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    // Nothing to report to, and reporting is not the job: showing something
    // is. Keep the defaults.
    payload = {};
  }

  const title = payload.title || FALLBACK.title;
  const options = {
    body: payload.body || FALLBACK.body,
    tag: payload.tag || FALLBACK.tag,
    icon: payload.icon || FALLBACK.icon,
    badge: payload.icon || FALLBACK.icon,
    // Ignored on Android, which keeps notifications until dismissed anyway.
    requireInteraction: payload.requireInteraction !== false,
    // Where tapping this should land. `data` is the only part of a notification
    // that survives to the notificationclick handler, which runs in a separate
    // invocation of the worker with none of this scope. A chained notification
    // that opened the app's home screen would not say which step had fired.
    data: { url: payload.url || FALLBACK.url },
  };

  // waitUntil keeps the worker alive until the notification is actually
  // posted. Without it the worker can be killed mid-call and nothing appears.
  event.waitUntil(self.registration.showNotification(title, options));
});

/* ── Subscription rotation ──────────────────────────────────────────────────
 *
 * Chrome fires `pushsubscriptionchange` when it invalidates a subscription.
 * Until this existed, a rotated subscription became a dead letterbox: the old
 * endpoint stayed in push_subscriptions, the dispatcher went on sending to it,
 * and FCM answered **201 while delivering nothing** — no error anywhere, no
 * recovery except a user noticing and resubscribing by hand.
 *
 * The worker can resubscribe on its own. It cannot reliably write to Supabase:
 * supabase-js keeps the session in localStorage, which a service worker cannot
 * read. So it records the swap and lets the app do the database work.
 *
 * ⚠️ TWIN SITE: these three names are also in src/utils/pushRotation.js, which
 * is what reads the record. A worker cannot import from src/, so they are
 * duplicated deliberately. Rename one, rename both — a test asserts they match.
 */
const ROTATION_DB = 'alfred-push';
const ROTATION_STORE = 'rotation';
const ROTATION_KEY = 'pending';

function openRotationDb() {
  return new Promise((resolve, reject) => {
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

async function recordRotation(record) {
  const db = await openRotationDb();
  await new Promise((resolve) => {
    const tx = db.transaction(ROTATION_STORE, 'readwrite');
    tx.objectStore(ROTATION_STORE).put(record, ROTATION_KEY);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const oldEndpoint = event.oldSubscription ? event.oldSubscription.endpoint : null;

      // Some browsers hand over the replacement; most expect the worker to
      // create it. Reuse the SAME application server key — a subscription made
      // with a different key cannot be sent to with the old one.
      let newSub = event.newSubscription || null;
      if (!newSub) {
        const key =
          (event.oldSubscription &&
            event.oldSubscription.options &&
            event.oldSubscription.options.applicationServerKey) ||
          null;
        try {
          newSub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            ...(key ? { applicationServerKey: key } : {}),
          });
        } catch (err) {
          // Resubscribing can fail — permission revoked, no network. The
          // record is still written so the app can repair on next load.
          newSub = null;
        }
      }

      const record = {
        oldEndpoint,
        newEndpoint: newSub ? newSub.endpoint : null,
        at: new Date().toISOString(),
      };

      try {
        await recordRotation(record);
      } catch (err) {
        /* IDB unavailable; the postMessage below may still reach a client */
      }

      // If Alfred is open, repair now instead of on next launch.
      try {
        const windows = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windows) {
          client.postMessage({ type: 'push-subscription-changed', ...record });
        }
      } catch (err) {
        /* nothing further to try from here */
      }
    })()
  );
});

// Tapping the notification — on the phone or mirrored on the watch — opens the
// app at the URL the push asked for, focusing an existing window rather than
// piling up tabs.
//
// The URL is a PATH, not an absolute address. openWindow and navigate resolve
// it against this worker's own origin, so there is no base-URL setting to get
// wrong and no way to send someone to the wrong host.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ('focus' in client) {
            // Focus first, then move it. An already-open Alfred sitting on the
            // home screen must still end up on the execution — focusing alone
            // would look like the link had been ignored.
            const focused = client.focus();
            if ('navigate' in client) {
              return Promise.resolve(focused)
                .then((c) => (c && c.navigate ? c.navigate(url) : client.navigate(url)))
                // navigate() rejects on some browsers for cross-origin or
                // uncontrolled clients. Falling back to a new window is better
                // than swallowing the tap.
                .catch(() => (self.clients.openWindow ? self.clients.openWindow(url) : undefined));
            }
            return focused;
          }
        }
        return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
      })
  );
});
