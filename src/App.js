import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Alfred from './Alfred';
import OAuthConsent from './OAuthConsent';
import SendFromDesktop from './switchboard/SendFromDesktop';
import ApprovePage from './switchboard/ApprovePage';
import { RunErrorBoundary } from './switchboard/runs/look';

// Dev server only (dataops_alfred-d4x s6b): the approve page with a sample payload and a fake runner. CRA sets
// NODE_ENV to "production" in a build, so webpack drops this branch and its import, and the build has no such route.
const ApproveFixture = process.env.NODE_ENV !== 'production' ? lazy(() => import('./switchboard/ApproveFixture')) : null;
// Dev server only (sb3_pages-h6v A2): the Switchboard 3 run page on made-up data. Dropped from a build the same way.
const RunSimulation = process.env.NODE_ENV !== 'production' ? lazy(() => import('./switchboard/runs/RunSimulation')) : null;
// sb3_pages-h6v B4: the live Switchboard 3 run and code review pages, beside today's /approve/ pages.
const RunRoute = lazy(() => import('./switchboard/runs/LiveRunRoute').then((m) => ({ default: m.RunRoute })));
const ReviewRoute = lazy(() => import('./switchboard/runs/LiveRunRoute').then((m) => ({ default: m.ReviewRoute })));

// Step 2 of docs/technical-spec-navigation-urls.md: mount the router and
// change nothing else. This replaces the hard-coded
// `window.location.pathname === '/oauth/consent'` check with two routes that
// dispatch identically.
//
// The catch-all is deliberate and load-bearing. Because `path="*"` matches
// every non-consent path, React sees the same <Alfred /> element in the same
// tree position on every navigation, so Alfred never unmounts and keeps all
// of its state — including the `view` useState it still owns at this step.
// Alfred does not read the URL yet; that is Step 4's bridge.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/oauth/consent" element={<OAuthConsent />} />
        <Route path="/send/:runTag" element={<SendFromDesktop />} />
        <Route path="/approve/:token" element={<ApprovePage />} />
        {/* s16b: the boundary sits outside the lazy load, so a failed LiveRunRoute chunk shows its message, not a blank page. */}
        <Route path="/run/:token" element={<RunErrorBoundary><Suspense fallback={null}><RunRoute /></Suspense></RunErrorBoundary>} />
        <Route path="/review/:token" element={<RunErrorBoundary><Suspense fallback={null}><ReviewRoute /></Suspense></RunErrorBoundary>} />
        {ApproveFixture && process.env.NODE_ENV !== 'production' && (
          <Route path="/approve-fixture/:kind" element={<Suspense fallback={null}><ApproveFixture /></Suspense>} />
        )}
        {RunSimulation && process.env.NODE_ENV !== 'production' && (
          <Route path="/run-sim/:scenario" element={<Suspense fallback={null}><RunSimulation /></Suspense>} />
        )}
        <Route path="*" element={<Alfred />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
