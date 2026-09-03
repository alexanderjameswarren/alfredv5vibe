/* Alfred — notification service worker.
 *
 * This exists for one reason: Android Chrome throws on `new Notification()`,
 * so a notification can only be raised through a ServiceWorkerRegistration.
 * Registering a worker is the price of admission; this file is that price and
 * nothing more.
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

// Tapping the notification — on the phone or mirrored on the watch — focuses
// the app if it is already open, and opens it if it is not.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow ? self.clients.openWindow('/') : undefined;
      })
  );
});
