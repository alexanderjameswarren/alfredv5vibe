// sb3_pages-h6v A2: the simulated source behind /run-sim/:scenario (dev server only). Invented values, no Supabase
// client, no network: every answer is made up here. A page reading through it carries the SIMULATION strip, because
// RunShell draws the strip unless the source's kind is exactly 'real'.

const HOUR = 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString();
const hash = (n) => `${String(n).repeat(6)}9c2a7be104d55c86a1e0f2b7c943d1a8e65f02c47b9d13e5a0c8f6b2d71e94`.slice(0, 64);

const PROD = { alias: 'example-prod', org_type: 'production', role: 'target' };
const SANDBOX = { alias: 'example-dev1', org_type: 'sandbox', role: 'rehearsal' };
const CODE = 'demo_gift_campaign-x1y';
const IDS_SOQL = "SELECT Id, Campaign__c FROM Gift__c\nWHERE Id IN ('a0B5g00000AbCdEAAV', 'a0B5g00000AbCdFAAV', ...)";
const FILTER_SOQL = "SELECT Id, Campaign__c FROM Gift__c\nWHERE Source__c = 'Spring import'\n  AND CreatedDate = LAST_N_DAYS:30\n  AND Campaign__c = null";

const base = (over) => ({
  simulation: true,
  project_code: CODE,
  run_tag: `${CODE}-s4-ab12`,
  client: 'Example Charity',
  problem: { label: 'P1a', sentence: 'Gifts imported on 3 November were saved with no campaign, so the Spring appeal report shows them as unattributed.' },
  side_effects: "Saving a gift recalculates its donor's campaign rollups, and the Gift After Save flow sends no email for this field.",
  operation: { kind: 'update', object: 'Gift__c', object_label: 'Gift', field: 'Campaign__c', value: 'Spring 2026 Appeal' },
  selected_by: { kind: 'ids', text: 'The 45 Ids diagnosis listed from the import log.' },
  counts: { expected: 45, total: 45 },
  ...over,
});

const PRECHECK_STEPS = ['count_listed', 'login_can_change', 'list_automation', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'];
const PRECHECK_FILTER_STEPS = ['count_filter', ...PRECHECK_STEPS.slice(1)];
const DATAOP_STEPS = ['still_match_backup', 'login_can_write', 'automation_unchanged', 'type_count', 'write', 'read_back', 'save_results'];
const codes = (list) => list.map((code) => ({ code }));

/** The evidence of a passed pre-check, `hoursAgo` hours before now. */
const passedEvidence = (now, hoursAgo) => ['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']
  .map((check, i) => ({ check, org: check === 'rehearsal' ? 'sandbox' : 'production', passed_at: iso(now - hoursAgo * HOUR + i * 60 * 1000) }));

/** Every scenario: its request, the sample the page holds (not on a pre-check) and the desktop answers, in order. */
export const SCENARIOS = {
  'precheck-ids': {
    title: 'Pre-check and rehearsal, records listed by Id',
    build: () => ({
      request: base({
        page: 'precheck', version: 1, orgs: [PROD, SANDBOX],
        headline: `PRE-CHECK AND REHEARSAL ${CODE}: READS 45 GIFTS IN example-prod, REHEARSES ON example-dev1`,
        steps: codes(PRECHECK_STEPS), evidence: [],
        phases: [{ name: 'Pre-check and rehearsal', state: 'waiting' }, { name: 'Data operation', state: 'not_started' }],
        details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(1) }], queries: [{ label: 'The listed records', soql: IDS_SOQL }] },
      }),
    }),
  },
  'precheck-filter': {
    title: 'Pre-check and rehearsal, records chosen by a filter',
    build: () => ({
      request: base({
        page: 'precheck', version: 1, orgs: [PROD, SANDBOX],
        headline: `PRE-CHECK AND REHEARSAL ${CODE}: READS WHAT THE FILTER MATCHES IN example-prod, REHEARSES ON example-dev1`,
        selected_by: { kind: 'filter', text: "Source__c = 'Spring import', created in the last 30 days, with no campaign." },
        steps: codes(PRECHECK_FILTER_STEPS), evidence: [],
        phases: [{ name: 'Pre-check and rehearsal', state: 'waiting' }, { name: 'Data operation', state: 'not_started' }],
        details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(2) }, { name: 'selection.soql', sha256: hash(3) }], queries: [{ label: 'The filter', soql: FILTER_SOQL }] },
      }),
    }),
  },
  'precheck-filter-differs': {
    title: 'Pre-check and rehearsal, a sandbox filter that must differ',
    build: () => ({
      request: base({
        page: 'precheck', version: 1, orgs: [PROD, SANDBOX],
        headline: `PRE-CHECK AND REHEARSAL ${CODE}: READS WHAT THE FILTER MATCHES IN example-prod, REHEARSES ON example-dev1`,
        selected_by: {
          kind: 'filter',
          text: "Source__c = 'Spring import', created in the last 30 days, with no campaign.",
          sandbox_text: "Source__c = 'Spring import', with no campaign (the sandbox copy is older than 30 days).",
          not_rehearsed: 'The 30-day limit on CreatedDate.',
        },
        steps: codes(PRECHECK_FILTER_STEPS), evidence: [],
        phases: [{ name: 'Pre-check and rehearsal', state: 'waiting' }, { name: 'Data operation', state: 'not_started' }],
        details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(4) }], queries: [{ label: 'The filter', soql: FILTER_SOQL }] },
      }),
    }),
  },
  'dataop-update': {
    title: 'Data operation, update',
    build: (now) => ({
      request: base({
        page: 'dataop', version: 1, orgs: [PROD],
        headline: `DATA OPERATION ${CODE}: UPDATES 45 LIVE GIFTS IN example-prod`,
        steps: codes(DATAOP_STEPS), evidence: passedEvidence(now, 3),
        phases: [{ name: 'Pre-check and rehearsal', state: 'passed', at: iso(now - 3 * HOUR) }, { name: 'Data operation', state: 'waiting' }],
        undo: { level: 'standard', mechanics: 'Sets each campaign back to empty from the backup.' },
        details: {
          run_folder: `data-ops/${CODE}/2026-11-23`,
          hashes: [{ name: 'request.json', sha256: hash(1) }, { name: 'backup.csv', sha256: hash(5) }],
          queries: [{ label: 'The listed records', soql: IDS_SOQL }],
        },
      }),
      sample: { records: [{ role: 'record', id_label: 'Gift G-000123', fields: [
        { name: 'Campaign__c', now: '(empty)', after: 'Spring 2026 Appeal' },
        { name: 'Amount__c', now: '50.00', after: '50.00' },
      ] }] },
    }),
  },
  'dataop-update-kept': {
    title: 'Data operation, update, with sandbox test data and temporary code kept',
    build: (now) => {
      const s = SCENARIOS['dataop-update'].build(now);
      return { ...s, request: { ...s.request, kept: { sandbox_test_data: '3 TEST gifts left in example-dev1 for the next rehearsal.', temp_code_in_production: 'GiftCampaignFixBatch, deleted after the run.' } } };
    },
  },
};

/** The made-up desktop answers a scenario can give. */
export const DESKTOP_ANSWERS = ['running', 'panel_down', 'helper_down', 'not_running', 'no_extension', 'no_answer'];

/** The scenario names, in order, for the index page. */
export const scenarioNames = () => Object.keys(SCENARIOS);

/**
 * The simulated source for one scenario. `desktop` overrides the made-up desktop answers, one per ask; until A3 the
 * default is "running". Everything resolves locally; nothing leaves the browser.
 */
export function simSource(name, { now = Date.now(), desktop } = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) return null;
  const built = scenario.build(now);
  const answers = [...(desktop ?? scenario.desktop ?? ['running'])];
  const linkId = `sim-${name}`.slice(0, 44);
  return {
    kind: 'sim',
    name,
    load: async () => ({ link_id: linkId, request: built.request, sample: built.sample ?? null }),
    checkDesktop: async () => {
      const a = answers.length > 1 ? answers.shift() : answers[0];
      return { answer: a, panel: a === 'running' || a === 'helper_down', helper: a === 'running' || a === 'panel_down' };
    },
    approve: async () => ({ sent: true, link_id: linkId }),
    cancel: async (reason) => ({ cancelled: true, reason: String(reason ?? '').trim() }),
  };
}
