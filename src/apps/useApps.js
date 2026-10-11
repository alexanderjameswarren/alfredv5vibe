import { useEffect, useState } from "react";
import { listApps } from "./appsApi";

// Apps change only by migration, so one read per page load is enough.
let cached = null;
let pending = null;

function loadApps() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = listApps()
      .then((rows) => {
        cached = rows;
        return rows;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export function resetAppsCache() {
  cached = null;
  pending = null;
}

/** The apps list; [] until loaded or when the read fails (logged). */
export default function useApps() {
  const [apps, setApps] = useState(cached || []);

  useEffect(() => {
    let live = true;
    loadApps()
      .then((rows) => live && setApps(rows))
      .catch((err) => console.error("[useApps]", err));
    return () => {
      live = false;
    };
  }, []);

  return apps;
}
