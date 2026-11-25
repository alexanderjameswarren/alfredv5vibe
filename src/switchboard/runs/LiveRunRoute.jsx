import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../supabaseClient';
import { BUTTON, RunErrorBoundary, RunShell } from './look';
import { callRunPages, linkEndedReason, liveReviewSource, liveRunSource } from './liveSource';

// sb3_pages-h6v B4: the live routes, beside today's /approve/ pages. /run/:token is the run page, /review/:token the
// code review page, both read from switchboard-run-pages' preview once at open (never again by themselves). A signed-out
// visitor signs in and comes back to the same address. An unknown, voided or outdated link shows the database's words.

const realDeps = {
  getSession: () => supabase.auth.getSession(),
  signIn: () => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } }),
};

// The frame for what comes before the page: no request yet, so no data to mark as a simulation or approvable.
const BARE = { kind: 'real' };

// The pages load on their own, inside the boundary, so a failed load shows the boundary's message, not a blank page.
const RunPage = lazy(() => import('./RunPage'));
const CodeReviewPage = lazy(() => import('./CodeReviewPage'));
const LOADING = <RunShell source={BARE}><p className="text-muted">Loading…</p></RunShell>;

function LiveRoute({ review, deps: given }) {
  const { token } = useParams();
  const deps = useRef({ ...realDeps, ...(given ?? {}) }).current;
  const [state, setState] = useState({ phase: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ phase: 'loading' });
    (async () => {
      try {
        const { data } = await deps.getSession();
        if (!live) return;
        if (!data?.session) { setState({ phase: 'signin' }); return; }
        const preview = await callRunPages('preview', { token }, deps);
        if (!live) return;
        const ended = linkEndedReason(preview)
          ?? (review && !preview.review ? 'This is a run page link, not a code review link: open it as /run/ instead.' : null)
          ?? (!review && preview.review ? 'This is a code review link: open it as /review/ instead.' : null);
        // A simulation's ended link still carries the strip: the kind is the database's.
        if (ended) { setState({ phase: 'ended', message: ended, kind: preview.request?.simulation === false ? 'real' : 'sim' }); return; }
        setState({ phase: 'ready', source: review ? liveReviewSource(token, preview, deps) : liveRunSource(token, preview, deps) });
      } catch (e) {
        // The function's (and so the database's) own words, unchanged.
        if (live) setState({ phase: 'ended', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { live = false; };
  }, [token, review, deps]);

  if (state.phase === 'ready') {
    return <Suspense fallback={LOADING}>{review ? <CodeReviewPage source={state.source} /> : <RunPage source={state.source} />}</Suspense>;
  }
  if (state.phase === 'signin') {
    return (
      <RunShell source={BARE}>
        <p data-testid="run-signin" className="text-dark mb-4">Sign in to Alfred to see this {review ? 'code review' : 'run'}. Nothing has run.</p>
        <button data-testid="run-signin-button" className={BUTTON} onClick={() => deps.signIn()}>Sign in with Google</button>
      </RunShell>
    );
  }
  if (state.phase === 'ended') {
    return <RunShell source={state.kind ? { kind: state.kind } : BARE}><p data-testid="run-error" role="alert" className="text-dark break-words">{state.message}</p></RunShell>;
  }
  return LOADING;
}

/** The route inside the boundary, reset by a new token. */
function Guarded({ review, deps, onReload }) {
  const { token } = useParams();
  return <RunErrorBoundary key={token} onReload={onReload}><LiveRoute review={review} deps={deps} /></RunErrorBoundary>;
}

/** /run/:token */
export function RunRoute({ deps, onReload } = {}) {
  return <Guarded review={false} deps={deps} onReload={onReload} />;
}

/** /review/:token */
export function ReviewRoute({ deps, onReload } = {}) {
  return <Guarded review deps={deps} onReload={onReload} />;
}
