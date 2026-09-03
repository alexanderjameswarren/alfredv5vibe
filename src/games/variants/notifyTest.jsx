import React, { useState, useRef, useEffect, useCallback } from "react";

// Push Notification Test — not a game, a diagnostic.
//
// It answers one question: does a notification raised by this app reach the
// phone, and does it mirror to the watch? It lives in the Games tab because
// that tab is the variant harness — one file, one registry entry, no edits
// anywhere else — and this needs exactly that and nothing more.
//
// Everything is in memory. Nothing is saved, nothing is sent, and the only
// lasting effect is the service worker registration, which is what is being
// tested.
//
// THE LOG IS THE POINT. This is tested on a phone with no DevTools, so a
// failure that only reaches the console is a failure that cannot be seen.
// Every call below is wrapped and every outcome — including success — is
// written to the screen.

// The notification under test. Fixed content: the question is delivery, not
// what it says.
const NOTIFICATION = {
  title: "Alfred",
  body: "Time for: squats",
  // A tag replaces a same-tagged notification rather than stacking, so two
  // taps of "Notify now" leave one notification and not two — which is itself
  // worth seeing on the watch.
  tag: "alfred-push-test",
  // Ignored by Android Chrome, which keeps notifications until dismissed
  // anyway, but correct on desktop and harmless here.
  requireInteraction: true,
};

// Already in public/ for the manifest; reused rather than adding an asset.
const ICON = `${process.env.PUBLIC_URL || ""}/android-chrome-192x192.png`;
const SW_URL = `${process.env.PUBLIC_URL || ""}/notify-sw.js`;

const DELAY_SECONDS = 10;

// Permission has no universal change event and the Permissions API is not
// everywhere, so the panel polls. A string comparison once a second costs
// nothing and is the only way the panel stays honest when permission is
// changed in Android's settings while the page is open.
const POLL_MS = 1000;

const hasNotification = () =>
  typeof window !== "undefined" && "Notification" in window;
const hasServiceWorker = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator;
const currentPermission = () =>
  hasNotification() ? Notification.permission : "unavailable";

const messageOf = (err) => (err && err.message ? err.message : String(err));

const stamp = () =>
  new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

// One row of the status panel. The value carries the colour, so a red line is
// findable at arm's length on a phone.
function StatusRow({ label, value, tone }) {
  const toneClass =
    tone === "good"
      ? "text-success"
      : tone === "bad"
      ? "text-destructive"
      : "text-muted-foreground";
  return (
    <div className="flex justify-between gap-3 text-sm py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium text-right ${toneClass}`}>{String(value)}</dd>
    </div>
  );
}

export default function NotifyTest() {
  const [permission, setPermission] = useState(currentPermission);
  const [registered, setRegistered] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [log, setLog] = useState([]);

  // The registration is held in a ref, not state: it is the handle every
  // notification call needs, and re-rendering on it would say nothing that
  // `registered` does not already say.
  const regRef = useRef(null);
  const timeoutRef = useRef(null);
  const intervalRef = useRef(null);
  const logEndRef = useRef(null);
  // Cleared on unmount so a fired timer cannot log into a dead component.
  const liveRef = useRef(true);

  const append = useCallback((text, tone = "info") => {
    setLog((lines) => [
      ...lines,
      { id: `${Date.now()}-${lines.length}`, time: stamp(), text, tone },
    ]);
  }, []);

  // --- registration --------------------------------------------------------
  // Registering here rather than at app startup keeps this contained: no
  // worker exists until this screen is opened.
  useEffect(() => {
    liveRef.current = true;

    if (!hasNotification()) {
      append("This browser has no Notification API — nothing here can work.", "bad");
    }
    if (!hasServiceWorker()) {
      append("navigator.serviceWorker is missing — cannot register a worker.", "bad");
      return;
    }

    (async () => {
      try {
        append(`Registering service worker at ${SW_URL}…`);
        const reg = await navigator.serviceWorker.register(SW_URL);
        // `ready` resolves only once a worker is actually active, which is the
        // state showNotification needs. Registered is not the same as ready.
        const active = await navigator.serviceWorker.ready;
        if (!liveRef.current) return;
        regRef.current = active || reg;
        setRegistered(true);
        append(`Service worker active. Scope: ${(active || reg).scope}`, "good");
      } catch (err) {
        if (!liveRef.current) return;
        setRegistered(false);
        append(`Service worker registration failed: ${messageOf(err)}`, "bad");
      }
    })();
  }, [append]);

  // --- live status ---------------------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => {
      setPermission(currentPermission());
      setRegistered(Boolean(regRef.current && regRef.current.active));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Leaving the screen disarms the delayed test — a notification from a screen
  // that is gone proves nothing about what was being watched.
  useEffect(
    () => () => {
      liveRef.current = false;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    },
    []
  );

  // Keep the newest line in view without moving the page under a thumb.
  useEffect(() => {
    if (logEndRef.current && logEndRef.current.scrollIntoView) {
      logEndRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [log]);

  // --- actions -------------------------------------------------------------
  const requestPermission = async () => {
    try {
      if (!hasNotification()) {
        append("Cannot request: no Notification API in this browser.", "bad");
        return;
      }
      append("Requesting permission…");
      const result = await Notification.requestPermission();
      setPermission(currentPermission());
      append(`Permission result: ${result}`, result === "granted" ? "good" : "bad");
      if (result === "default") {
        append("Dismissed without choosing — the prompt can be shown again.", "bad");
      }
    } catch (err) {
      append(`requestPermission threw: ${messageOf(err)}`, "bad");
    }
  };

  // The single path every notification takes. Deliberately never uses
  // `new Notification()`: that constructor throws on Android Chrome, which is
  // the entire reason there is a service worker here at all.
  const fire = async (label) => {
    try {
      if (!hasNotification()) throw new Error("No Notification API in this browser.");
      const permissionNow = currentPermission();
      if (permissionNow !== "granted") {
        throw new Error(`Permission is "${permissionNow}", not "granted".`);
      }
      const reg = regRef.current;
      if (!reg) throw new Error("No service worker registration — cannot show a notification.");
      if (!reg.showNotification) throw new Error("Registration has no showNotification method.");

      append(`${label}: calling registration.showNotification…`);
      await reg.showNotification(NOTIFICATION.title, {
        body: NOTIFICATION.body,
        tag: NOTIFICATION.tag,
        requireInteraction: NOTIFICATION.requireInteraction,
        icon: ICON,
        badge: ICON,
      });
      append(`${label}: showNotification resolved — the OS accepted it.`, "good");
    } catch (err) {
      append(`${label} failed: ${messageOf(err)}`, "bad");
    }
  };

  const notifyNow = () => {
    fire("Notify now");
  };

  const notifyLater = () => {
    try {
      if (countdown !== null) return;
      append(`Armed: notification in ${DELAY_SECONDS} seconds.`);
      setCountdown(DELAY_SECONDS);

      intervalRef.current = window.setInterval(() => {
        setCountdown((n) => (n === null || n <= 1 ? n : n - 1));
      }, 1000);

      timeoutRef.current = window.setTimeout(() => {
        if (intervalRef.current) window.clearInterval(intervalRef.current);
        intervalRef.current = null;
        timeoutRef.current = null;
        if (!liveRef.current) return;
        setCountdown(null);
        // Phones throttle background timers. If this line lands late, that is
        // a finding about the timer, not about notification delivery.
        fire(`Delayed (${DELAY_SECONDS}s)`);
      }, DELAY_SECONDS * 1000);
    } catch (err) {
      setCountdown(null);
      append(`Arming the delayed test threw: ${messageOf(err)}`, "bad");
    }
  };

  const permissionSettled = permission === "granted" || permission === "denied";
  const armed = countdown !== null;

  return (
    <div className="space-y-4">
      {/* 1 — what this browser can actually do, live */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="font-medium text-foreground mb-2">Status</h3>
        <dl className="divide-y divide-border">
          <StatusRow
            label="Notification API"
            value={hasNotification() ? "present" : "missing"}
            tone={hasNotification() ? "good" : "bad"}
          />
          <StatusRow
            label="navigator.serviceWorker"
            value={hasServiceWorker() ? "present" : "missing"}
            tone={hasServiceWorker() ? "good" : "bad"}
          />
          <StatusRow
            label="Notification.permission"
            value={permission}
            tone={
              permission === "granted"
                ? "good"
                : permission === "denied"
                ? "bad"
                : "neutral"
            }
          />
          <StatusRow
            label="Worker registration"
            value={registered ? "active" : "none"}
            tone={registered ? "good" : "bad"}
          />
        </dl>
      </div>

      {/* 2 — permission */}
      <button
        type="button"
        onClick={requestPermission}
        disabled={permissionSettled}
        className="w-full px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm disabled:opacity-50"
      >
        {permission === "granted"
          ? "Permission granted"
          : permission === "denied"
          ? "Permission denied — change it in browser settings"
          : "Request permission"}
      </button>

      {/* 3 and 4 — the two tests */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={notifyNow}
          className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground"
        >
          Notify now
        </button>
        <button
          type="button"
          onClick={notifyLater}
          disabled={armed}
          className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
        >
          {armed ? `Firing in ${countdown}s…` : `Notify in ${DELAY_SECONDS} seconds`}
        </button>
      </div>

      {armed && (
        <p className="text-sm text-center text-muted-foreground">
          Armed — lock the phone now to test delivery from the background.
        </p>
      )}

      {/* 5 — the log, which is the only debugging surface on a phone */}
      <div>
        <h3 className="font-medium text-foreground mb-2">Log</h3>
        <div className="bg-card border border-border rounded-lg p-3 max-h-72 overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="space-y-1">
              {log.map((line) => (
                <li
                  key={line.id}
                  className={`text-xs font-mono break-words ${
                    line.tone === "bad"
                      ? "text-destructive"
                      : line.tone === "good"
                      ? "text-success"
                      : "text-foreground"
                  }`}
                >
                  <span className="text-muted-foreground">{line.time}</span>{" "}
                  {line.text}
                </li>
              ))}
            </ul>
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
