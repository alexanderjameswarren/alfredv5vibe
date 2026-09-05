import { useState, useEffect, useRef } from "react";
import { executionIdFromPath } from "./viewPaths";

// Cold-loading an execution from its URL.
//
// Extracted from Alfred.jsx so that the test exercises this code rather than a
// copy of it. The first attempt kept the logic inline and the test reproduced
// its shape; that arrangement can go green while the real guard drifts, which
// is the same twin-site failure that once stripped `collectable` from
// elements. There is one copy, and both the app and the test import it.
//
// ── The bug this exists to prevent ──────────────────────────────────────────
//
// The obvious flag is "a fetch is in progress", set by the effect that starts
// the fetch. It does not work, and the way it fails is worth stating because
// it will look correct to the next person who reads it.
//
// A flag set inside an effect is false for the whole render that schedules
// that effect. Alfred's redirect guard computes its decision during render, so
// on the render where auth resolves — user present, fetch not yet started —
// the flag is false and the guard redirects to /schedule. Reordering the
// effects does not help: `setState` in one effect does not retroactively
// change a value the next effect closed over during the same render.
//
// So the question is asked the other way round. Instead of "is a fetch running"
// — knowable only after a render — this asks "is this execution loaded yet",
// which is knowable during one. It defaults to waiting and only stops waiting
// once a lookup has actually completed and found nothing. There is no render
// in which we have neither looked nor are looking, so there is no gap.
//
// This also removes the need to special-case `authLoading` / `!user`: until a
// lookup has run and failed, the answer is "still waiting", which is correct
// while a session is being restored and keeps a deep link alive across a login.

/**
 * @param {object}   params
 * @param {string}   params.pathname          Current location pathname.
 * @param {object|null} params.user           Authenticated user, or null.
 * @param {object|null} params.activeExecution The execution currently in state.
 * @param {Function} params.setActiveExecution State setter for it.
 * @param {Function} params.fetchExecution     async (id) => execution | null.
 *
 * @returns {{
 *   routeExecutionId: string|null,
 *   awaitingExecutionLoad: boolean,
 *   executionForRoute: object|null,
 * }}
 */
export function useExecutionRoute({
  pathname,
  user,
  activeExecution,
  setActiveExecution,
  fetchExecution,
}) {
  const routeExecutionId = executionIdFromPath(pathname);

  // The id whose lookup has completed and found nothing. Keyed by id rather
  // than a bare boolean so that a valid link opened after a bad one is not
  // poisoned by the previous failure.
  const [failedExecutionId, setFailedExecutionId] = useState(null);

  // Callers pass inline arrows; holding them in refs keeps a new function
  // identity each render from re-triggering the fetch on every render.
  const fetchRef = useRef(fetchExecution);
  const setActiveRef = useRef(setActiveExecution);
  useEffect(() => {
    fetchRef.current = fetchExecution;
    setActiveRef.current = setActiveExecution;
  });

  const executionMatchesRoute = Boolean(
    routeExecutionId && activeExecution && activeExecution.id === routeExecutionId
  );

  // An id-bearing path only ever resolves to the execution-detail view, so
  // having an id is the same statement as being on that view — no `view`
  // argument is needed.
  const awaitingExecutionLoad =
    Boolean(routeExecutionId) &&
    !executionMatchesRoute &&
    failedExecutionId !== routeExecutionId;

  // What the route actually authorises rendering.
  //
  // Derived rather than left to the clearing effect below, because an effect
  // cannot run soon enough: there would be one render in which the URL names
  // execution B while state still holds A, and Alfred would draw A under B's
  // address. On the id-less path this is just `activeExecution`, which is what
  // preserves the behaviour of any navigation that does not carry an id.
  const executionForRoute = routeExecutionId
    ? (executionMatchesRoute ? activeExecution : null)
    : activeExecution;

  // Fetch the execution the URL names. On normal in-app navigation the state
  // and the URL are set in the same batch, so this does nothing; it earns its
  // keep on a pasted link, a refresh, or a notification tap.
  useEffect(() => {
    if (!routeExecutionId || !user) return;
    if (executionMatchesRoute) return;
    if (failedExecutionId === routeExecutionId) return; // already looked, not there

    // A response for a link the user has already left must not install itself.
    let cancelled = false;
    (async () => {
      // A missing row and one hidden by RLS both arrive as null, and both mean
      // the same thing here: not yours to open. Recording the failure is what
      // finally releases the guard and lets the redirect happen.
      const exec = await fetchRef.current(routeExecutionId);
      if (cancelled) return;
      if (exec) setActiveRef.current(exec);
      else setFailedExecutionId(routeExecutionId);
    })();

    return () => {
      cancelled = true;
    };
  }, [routeExecutionId, user, executionMatchesRoute, failedExecutionId]);

  // Drop an execution the URL no longer names.
  //
  // `executionForRoute` already stops the stale one being rendered, but the
  // rest of Alfred reads `activeExecution` directly — completing an element,
  // closing, pausing — and those must not act on an execution the user is not
  // looking at. A failed deep link is the case that matters: without this, the
  // previous execution stays in state and the next navigation opens it.
  useEffect(() => {
    if (!routeExecutionId) return;
    if (!activeExecution) return;
    if (activeExecution.id === routeExecutionId) return;
    setActiveRef.current(null);
  }, [routeExecutionId, activeExecution]);

  return { routeExecutionId, awaitingExecutionLoad, executionForRoute };
}
