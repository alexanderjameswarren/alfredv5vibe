import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "../../supabaseClient";
import { loadActivePlan, loadTodayProgress, planLinkFor, todayKey } from "./activePlan";

// The active practice plan and today's progress on it (practice plans spec
// §7.2, §7.3). Called ONCE, in SamPlayer, and handed down — the home page's
// checklist and the pass/session writers share this one copy.
//
// Loads when SAM opens. `refresh` reloads plan and progress (the home page
// calls it on mount); the window regaining focus or becoming visible does the
// same. `refreshProgress` reloads only today's progress — cheap enough to run
// after every recorded pass.
//
// `getLink(songId, snippetId)` is what the writers call. It reads a ref, so it
// is stable and safe from ScrollEngine's rAF loop, and it answers
// { plan_id: null, plan_item_id: null } until a plan has loaded. Linking must
// never block or fail a pass.
export default function useActivePlan() {
  const [plan, setPlan] = useState(null);
  const [progress, setProgress] = useState(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const planRef = useRef(null);
  const loadingRef = useRef(null);
  const progressSeqRef = useRef(0);

  const refreshProgress = useCallback(async (planId = planRef.current?.id) => {
    const seq = ++progressSeqRef.current;
    if (!planId) {
      setProgress(new Map());
      return;
    }
    try {
      const map = await loadTodayProgress(supabase, planId, todayKey());
      // A slower, older response must not overwrite a newer one.
      if (seq === progressSeqRef.current) setProgress(map);
    } catch (e) {
      console.error("[Sam] Plan progress fetch failed:", e);
    }
  }, []);

  const refresh = useCallback(() => {
    // One load at a time: SAM opening and the home page mounting fire together.
    if (loadingRef.current) return loadingRef.current;
    const run = (async () => {
      try {
        const next = await loadActivePlan(supabase);
        planRef.current = next;
        setPlan(next);
        await refreshProgress(next?.id ?? null);
      } catch (e) {
        // Keep the last good plan; a failed refresh is not "no plan".
        console.error("[Sam] Active plan fetch failed:", e);
      } finally {
        setLoaded(true);
        loadingRef.current = null;
      }
    })();
    loadingRef.current = run;
    return run;
  }, [refreshProgress]);

  useEffect(() => {
    refresh();
    function onFocus() { refresh(); }
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const getLink = useCallback(
    (songId, snippetId) => planLinkFor(planRef.current, songId, snippetId),
    []
  );

  return { plan, progress, loaded, refresh, refreshProgress, getLink };
}
