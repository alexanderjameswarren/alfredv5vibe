import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import RunPage from './RunPage';
import { RunShell } from './look';
import { DESKTOP_ANSWERS, SCENARIOS, scenarioNames, simSource } from './simulation';

// DEV SERVER ONLY (sb3_pages-h6v A2). /run-sim/:scenario renders the run page on made-up data through the simulated
// source: no Supabase, no runner, no org. App.js mounts the route only when NODE_ENV !== 'production'. An unknown
// scenario (or /run-sim/list) shows the list.

export default function RunSimulation() {
  const { scenario } = useParams();
  // ?desktop=no_extension,running gives the made-up desktop answers, one per ask (spec part 6).
  const desktopParam = useSearchParams()[0].get('desktop');
  // One source per scenario and page load, so its made-up desktop answers run in order.
  const source = useMemo(() => {
    const desktop = desktopParam ? desktopParam.split(',').map((a) => a.trim()).filter((a) => DESKTOP_ANSWERS.includes(a)) : [];
    return simSource(scenario, desktop.length ? { desktop } : {});
  }, [scenario, desktopParam]);
  if (source) return <RunPage source={source} />;
  return (
    <RunShell source={{ kind: 'sim' }}>
      <h2 className="text-xl font-bold text-dark mb-2">Run page scenarios</h2>
      <ul data-testid="run-sim-list" className="list-disc pl-6 space-y-1 text-dark">
        {scenarioNames().map((name) => (
          <li key={name}><Link className="text-primary underline" to={`/run-sim/${name}`}>{name}</Link>: {SCENARIOS[name].title}</li>
        ))}
      </ul>
    </RunShell>
  );
}
