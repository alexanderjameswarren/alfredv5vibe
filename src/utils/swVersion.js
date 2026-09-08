/**
 * The service worker version this build of the app expects.
 *
 * ⚠️ TWIN SITE: must equal `SW_VERSION` in `public/notify-sw.js`. A worker
 * cannot be imported from `src/`, and the app cannot read the worker's source,
 * so the constant is duplicated and kept in step by a test.
 *
 * It exists to answer one question that has cost two debugging sessions: **is
 * the phone running the worker that was deployed?** A service worker updates on
 * its own schedule; a stale one can keep raising notifications perfectly while
 * missing a change made weeks ago. That is exactly what happened with deep
 * links — the payload carried the URL, the route worked, and the tap still
 * opened the home page, because the running worker predated the change that put
 * the URL into `notification.data`.
 *
 * The diagnostic asks the ACTIVE worker for its version and compares it with
 * this. Silence means a worker older than version reporting itself, which is
 * the same answer with less precision.
 */
export const EXPECTED_SW_VERSION = "2026-09-08b";
