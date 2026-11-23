import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import RunPage from './RunPage';
import CodeReviewPage from './CodeReviewPage';
import { RunShell } from './look';
import {
  DESKTOP_ANSWERS, REVIEW_SCENARIOS, SCENARIOS, reviewScenarioNames, reviewSimSource, scenarioNames, simSource,
} from './simulation';

// DEV SERVER ONLY (sb3_pages-h6v A2, A6). /run-sim/:scenario renders the run page, or for a review-* scenario the code
// review page, on made-up data through the simulated source: no Supabase, no runner, no org. App.js mounts the route
// only when NODE_ENV !== 'production'. An unknown scenario (or /run-sim/list) shows the list.

export default function RunSimulation() {
  const { scenario } = useParams();
  // ?desktop=no_extension,running gives the made-up desktop answers, one per ask (spec part 6).
  const desktopParam = useSearchParams()[0].get('desktop');
  const isReview = Object.hasOwn(REVIEW_SCENARIOS, scenario ?? '');
  // One source per scenario and page load, so its made-up desktop answers run in order.
  const source = useMemo(() => {
    const desktop = desktopParam ? desktopParam.split(',').map((a) => a.trim()).filter((a) => DESKTOP_ANSWERS.includes(a)) : [];
    const opts = desktop.length ? { desktop } : {};
    return isReview ? reviewSimSource(scenario, opts) : simSource(scenario, opts);
  }, [scenario, desktopParam, isReview]);
  if (source && isReview) return <CodeReviewPage source={source} />;
  if (source) return <RunPage source={source} />;
  return (
    <RunShell source={{ kind: 'sim' }}>
      <h2 className="text-xl font-bold text-dark mb-2">Run page scenarios</h2>
      <ul data-testid="run-sim-list" className="list-disc pl-6 space-y-1 text-dark">
        {scenarioNames().map((name) => (
          <li key={name}><Link className="text-primary underline" to={`/run-sim/${name}`}>{name}</Link>: {SCENARIOS[name].title}</li>
        ))}
      </ul>
      <h2 className="text-xl font-bold text-dark mt-4 mb-2">Code review scenarios</h2>
      <ul data-testid="review-sim-list" className="list-disc pl-6 space-y-1 text-dark">
        {reviewScenarioNames().map((name) => (
          <li key={name}><Link className="text-primary underline" to={`/run-sim/${name}`}>{name}</Link>: {REVIEW_SCENARIOS[name].title}</li>
        ))}
      </ul>
      <p data-testid="run-sim-desktop" className="mt-4 text-sm text-dark break-words">
        Desktop answers, one per ask (page open, each Check again, the Approve click), the last repeating: add
        <span className="font-mono"> ?desktop=</span> with any of <span className="font-mono">{DESKTOP_ANSWERS.join(', ')}</span>,
        for example <Link className="text-primary underline font-mono" to="/run-sim/dataop-update?desktop=not_running,running">dataop-update?desktop=not_running,running</Link>.
      </p>
    </RunShell>
  );
}
