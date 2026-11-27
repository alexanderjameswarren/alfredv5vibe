// sb3_pages-h6v A2: the simulated source behind /run-sim/:scenario (dev server only). Invented values, no Supabase
// client, no network: every answer is made up here. A page reading through it carries the SIMULATION strip, because
// RunShell draws the strip unless the source's kind is exactly 'real'.

import { ANSWERS, simulatedState } from './desktopCheck';
import { EDIT_RERUNS, RECORDS_QUERY, rerunSteps } from './runContract';

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

/**
 * A correction page (screen d), version 2, 10 minutes after the edit: its steps are exactly what the edit kind reruns,
 * the evidence those checks made is voided, and "Still valid" lists the rest.
 */
function correction(now, kind, over, reason, items) {
  const reruns = EDIT_RERUNS[kind];
  const evidence = passedEvidence(now, 2).map((e) => (reruns.includes(e.check) ? { ...e, voided: true } : e));
  return {
    request: base({
      page: 'correction', version: 2, corrected_at: iso(now - 10 * MIN), orgs: [PROD, SANDBOX],
      headline: `CORRECTED REQUEST ${CODE}: RUNS AGAIN WHAT THE ${kind.toUpperCase().replace('_', ' ')} EDIT TOUCHES`,
      // The count step that fits the selection: listed Ids or a filter.
      steps: codes(rerunSteps(kind).filter((c) => c !== (over.selected_by?.kind === 'filter' ? 'count_listed' : 'count_filter'))),
      evidence,
      phases: [{ name: 'Pre-check and rehearsal', state: 'waiting' }, { name: 'Data operation', state: 'not_started' }],
      changed: {
        edit_kind: kind, from_version: 1, reason, items,
        still_valid: evidence.filter((e) => !e.voided).map(({ check, passed_at }) => ({ check, passed_at })),
      },
      details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(6) }], queries: [{ label: RECORDS_QUERY, soql: IDS_SOQL }] },
      ...over,
    }),
  };
}

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
        details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(1) }], queries: [{ label: RECORDS_QUERY, soql: IDS_SOQL }] },
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
          queries: [{ label: RECORDS_QUERY, soql: IDS_SOQL }],
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
  // Each edit kind: the steps and the voided evidence follow EDIT_RERUNS (rerunSteps), never typed by hand.
  'correction-field': {
    title: 'Corrected request: which field, so the rehearsal, the login check, the backup and the sample record run again',
    build: (now) => correction(now, 'field', {
      operation: { kind: 'update', object: 'Gift__c', object_label: 'Gift', field: 'Appeal__c', value: 'Spring 2026 Appeal' },
    }, 'The Spring appeal report reads Appeal__c, not Campaign__c; diagnosis named the wrong field.', [{ what: 'Field', old: 'Campaign__c', new: 'Appeal__c' }]),
  },
  'correction-value': {
    title: 'Corrected request: the value, so the rehearsal runs again',
    build: (now) => correction(now, 'value', {
      operation: { kind: 'update', object: 'Gift__c', object_label: 'Gift', field: 'Campaign__c', value: 'Spring 2026 Appeal (Online)' },
    }, 'The online gifts belong to the online appeal; the client confirmed the campaign name.', [{ what: 'Value', old: 'Spring 2026 Appeal', new: 'Spring 2026 Appeal (Online)' }]),
  },
  'correction-records': {
    title: 'Corrected request: which records (Id list), so the count, the backup and the sample run again',
    build: (now) => correction(now, 'records', {
      selected_by: { kind: 'ids', text: 'The 48 Ids diagnosis listed from the import log, including 3 found later.' },
      counts: { expected: 48, total: 48 },
      details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(7) }], queries: [{ label: RECORDS_QUERY, soql: IDS_SOQL.replace("...)", "... 48 Ids)") }] },
    }, 'Three more gifts from the same import were found in the log.', [{ what: 'Records', old: '45 listed Ids', new: '48 listed Ids' }]),
  },
  'correction-records-filter': {
    title: 'Corrected request: which records (filter), so the count, the backup, the sample and the rehearsal run again',
    build: (now) => correction(now, 'records_filter', {
      selected_by: { kind: 'filter', text: "Source__c = 'Spring import', created in the last 45 days, with no campaign." },
      details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(8) }], queries: [{ label: 'The filter', soql: FILTER_SOQL.replace('LAST_N_DAYS:30', 'LAST_N_DAYS:45') }] },
    }, 'The import ran over two weeks, so 30 days missed the first batch.', [{ what: 'Filter', old: 'created in the last 30 days', new: 'created in the last 45 days' }]),
  },
  'correction-sandbox-filter': {
    title: 'Corrected request: the sandbox filter, so only the rehearsal runs again',
    build: (now) => correction(now, 'sandbox_filter', {
      selected_by: {
        kind: 'filter', text: "Source__c = 'Spring import', created in the last 30 days, with no campaign.",
        sandbox_text: "Source__c = 'Spring import', with no campaign, in the 2026-11-01 sandbox refresh.", not_rehearsed: 'The 30-day limit on CreatedDate.',
      },
      details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'request.json', sha256: hash(9) }], queries: [{ label: 'The filter', soql: FILTER_SOQL }] },
    }, 'The sandbox was refreshed on 1 November, so its copy needs its own date.', [{ what: 'Sandbox filter', old: 'with no campaign', new: 'with no campaign, in the 2026-11-01 sandbox refresh' }]),
  },
  'correction-code': {
    title: 'Corrected request: the code, so the rehearsal runs again and a new code review follows',
    build: (now) => correction(now, 'code', {
      code: { commit: '8b1e07d4c2a95f36', rehearsed_at: null },
    }, 'The batch skipped gifts whose source had a trailing space; the fix trims it.', [{ what: 'Code', old: 'commit 4f9c2ab', new: 'commit 8b1e07d' }]),
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
  // s17: the write's outcome, as its run recorded it (254). Only the parts the page names; knock-on rows come last.
  'run-finished-outcome': {
    title: 'Finished, with its outcome',
    build: (now) => ({
      ...SCENARIOS['run-finished'].build(now),
      outcome: {
        changed: 45,
        rows: [
          { label: 'Donor rollups recalculated', before: 0, goal: 12, after: 12, knock_on: true },
          { label: 'Gifts in the list with no campaign', before: 45, goal: 0, after: 0 },
          { label: 'Gifts in the list on another campaign', before: 0, goal: 0, after: 0 },
        ],
        // Not a part the page names: never shown.
        raw: { exit_code: 0 },
      },
    }),
  },
  'run-stopped-outcome': {
    title: 'Stopped part way, with its outcome',
    build: (now) => ({
      ...SCENARIOS['dataop-update'].build(now),
      run: { consumed_at: iso(now - 40 * MIN), picked_up_at: iso(now - 39 * MIN), finished_at: iso(now - 30 * MIN), failure_reason: 'stopped' },
      outcome: {
        changed: 20,
        rows: [{ label: 'Gifts in the list with no campaign', before: 45, goal: 0, after: 25 }],
        stopped: { already_changed: 20, saved_on_pc: [`data-ops/${CODE}/2026-11-23/backup.csv`, `data-ops/${CODE}/2026-11-23/results.csv`] },
      },
    }),
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
        details: { run_folder: `data-ops/${CODE}/2026-11-23`, hashes: [{ name: 'backup.csv', sha256: hash(5) }], queries: [{ label: RECORDS_QUERY, soql: IDS_SOQL }] },
      }),
    }),
  },
  // s28: a pretend pre-check: its source's kind is 'pretend', so the page carries the extension's marks with
  // SIMULATION lines and data-switchboard-pretend. Still made up here: nothing leaves the browser.
  'pretend-precheck': {
    title: 'Pretend pre-check and rehearsal: marked like a real page, its lines SIMULATION',
    kind: 'pretend',
    build: (now) => {
      const s = SCENARIOS['precheck-ids'].build(now);
      return { ...s, request: { ...s.request, pretend: { scenario: 'count_ok' } } };
    },
  },
  // s28 (O2): the structured allows, drawn beside diagnosis's sentences.
  'dataop-allows': {
    title: 'Data operation, update, with what diagnosis allows (structured)',
    build: (now) => {
      const s = SCENARIOS['dataop-update'].build(now);
      return { ...s, request: { ...s.request,
        diagnosis_allows: ['Other gifts may change while it runs; only these 45 are written.'],
        allows: {
          mode: 'moving',
          kinds: [{ kind: 'Gift edited by a person', limit: 2, reason: 'Fundraisers edit gifts during the day; an edited gift is skipped.' }],
          integrations: { allowed: false, reason: 'The payment sync is paused for the run.' },
          failure_tolerance: { rows: 0, reason: 'Every gift must be written, or the run stops.' },
        } } };
    },
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
    // s28: a pretend scenario's kind is 'pretend' (still a simulation: RunShell draws the strip).
    kind: scenario.kind ?? 'sim',
    name,
    load: async () => ({ link_id: linkId, request: built.request, sample: built.sample ?? null, run: built.run ?? null, outcome: built.outcome ?? null }),
    checkDesktop: async () => {
      return simulatedState(answers.length > 1 ? answers.shift() : answers[0]);
    },
    // A write's correction Approve is its reruns, as the database records it (251: as_rerun); a pre-check's isn't.
    approve: async () => ({
      sent: true, link_id: linkId,
      ...(built.request?.page === 'correction' && built.request?.base_page !== 'precheck' ? { as_rerun: true } : {}),
    }),
    // Checks expired: the rerun click is its own approval (spec part 5, rerun mode).
    rerun: async () => ({ sent: true, rerun: true, link_id: linkId }),
    // Not started: resend the same run, same link id (spec 4.5).
    resend: async () => ({ sent: true, resent: true, link_id: linkId }),
    cancel: async (reason) => ({ cancelled: true, reason: String(reason ?? '').trim() }),
  };
}

// ---------------------------------------------------------------------------
// A6: code reviews (screen f), on invented Apex
// ---------------------------------------------------------------------------

const COMMIT = '4f9c2ab71d03e5c8';
const NEWER = '8b1e07d4c2a95f36';
const RERUN_CLS = `public with sharing class GiftCampaignRerun implements Database.Batchable<SObject> {
    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator(
            'SELECT Id FROM Gift__c WHERE Source__c = \\'Spring import\\' AND Campaign__c = null'
        );
    }

    public void execute(Database.BatchableContext bc, List<Gift__c> scope) {
        GiftTriggerHandler.assignCampaigns(scope);
        update scope;
    }

    public void finish(Database.BatchableContext bc) {}
}
`;
const RERUN_TEST = `@IsTest
private class GiftCampaignRerunTest {
    @IsTest
    static void assignsTheSpringCampaign() {
        insert new Campaign__c(Name = 'Spring 2026 Appeal');
        insert new Gift__c(Source__c = 'Spring import', Amount__c = 50);
        Test.startTest();
        Database.executeBatch(new GiftCampaignRerun());
        Test.stopTest();
        System.assertNotEquals(null, [SELECT Campaign__c FROM Gift__c LIMIT 1].Campaign__c);
    }
}
`;
const HANDLER_OLD = `public with sharing class GiftTriggerHandler {
    public static void beforeInsert(List<Gift__c> gifts) {
        assignCampaigns(gifts);
    }

    public static void assignCampaigns(List<Gift__c> gifts) {
        Map<String, Id> bySource = campaignsBySource();
        for (Gift__c g : gifts) {
            g.Campaign__c = bySource.get(g.Source__c);
        }
    }

    static Map<String, Id> campaignsBySource() {
        Map<String, Id> out = new Map<String, Id>();
        for (Campaign__c c : [SELECT Id, Source__c FROM Campaign__c]) {
            out.put(c.Source__c, c.Id);
        }
        return out;
    }

    public static void afterInsert(List<Gift__c> gifts) {
        RollupService.recalculate(gifts);
    }
}
`;
const HANDLER_NEW = `public with sharing class GiftTriggerHandler {
    public static void beforeInsert(List<Gift__c> gifts) {
        assignCampaigns(gifts);
    }

    public static void assignCampaigns(List<Gift__c> gifts) {
        Map<String, Id> bySource = campaignsBySource();
        for (Gift__c g : gifts) {
            if (g.Campaign__c == null && g.Source__c != null) {
                g.Campaign__c = bySource.get(g.Source__c.trim().toLowerCase());
            }
        }
    }

    static Map<String, Id> campaignsBySource() {
        Map<String, Id> out = new Map<String, Id>();
        for (Campaign__c c : [SELECT Id, Source__c FROM Campaign__c WHERE IsActive__c = true]) {
            out.put(c.Source__c.trim().toLowerCase(), c.Id);
        }
        return out;
    }

    public static void afterInsert(List<Gift__c> gifts) {
        RollupService.recalculate(gifts);
    }
}
`;

const reviewBase = (now, over) => ({
  simulation: true,
  project_code: CODE,
  repo: 'example-charity-sf',
  base_commit: 'c01d2e3f4a5b6c7d',
  commit: COMMIT,
  rehearsed_at: iso(now - 2 * HOUR),
  ...over,
});

const codeFix = (now) => reviewBase(now, {
  headline: `CODE REVIEW ${CODE}: GiftTriggerHandler, 2 CHANGES FOR P1a AND P3`,
  files: [{ path: 'force-app/main/default/classes/GiftTriggerHandler.cls', status: 'modified', old_text: HANDLER_OLD, new_text: HANDLER_NEW, problem_labels: ['P1a', 'P3'] }],
  findings: {
    fixed_by_cli: [{ id: 'f1', text: 'The source match was case-sensitive; it now trims and lowercases both sides.' }],
    for_you: [
      { id: 'y1', text: 'Inactive campaigns are now skipped. Confirm the client never assigns gifts to an inactive campaign.', file: 'force-app/main/default/classes/GiftTriggerHandler.cls', lines: '17' },
      { id: 'y2', text: "A gift that already has a campaign is left alone. That's the intended fix for P3, but it changes today's behaviour." },
    ],
  },
  notes: [
    { file: 'force-app/main/default/classes/GiftTriggerHandler.cls', start_line: 9, end_line: 11, problem_label: 'P3',
      text: "Before, every gift's campaign was overwritten on insert, even when the import had already set one (P3). The guard keeps an existing campaign and skips gifts with no source, and the lookup now uses the same trimmed, lowercased key as the map below." },
    { file: 'force-app/main/default/classes/GiftTriggerHandler.cls', start_line: 17, end_line: 18, problem_label: 'P1a',
      text: "The Spring import wrote 'spring import ' with a trailing space, so the case-sensitive match found no campaign and the gifts were saved empty (P1a). Keys are now trimmed and lowercased, and only active campaigns are matched." },
  ],
});

/** The code review scenarios, each built against `now`. */
export const REVIEW_SCENARIOS = {
  'review-logic-rerun': {
    title: 'Code review: a logic re-run with two new files',
    build: (now) => reviewBase(now, {
      headline: `CODE REVIEW ${CODE}: GiftCampaignRerun AND ITS TEST, 2 NEW FILES FOR P1a`,
      files: [
        { path: 'force-app/main/default/classes/GiftCampaignRerun.cls', status: 'new', new_text: RERUN_CLS, problem_labels: ['P1a'] },
        { path: 'force-app/main/default/classes/GiftCampaignRerunTest.cls', status: 'new', new_text: RERUN_TEST, problem_labels: ['P1a'] },
      ],
      findings: {
        fixed_by_cli: [{ id: 'f1', text: 'The batch first queried every gift; it now selects only Spring imports with no campaign.' }],
        for_you: [{ id: 'y1', text: 'The batch reuses GiftTriggerHandler.assignCampaigns, so it follows the same matching rules as new gifts.' }],
      },
      notes: [
        { file: 'force-app/main/default/classes/GiftCampaignRerun.cls', start_line: 1, end_line: 1, problem_label: 'P1a', text: 'A one-off batch that re-runs the campaign assignment for the gifts the Spring import left empty.' },
        { file: 'force-app/main/default/classes/GiftCampaignRerunTest.cls', start_line: 2, end_line: 2, problem_label: 'P1a', text: 'Proves one Spring import gift gets a campaign; deleted with the batch after the run.' },
      ],
    }),
  },
  'review-code-fix': { title: 'Code review: one class changed in two places, for P1a and P3', build: codeFix },
  'review-superseded': {
    title: 'Code review superseded by a newer commit',
    build: (now) => ({ ...codeFix(now), superseded_by: NEWER }),
  },
  'review-all-acknowledged': {
    title: 'Code review with every finding already acknowledged',
    build: (now) => ({ ...codeFix(now), acknowledged: { y1: { note: 'Checked with the client: inactive campaigns never take gifts.' }, y2: { note: '' } } }),
  },
};

export const reviewScenarioNames = () => Object.keys(REVIEW_SCENARIOS);

/** The simulated source for one code review; like simSource, nothing leaves the browser. */
export function reviewSimSource(name, { now = Date.now(), desktop } = {}) {
  const scenario = REVIEW_SCENARIOS[name];
  if (!scenario) return null;
  const review = scenario.build(now);
  const answers = [...(desktop ?? ['running'])];
  const linkId = `sim-${name}`.slice(0, 44);
  return {
    kind: 'sim',
    name,
    load: async () => ({ link_id: linkId, review }),
    checkDesktop: async () => simulatedState(answers.length > 1 ? answers.shift() : answers[0]),
    reviewed: async (acks) => ({ done: 'reviewed', acks }),
    // The ticks and notes come with every answer, so the real source keeps them on the review (B2).
    question: async (text, acks) => ({ asked: true, text: String(text ?? '').trim(), acks }),
    changes: async (text, acks) => ({ done: 'changes', text: String(text ?? '').trim(), acks }),
  };
}
