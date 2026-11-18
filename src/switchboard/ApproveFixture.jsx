import { useState } from 'react';
import { useParams } from 'react-router-dom';
import ApprovePage from './ApprovePage';

// DEV SERVER ONLY (dataops_alfred-d4x s6b). /approve-fixture/:kind renders the real ApprovePage with a sample payload
// and a fake runner and session, so the sf_dataop page can be looked at without queueing a real production run.
// Nothing here reaches Supabase or the runner: Approve and Don't run answer locally. App.js mounts the route only when
// process.env.NODE_ENV !== 'production', so a build never contains it.

/** A sample like Fix C: a batch over 26,571 records, several rows, two knock-on checks, a sandbox pass. Invented values. */
export const SAMPLE_DATAOP = {
  alias: 'demo-prod',
  repo: 'C:\\Users\\Alex\\projects\\demo-client',
  plan: 'dataops\\link-installments-plan.json',
  stamp: '3f9c2a7be104d55c86a1e0f2b7c943d1a8e65f02c47b9d13e5a0c8f6b2d71e94',
  preflight_at: '2026-11-18T15:04:00Z',
  object: 'Demo_Installment__c',
  problem: 'Installments paid since the October import were never linked to their recurring plan, so each plan shows less paid than the donor gave and the next charge is calculated on the wrong balance.',
  expected: 26571,
  write: { kind: 'batch', class: 'DemoLinkInstallmentsBatch' },
  rows: [
    { label: 'Installments in the list linked to their plan', before: 0, goal: 26571 },
    { label: 'Installments in the list with no plan link', before: 26571, goal: 0 },
    { label: 'Installments in the list still marked as paid', before: 26571, goal: 26571 },
    { label: 'Installments in the list linked to another donor\'s plan', before: 0, goal: 0 },
    { label: 'Plans whose paid total went up today', before: 0, goal: 4180, knock_on: true },
    { label: 'Knock-on check: Plans now shown as paid ahead of schedule', before: 0, goal: 0, knock_on: true },
  ],
  rehearsal: { sandbox: 'demo-dev1', at: '2026-11-18T16:20:00Z' },
};

/** The sample as the toggles shape it. */
export function samplePayload({ bulk = false, noRehearsal = false } = {}) {
  const { rehearsal, ...rest } = SAMPLE_DATAOP;
  return {
    ...rest,
    ...(bulk ? { write: { kind: 'bulk' } } : {}),
    ...(noRehearsal ? {} : { rehearsal }),
  };
}

const headline = (p) => `PRODUCTION DATA RUN demo_link_installments-x1y ON ${p.alias}: ABOUT TO CHANGE ` +
  `${p.expected.toLocaleString('en-US')} LIVE RECORDS OF ${p.object} ${p.write.kind === 'batch' ? `BY BATCH ${p.write.class}` : 'BY BULK'}`;

const FIXTURES = { sf_dataop: true };

// Module-level, so ApprovePage's load effect sees the same functions on every render.
const fakeSession = () => Promise.resolve({ data: { session: { access_token: 'fixture' } } });

function fakeRunnerFor(payload) {
  return async (route, body) => {
    if (route === 'preview') {
      return { status: 200, body: { ok: true, kind: 'sf_dataop', action_id: 'fixture-action', fingerprint: 'fixture-fp',
        project_code: 'demo_link_installments-x1y', expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
        headline: headline(payload), payload } };
    }
    if (route === 'approve') return { status: 200, body: { ok: true, action_id: 'fixture-action', sent: true } };
    if (route === 'cancel') return { status: 200, body: { ok: true, action_id: 'fixture-action', cancelled: true, reason: body?.reason ?? '' } };
    return { status: 409, body: { ok: false, error: `the fixture has no ${route}.` } };
  };
}
const RUNNERS = new Map();
const runnerFor = (key, payload) => {
  if (!RUNNERS.has(key)) RUNNERS.set(key, fakeRunnerFor(payload));
  return RUNNERS.get(key);
};

export default function ApproveFixture() {
  const { kind } = useParams();
  const [bulk, setBulk] = useState(false);
  const [noRehearsal, setNoRehearsal] = useState(false);
  if (!FIXTURES[kind]) {
    return <p className="p-4 text-dark">No fixture for {kind}. Try /approve-fixture/sf_dataop.</p>;
  }
  const key = `${bulk ? 'bulk' : 'batch'}-${noRehearsal ? 'none' : 'rehearsed'}`;
  return (
    <div>
      <div data-testid="approve-fixture-bar" className="bg-gray-800 text-white text-sm px-4 py-2 flex flex-wrap gap-x-4 gap-y-1 items-center">
        <span className="font-bold">Dev fixture: nothing here reaches Supabase or the runner.</span>
        <label className="inline-flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} /> Bulk write
        </label>
        <label className="inline-flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" checked={noRehearsal} onChange={(e) => setNoRehearsal(e.target.checked)} /> No rehearsal
        </label>
      </div>
      {/* A new key remounts the page, so it loads the changed sample like a fresh link. */}
      <ApprovePage key={key} runner={runnerFor(key, samplePayload({ bulk, noRehearsal }))} session={fakeSession} />
    </div>
  );
}
