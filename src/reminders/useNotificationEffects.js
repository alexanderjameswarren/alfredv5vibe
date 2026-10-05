import { useEffect } from "react";
import { normalizePath } from "../viewPaths";
import { reconcilePushSubscription } from "../utils/pushSubscriptions";
import { takePendingNavigation } from "../utils/pushRotation";

// The notification landing and push self-healing effects, moved out of Alfred.jsx
// unchanged and called where they were, so they run in the same order.
export function useNotificationEffects({ navigate, user }) {
  // --- Notification landing (deep link, closed app) -------------------------
  //
  // Tapping a chain notification with Alfred CLOSED launched the installed PWA
  // on the home page. Everything upstream was correct — the payload carried the
  // URL, notification.data carried it into the click handler, and the same URL
  // pasted into a browser opened the right screen. It is lost inside
  // clients.openWindow(): on Android an installed PWA is launched by the OS at
  // the manifest's start_url, and the requested URL is advisory.
  //
  // So the worker records where it meant to go and this applies it on boot.
  // Runs BEFORE auth resolves on purpose: the Phase 1 guard already suppresses
  // its redirect while a session is being restored, so navigating early costs
  // nothing and gets the address right before anything can look at it.
  //
  // Deliberately not gated on `user` and deliberately not in the dependency
  // list of anything: it must run exactly once per launch.
  useEffect(() => {
    let cancelled = false;
    takePendingNavigation().then((path) => {
      if (cancelled || !path) return;
      // If openWindow DID land correctly — it does on some versions — the app
      // is already here and navigating again would push a pointless history
      // entry.
      if (normalizePath(path) === normalizePath(window.location.pathname)) return;
      console.log(`[Push] Notification asked for ${path}; applying it on launch.`);
      navigate(path, { replace: true });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Push subscription self-healing (Phase 5c) ----------------------------
  //
  // A push subscription can die while its stored row still looks healthy. In
  // the field an endpoint returned 201 from FCM and delivered nothing, for
  // three consecutive sends. There is no delivery receipt in Web Push, so a
  // 201 means "the push service accepted it" and never "the phone showed it" —
  // and a dead FCM registration can answer 201 forever rather than the 404/410
  // that would have pruned the row.
  //
  // So the table cannot be trusted to correct itself. The browser's own
  // getSubscription() is the authority, and this reconciles against it once per
  // load. It never registers a worker or creates a subscription: a user who has
  // not enabled push sees no change at all.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const outcome = await reconcilePushSubscription();
      if (cancelled || !outcome.ran) return;
      if (outcome.inserted || outcome.deleted > 0) {
        console.log(
          `[Push] Subscription reconciled — ${outcome.reason} ` +
            `(inserted: ${outcome.inserted}, removed: ${outcome.deleted})`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // The worker postMessages a rotation when Alfred is open, so it is repaired
  // immediately rather than waiting for the next load.
  useEffect(() => {
    if (!user || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }
    const onMessage = (event) => {
      if (!event.data || event.data.type !== "push-subscription-changed") return;
      console.log("[Push] Service worker reported a subscription rotation; repairing.");
      reconcilePushSubscription().then((outcome) => {
        console.log(`[Push] Rotation repair: ${outcome.reason}`);
      });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [user]);
}
