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
