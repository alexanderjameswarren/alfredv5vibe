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

// dataop_link-k7d s6: sf_dataquery samples. Invented values; the hashes are placeholders, not real SHA-256s.
const DQ_CODE = 'demo_link_installments-x1y';
const DQ_SELECTION = "SELECT Id, Demo_Plan__c, Paid__c\nFROM Demo_Installment__c\nWHERE Source__c = 'Demo Import'\n" +
  '  AND CreatedDate >= 2026-10-01T00:00:00Z\n  AND CreatedDate < 2026-11-18T00:00:00Z\n  AND Demo_Plan__c = null\n';
const DQ_BASE = {
  alias: 'demo-prod', org_type: 'production', repo: 'C:\\Users\\Alex\\projects\\demo-client', run: `data-ops/${DQ_CODE}/link-2026-11-19`,
  run_tag: `${DQ_CODE}-s6-k2p9`, request_sha256: '9b1e4c07d2a35f68e0c4b19a7d3e52f6a81c0d4e97b2f35a6c8d01e4b7a29f53',
};
const hashOf = (n) => `${String(n).repeat(4)}a7c19e04d8b2f6`.repeat(4).slice(0, 64);
export const SAMPLE_DATAQUERIES = {
  export: { ...DQ_BASE, queries: [
    { step: 'manifest', soql: DQ_SELECTION, sha256: hashOf(1), file: 'selection.soql' },
    { step: 'undo', soql: DQ_SELECTION, sha256: hashOf(1), file: 'selection.soql' },
  ] },
  newline: { ...DQ_BASE, queries: [
    { step: 'manifest', soql: `\n\n    ${DQ_SELECTION}`, sha256: hashOf(2), file: 'selection.soql' },
  ] },
  count: { ...DQ_BASE, queries: [
    { step: 'rules', soql: "SELECT COUNT() FROM Demo_Installment__c WHERE Source__c = 'Demo Import' AND Demo_Plan__c = null",
      sha256: hashOf(3), label: 'Installments with no plan link' },
    { step: 'rules', soql: 'SELECT COUNT() FROM Demo_Plan__c WHERE Rollup_Pending__c = true', sha256: hashOf(4),
      label: 'Plans whose totals are still updating' },
    { step: 'rules', soql: "SELECT COUNT() FROM Demo_Installment__c WHERE Source__c = 'Demo Import' AND Demo_Plan__c = null AND CreatedDate > 2026-11-18T00:00:00Z",
      sha256: hashOf(5), label: 'Installments with no plan link: new since the freeze' },
  ] },
  // The export cap: one query of 100,000 characters, to check the layout holds.
  long: { ...DQ_BASE, queries: [
    { step: 'before', soql: `SELECT Id, Name FROM Demo_Installment__c WHERE Name != '${'x'.repeat(100000 - 61)}'`, sha256: hashOf(6), label: 'broad snapshot' },
  ] },
};
// dataquery_fixes-v3n: a sandbox count link, and an old link with no org_type.
SAMPLE_DATAQUERIES.sandbox = { ...SAMPLE_DATAQUERIES.count, alias: 'demo-sandbox', org_type: 'sandbox' };
SAMPLE_DATAQUERIES.untyped = (({ org_type: _o, ...p }) => p)(SAMPLE_DATAQUERIES.export);
const dqHeadline = (p) => {
  const steps = [...new Set(p.queries.map((q) => q.step))];
  const n = p.queries.length;
  return `${p.org_type === 'sandbox' ? 'SANDBOX' : 'PRODUCTION'} ${['manifest', 'before', 'undo'].includes(steps[0]) ? 'EXPORT' : 'COUNTS'} ${DQ_CODE} ON ${p.alias}: ` +
    `${n} QUER${n === 1 ? 'Y' : 'IES'} (${steps.join(', ')}), READ ONLY`;
};

const FIXTURES = { sf_dataop: true, sf_dataquery: true };

// Module-level, so ApprovePage's load effect sees the same functions on every render.
const fakeSession = () => Promise.resolve({ data: { session: { access_token: 'fixture' } } });

function fakeRunnerFor(payload, kind = 'sf_dataop') {
  return async (route, body) => {
    if (route === 'preview') {
      return { status: 200, body: { ok: true, kind, action_id: 'fixture-action', fingerprint: 'fixture-fp',
        project_code: DQ_CODE, expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
        headline: kind === 'sf_dataquery' ? dqHeadline(payload) : headline(payload), payload } };
    }
    if (route === 'approve') return { status: 200, body: { ok: true, action_id: 'fixture-action', sent: true } };
    if (route === 'cancel') return { status: 200, body: { ok: true, action_id: 'fixture-action', cancelled: true, reason: body?.reason ?? '' } };
    return { status: 409, body: { ok: false, error: `the fixture has no ${route}.` } };
  };
}
const RUNNERS = new Map();
const runnerFor = (key, payload, kind) => {
  if (!RUNNERS.has(key)) RUNNERS.set(key, fakeRunnerFor(payload, kind));
  return RUNNERS.get(key);
};

const DQ_CHOICES = [['export', 'Export: manifest and undo'], ['newline', 'Export: leading newline'], ['count', 'Count link'],
  ['long', 'Export: 100,000 characters'], ['sandbox', 'Sandbox count link'], ['untyped', 'Old link: no org type']];

function DataqueryFixture() {
  const [which, setWhich] = useState('export');
  return (
    <div>
      <div data-testid="approve-fixture-bar" className="bg-gray-800 text-white text-sm px-4 py-2 flex flex-wrap gap-x-4 gap-y-1 items-center">
        <span className="font-bold">Dev fixture: nothing here reaches Supabase or the runner.</span>
        <label className="inline-flex items-center gap-2 min-h-[44px]">
          Link
          <select data-testid="approve-fixture-dataquery" value={which} onChange={(e) => setWhich(e.target.value)}
            className="text-black rounded px-2 py-1 min-h-[36px]">
            {DQ_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
      </div>
      <ApprovePage key={`dq-${which}`} runner={runnerFor(`dq-${which}`, SAMPLE_DATAQUERIES[which], 'sf_dataquery')} session={fakeSession} />
    </div>
  );
}

export default function ApproveFixture() {
  const { kind } = useParams();
  const [bulk, setBulk] = useState(false);
  const [noRehearsal, setNoRehearsal] = useState(false);
  if (!FIXTURES[kind]) {
    return <p className="p-4 text-dark">No fixture for {kind}. Try /approve-fixture/sf_dataop or /approve-fixture/sf_dataquery.</p>;
  }
  if (kind === 'sf_dataquery') return <DataqueryFixture />;
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
