// sb3_pages-h6v A2: the simulated source behind /run-sim/:scenario (dev server only). Invented values, no Supabase
// client, no network: every answer is made up here. A page reading through it carries the SIMULATION strip, because
// RunShell draws the strip unless the source's kind is exactly 'real'.

import { ANSWERS, simulatedState } from './desktopCheck';

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

const dayDate = (now, days) => new Date(now + days * 24 * HOUR).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** A data operation page on the update scenario's frame, with its own operation, counts, undo and sample. */
function dataop(now, over, records) {
  const s = SCENARIOS['dataop-update'].build(now);
  return { request: { ...s.request, ...over }, sample: { records } };
}

const UNDO_STEPS = ['skip_edited', 'login_can_write', 'automation_unchanged', 'type_count', 'write', 'read_back', 'save_results'];
/**
 * The undo page, 1 hour after the run. An update's undo restores from the backup on the PC and has no deadline; a
 * delete's (`base: 'dataop-delete'`) ends when the records leave the recycle bin. No undo has a 24-hour expiry.
 */
function undoPage(now, undoOf, base = 'dataop-update') {
  const s = SCENARIOS[base].build(now);
  const up = undoOf.changed ?? s.request.counts.expected;
  const isDelete = s.request.operation.kind === 'delete';
  const { undo, ...rest } = s.request;
  return {
    request: {
      ...rest,
      page: 'undo',
      headline: isDelete
        ? `UNDO ${CODE}: RESTORES UP TO ${up} LIVE GIFTS IN example-prod FROM THE RECYCLE BIN`
        : `UNDO ${CODE}: PUTS BACK UP TO ${up} LIVE GIFTS IN example-prod FROM THE BACKUP`,
      counts: { expected: s.request.counts.expected, undo_up_to: up },
      undo_of: { run_tag: `${CODE}-s5-cd34`, ...undoOf },
      steps: codes(UNDO_STEPS),
      phases: [{ name: 'Data operation', state: undoOf.stopped ? 'interrupted' : 'passed', at: iso(now - HOUR) }, { name: 'Undo', state: 'waiting' }],
    },
    sample: isDelete
      ? { records: [{ role: 'record', id_label: 'Gift G-000777', deleted_by: `run ${CODE}-s5-cd34`, deleted_at: iso(now - HOUR), fields: [{ name: 'IsDeleted', now: 'true', after: 'false' }] }] }
      : { records: [{ role: 'record', id_label: 'Gift G-000123', fields: [
        { name: 'Campaign__c', now: 'Spring 2026 Appeal', after: '(empty)' }, { name: 'Amount__c', now: '50.00', after: '50.00' },
      ] }] },
  };
}

const MIN = 60 * 1000;

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
  // A4: the other operations on screen b, each on the update page's frame.
  'dataop-insert': {
    title: 'Data operation, insert from a file of rows',
    build: (now) => dataop(now, {
      headline: `DATA OPERATION ${CODE}: CREATES 12 LIVE GIFTS IN example-prod`,
      operation: { kind: 'insert', object: 'Gift__c', object_label: 'Gift', file: 'gifts-to-create.csv' },
      selected_by: { kind: 'ids', text: 'The 12 rows in gifts-to-create.csv, from the import log diagnosis read.' },
      counts: { expected: 12, total: 12 },
      undo: { level: 'standard', mechanics: 'Deletes them again.' },
    }, [{ role: 'create', id_label: 'Row 1 of gifts-to-create.csv', fields: [
      { name: 'Donor__c', now: '(new)', after: 'D-004512' }, { name: 'Amount__c', now: '(new)', after: '25.00' }, { name: 'Campaign__c', now: '(new)', after: 'Spring 2026 Appeal' },
    ] }]),
  },
  'dataop-upsert': {
    title: 'Data operation, upsert by external Id',
    build: (now) => dataop(now, {
      headline: `DATA OPERATION ${CODE}: UPDATES 30 AND CREATES 15 LIVE GIFTS IN example-prod`,
      operation: { kind: 'upsert', object: 'Gift__c', object_label: 'Gift', file: 'gifts-upsert.csv', external_id: 'Import_Ref__c' },
      selected_by: { kind: 'ids', text: 'The 45 rows in gifts-upsert.csv, matched by Import_Ref__c.' },
      counts: { expected: 45, total: 45, update: 30, create: 15 },
      undo: { level: 'standard', mechanics: 'Sets the 30 updated back from the backup and deletes the 15 created.' },
    }, [
      { role: 'update', id_label: 'Gift G-000123 (Import_Ref__c IMP-0042)', fields: [{ name: 'Campaign__c', now: '(empty)', after: 'Spring 2026 Appeal' }, { name: 'Amount__c', now: '50.00', after: '50.00' }] },
      { role: 'create', id_label: 'Import_Ref__c IMP-0107 (new)', fields: [{ name: 'Campaign__c', now: '(new)', after: 'Spring 2026 Appeal' }, { name: 'Amount__c', now: '(new)', after: '20.00' }] },
    ]),
  },
  'dataop-delete': {
    title: 'Data operation, delete to the recycle bin',
    build: (now) => dataop(now, {
      headline: `DATA OPERATION ${CODE}: DELETES 8 LIVE GIFTS IN example-prod TO THE RECYCLE BIN`,
      operation: { kind: 'delete', object: 'Gift__c', object_label: 'Gift' },
      selected_by: { kind: 'ids', text: 'The 8 duplicate gifts diagnosis listed.' },
      counts: { expected: 8, total: 8, children: 11, links_blanked: 3, links_blocking: 0 },
      undo: { level: 'standard', mechanics: 'Restores them, with their children, from the recycle bin.', deadline: dayDate(now, 15) },
    }, [{ role: 'record', id_label: 'Gift G-000777', child_count: 2, fields: [{ name: 'IsDeleted', now: 'false', after: 'true' }] }]),
  },
  'dataop-undelete': {
    title: 'Data operation, undelete from the recycle bin',
    build: (now) => dataop(now, {
      headline: `DATA OPERATION ${CODE}: RESTORES 8 GIFTS IN example-prod FROM THE RECYCLE BIN`,
      operation: { kind: 'undelete', object: 'Gift__c', object_label: 'Gift', days_left: 9 },
      selected_by: { kind: 'ids', text: 'The 8 gifts deleted by mistake on 17 November.' },
      counts: { expected: 8, total: 8 },
      undo: { level: 'standard', mechanics: 'Deletes them to the recycle bin again.' },
    }, [{ role: 'record', id_label: 'Gift G-000777', deleted_by: 'Sam Example', deleted_at: iso(now - 6 * 24 * HOUR), days_left: 9, fields: [{ name: 'IsDeleted', now: 'true', after: 'false' }] }]),
  },
  'dataop-multi': {
    title: 'Data operation, a run across several objects',
    build: (now) => {
      const steps = [
        { object: 'Account', label_plural: 'Accounts', kind: 'insert', count: 20 },
        { object: 'Contact', label_plural: 'Contacts', kind: 'insert', count: 35 },
        { object: 'Opportunity', label_plural: 'Opportunities', kind: 'insert', count: 35, pause_before: true },
      ];
      return dataop(now, {
        headline: `DATA OPERATION ${CODE}: CREATES 90 LIVE RECORDS ACROSS 3 OBJECTS IN example-prod`,
        operation: { kind: 'multi', steps },
        selected_by: { kind: 'ids', text: 'The rows in households.csv, contacts.csv and pledges.csv.' },
        counts: { expected: 90, total: 90 },
        undo: { level: 'backup_only', mechanics: 'Deletes what was created, newest step first, from the backup of Ids.' },
        steps: [...codes(['still_match_backup', 'login_can_write', 'automation_unchanged', 'type_count']),
          ...steps.map((s) => ({ code: 'write_step', ...s })), ...codes(['read_back', 'save_results'])],
      }, [{ role: 'create', id_label: 'Account row 1 of households.csv', fields: [{ name: 'Name', now: '(new)', after: 'The Example Household' }] }]);
    },
  },
  // Screen c, the undo page.
  undo: {
    title: 'Undo of the update',
    build: (now) => undoPage(now, {}),
  },
  'undo-stopped': {
    title: 'Undo after a stopped run: only what it changed',
    build: (now) => undoPage(now, { stopped: true, changed: 20 }),
  },
  'undo-delete': {
    title: 'Undo of the delete, before the recycle bin empties',
    build: (now) => undoPage(now, { deadline: iso(now + 14 * 24 * HOUR), deadline_reason: 'the deleted gifts left the recycle bin after 15 days' }, 'dataop-delete'),
  },
  'undo-closed': {
    title: 'Undo of the delete after its deadline: no undo offered',
    build: (now) => undoPage(now, { deadline: iso(now - 2 * 24 * HOUR), deadline_reason: 'the deleted gifts left the recycle bin after 15 days' }, 'dataop-delete'),
  },
  // A5: screen d, the correction page.
  'correction-field': {
    title: 'Corrected request: which field changed, so the rehearsal and the login check run again',
    build: (now) => {
      // A field edit reruns the login check and the rehearsal; everything else stays valid.
      const evidence = passedEvidence(now, 2).map((e) => (['login', 'rehearsal'].includes(e.check) ? { ...e, voided: true } : e));
      return {
        request: base({
          page: 'correction', version: 2, corrected_at: iso(now - 10 * MIN), orgs: [PROD, SANDBOX],
          headline: `CORRECTED REQUEST ${CODE}: RUNS THE LOGIN CHECK AND THE REHEARSAL AGAIN FOR Appeal__c`,
          operation: { kind: 'update', object: 'Gift__c', object_label: 'Gift', field: 'Appeal__c', value: 'Spring 2026 Appeal' },
          steps: codes(['login_can_change', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test']),
          evidence,
          phases: [{ name: 'Pre-check and rehearsal', state: 'waiting' }, { name: 'Data operation', state: 'not_started' }],
          changed: {
            edit_kind: 'field', from_version: 1,
            reason: 'The Spring appeal report reads Appeal__c, not Campaign__c; diagnosis named the wrong field.',
            items: [{ what: 'Field', old: 'Campaign__c', new: 'Appeal__c' }],
            still_valid: evidence.filter((e) => !e.voided).map(({ check, passed_at }) => ({ check, passed_at })),
          },
          details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(6) }], queries: [{ label: 'The listed records', soql: IDS_SOQL }] },
        }),
      };
    },
  },
  'dataop-update-wording': {
    title: 'Data operation, carrying a wording-only correction (no page of its own)',
    build: (now) => {
      const s = SCENARIOS['dataop-update'].build(now);
      return { ...s, request: { ...s.request, version: 2, corrected_at: iso(now - 30 * MIN), changed: {
        edit_kind: 'wording', from_version: 1, reason: 'Diagnosis reworded the side effects after checking the flow.',
        items: [{ what: 'Side effects', old: 'Saving a gift recalculates its rollups.', new: s.request.side_effects }],
      } } };
    },
  },
  // A5: not started, both ways.
  'not-started-marked': {
    title: 'Approved, never picked up: marked by plumbing',
    build: (now) => ({ ...SCENARIOS['dataop-update'].build(now), run: { consumed_at: iso(now - 20 * MIN), picked_up_at: null, failure_reason: 'expired_not_picked_up' } }),
  },
  'not-started-worked-out': {
    title: 'Approved, never picked up: worked out from the stored times',
    build: (now) => ({ ...SCENARIOS['dataop-update'].build(now), run: { consumed_at: iso(now - 20 * MIN), picked_up_at: null, failure_reason: null } }),
  },
  'not-started-expired': {
    title: 'Approved, never picked up, and the checks have since expired',
    build: (now) => {
      const s = SCENARIOS['dataop-update-expired'].build(now);
      return { ...s, run: { consumed_at: iso(now - 3 * HOUR), picked_up_at: null, failure_reason: 'expired_not_picked_up' } };
    },
  },
  // The link is used: the page only reports.
  'run-picked-up': {
    title: 'Approved and picked up: running',
    build: (now) => ({ ...SCENARIOS['dataop-update'].build(now), run: { consumed_at: iso(now - 10 * MIN), picked_up_at: iso(now - 9 * MIN) } }),
  },
  'run-finished': {
    title: 'Approved, picked up and finished',
    build: (now) => ({ ...SCENARIOS['dataop-update'].build(now), run: { consumed_at: iso(now - 40 * MIN), picked_up_at: iso(now - 39 * MIN), finished_at: iso(now - 30 * MIN) } }),
  },
  // A5: checks expired, and the same page after the pre-check ran again.
  'dataop-update-expired': {
    title: 'Data operation, checks expired: run the pre-check and rehearsal again',
    build: (now) => {
      const s = SCENARIOS['dataop-update'].build(now);
      return { ...s, request: { ...s.request, orgs: [PROD, SANDBOX], evidence: passedEvidence(now, 26),
        phases: [{ name: 'Pre-check and rehearsal', state: 'passed', at: iso(now - 26 * HOUR) }, { name: 'Data operation', state: 'waiting' }] } };
    },
  },
  'dataop-update-rerun-waiting': {
    title: 'Data operation, checks expired, the rerun asked for and not yet passed',
    build: (now) => {
      const s = SCENARIOS['dataop-update-expired'].build(now);
      return { ...s, request: { ...s.request, rerun_at: iso(now - 5 * MIN) } };
    },
  },
  'dataop-update-rerun-passed': {
    title: 'Data operation, after the pre-check and rehearsal ran again',
    build: (now) => {
      const s = SCENARIOS['dataop-update'].build(now);
      return { ...s, request: { ...s.request, rerun_at: iso(now - 40 * MIN), evidence: passedEvidence(now, 0.5),
        phases: [{ name: 'Pre-check and rehearsal', state: 'passed', at: iso(now - 30 * MIN), rerun: true }, { name: 'Data operation', state: 'waiting' }] } };
    },
  },
  // A5: check what happened after an interrupted run.
  check: {
    title: 'Check what happened after an interrupted run',
    build: (now) => ({
      request: base({
        page: 'check', version: 1, orgs: [PROD],
        headline: `CHECK WHAT HAPPENED ${CODE}: READS 45 GIFTS IN example-prod, CHANGES NOTHING`,
        interrupted: { run_tag: `${CODE}-s5-cd34`, at: iso(now - 2 * HOUR), where: 'Write, after about 20 of 45 records; the terminal window closed.' },
        steps: codes(['job_state', 'compare_records', 'find_temp_code']), evidence: [],
        phases: [{ name: 'Data operation', state: 'interrupted', at: iso(now - 2 * HOUR) }, { name: 'Check what happened', state: 'waiting' }],
        details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'backup.csv', sha256: hash(5) }], queries: [{ label: 'The listed records', soql: IDS_SOQL }] },
      }),
    }),
  },
  // The desktop states (A3): the scenario's own answers, one per ask. ?desktop= overrides them.
  'desktop-not-running': {
    title: 'Data operation, update, desktop not running until Check again',
    desktop: ['not_running', 'running'],
    build: (now) => SCENARIOS['dataop-update'].build(now),
  },
  'desktop-no-extension': {
    title: 'Data operation, update, opened where there is no Alfred extension',
    desktop: ['no_extension'],
    build: (now) => SCENARIOS['dataop-update'].build(now),
  },
  'desktop-no-answer': {
    title: "Data operation, update, the extension doesn't answer",
    desktop: ['no_answer'],
    build: (now) => SCENARIOS['dataop-update'].build(now),
  },
};

/** The made-up desktop answers a scenario can give: the same four states the real check gives. */
export const DESKTOP_ANSWERS = ANSWERS;

/** The scenario names, in order, for the index page. */
export const scenarioNames = () => Object.keys(SCENARIOS);

/**
 * The simulated source for one scenario. `desktop` overrides the made-up desktop answers, one per ask (page open,
 * each Check again, the Approve click), the last repeating; the default is "running". It stands in for desktopCheck's
 * askDesktop until plumbing ships the extension's reply. Everything resolves locally; nothing leaves the browser.
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
    load: async () => ({ link_id: linkId, request: built.request, sample: built.sample ?? null, run: built.run ?? null }),
    checkDesktop: async () => {
      return simulatedState(answers.length > 1 ? answers.shift() : answers[0]);
    },
    approve: async () => ({ sent: true, link_id: linkId }),
    // Checks expired: the rerun click is its own approval (spec part 5, rerun mode).
    rerun: async () => ({ sent: true, rerun: true, link_id: linkId }),
    // Not started: resend the same run, same link id (spec 4.5).
    resend: async () => ({ sent: true, resent: true, link_id: linkId }),
    cancel: async (reason) => ({ cancelled: true, reason: String(reason ?? '').trim() }),
  };
}
