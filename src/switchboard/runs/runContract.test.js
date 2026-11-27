import { createElement as h } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  afterApproveLines, approveLabel, bannerLines, clientOrgLine, checkLine, checksExpired, codeReviewProblems, countSentence, EDIT_RERUNS, GROUPS, groupedSteps,
  LINE_TEXT_MAX, lineText, requestProblems, reviewChangesLine, reviewQuestionLine, reviewReviewedLine, runCancelledLine, runLine,
  rerunSteps, runRerunsLine, runResentLine, selectedByText, STEPS, statusFromEvidence, undoClosedReason, undoLine, validUntil, whatChanges,
  WRITE_CHECKS, outcomeView, filterQueryProblem, CHECK_JOBS, checkOutcomeView, checkResultProblem,
} from './runContract';
import { BUTTON, RunShell, SECOND_BUTTON, localTime } from './look';

describe('outcomeView (s17): only the named parts, a missing or malformed part left out', () => {
  test('nothing to show: null', () => {
    for (const o of [null, undefined, 'done', [1], {}, { raw: 1 }, { changed: -1 }, { changed: 1.5, rows: 'x' }, { stopped: {} }]) {
      expect(outcomeView(o)).toBeNull();
    }
  });
  test('the changed count, rows with knock-on last, and the stop', () => {
    const v = outcomeView({
      changed: 3, extra: 'never shown',
      rows: [{ label: 'K', before: 0, goal: 1, after: 1, knock_on: true }, { label: 'A', before: 3, goal: 0, after: 0 }, { before: 1 }, null,
        { label: 'B', before: { x: 1 }, goal: 'none', after: null }],
      stopped: { already_changed: 2, saved_on_pc: 'backup.csv' },
    });
    expect(v).toEqual({
      changed: 3,
      rows: [{ label: 'A', before: 3, goal: 0, after: 0, knock_on: false }, { label: 'B', before: null, goal: 'none', after: null, knock_on: false },
        { label: 'K', before: 0, goal: 1, after: 1, knock_on: true }],
      stopped: { already_changed: 2, saved_on_pc: ['backup.csv'], next: null, by_step: null },
      skipped: [],
    });
  });
  test('a stop with only saved files, or only a count', () => {
    expect(outcomeView({ stopped: { saved_on_pc: ['a.csv', 7, ''] } }).stopped).toEqual({ already_changed: null, saved_on_pc: ['a.csv'], next: null, by_step: null });
    expect(outcomeView({ stopped: { already_changed: 0 } }).stopped).toEqual({ already_changed: 0, saved_on_pc: [], next: null, by_step: null });
  });
  test('s32 (item d): stopped.next, stopped.by_step and skipped; a malformed part is left out, never guessed', () => {
    const v = outcomeView({ stopped: { next: ' Open the check page. ', by_step: { step: 'Write', object: 'Gift__c', extra: 'x' } },
      skipped: [{ kind: 'locked', count: 2 }, { kind: 'edited', count: -1 }, { kind: '', count: 1 }, { kind: 'x'.repeat(81), count: 1 }, 'locked', { count: 3 }] });
    expect(v.stopped).toEqual({ already_changed: null, saved_on_pc: [], next: 'Open the check page.', by_step: { step: 'Write', object: 'Gift__c' } });
    expect(v.skipped).toEqual([{ kind: 'locked', count: 2 }]);
    // A stop with only next (it used to need already_changed or saved_on_pc), and skipped alone.
    expect(outcomeView({ stopped: { next: 'Run the undo.' } }).stopped.next).toBe('Run the undo.');
    expect(outcomeView({ skipped: [{ kind: 'locked', count: 0 }] })).toEqual({ changed: null, rows: [], stopped: null, skipped: [{ kind: 'locked', count: 0 }] });
    // Refused: a next over 200 characters or on two lines, a by_step missing a part or too long.
    for (const s of [{ next: 'x'.repeat(201) }, { next: 'a\nb' }, { next: 5 }, { by_step: { step: 'Write' } }, { by_step: { step: 'Write', object: 'y'.repeat(81) } }, { by_step: 'Write' }]) {
      expect(outcomeView({ stopped: s })).toBeNull();
    }
  });
});

describe('s32 (item e): a check result', () => {
  const ok = { job: 'Completed', at_goal: 45, at_backup: 0, neither: 0 };
  test('checkResultProblem takes each job state and none, counts 0 to 999999999', () => {
    for (const job of CHECK_JOBS) expect(checkResultProblem({ ...ok, job })).toBeNull();
    expect(CHECK_JOBS).toEqual(['Queued', 'Preparing', 'Processing', 'Holding', 'InProgress', 'Completed', 'Failed', 'Aborted', 'none']);
    expect(checkResultProblem({ ...ok, at_goal: 999999999 })).toBeNull();
  });
  test('checkResultProblem refuses every other shape', () => {
    for (const c of [null, [], 'x', {}, { ...ok, extra: 1 }, { job: 'Completed', at_goal: 1, at_backup: 0 }]) {
      expect(checkResultProblem(c)).toBe('check must be {job, at_goal, at_backup, neither}, nothing else.');
    }
    for (const job of ['completed', 'Running', '', 5, null, 'None']) expect(checkResultProblem({ ...ok, job })).toMatch(/^check\.job must be one of Queued/);
    for (const n of [-1, 1.5, '5', null, 1000000000, NaN]) expect(checkResultProblem({ ...ok, neither: n })).toMatch(/^check\.at_goal, at_backup and neither must each be a whole number from 0 to 999,999,999\.$/);
  });
  test('checkOutcomeView draws only an exact {check}', () => {
    expect(checkOutcomeView({ check: ok })).toEqual(ok);
    for (const o of [null, {}, { check: { ...ok, job: 'Running' } }, { check: ok, changed: 1 }, { changed: 45 }]) expect(checkOutcomeView(o)).toBeNull();
  });
});

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A sample pre-check request, invented values. */
const precheck = (over = {}) => ({
  page: 'precheck', project_code: 'demo_gifts-x1y', run_tag: 'demo_gifts-x1y-s4-ab12', client: 'Demo Client',
  orgs: [{ alias: 'example-prod', org_type: 'production', role: 'target' }, { alias: 'example-dev1', org_type: 'sandbox', role: 'rehearsal' }],
  problem: { label: 'P1a', sentence: 'Gifts imported on 3 November carry the wrong campaign.' },
  side_effects: 'The gift rollups on each donor recalculate on save.',
  operation: { kind: 'update', object: 'Gift', field: 'Campaign__c', value: 'Spring 2026' },
  selected_by: { kind: 'ids', text: '45 Ids listed by diagnosis' },
  // s28 (O17): an Id list's Ids are the query labelled "records".
  details: { queries: [{ label: 'records', soql: "SELECT Id FROM Gift WHERE Id IN ('a0B000000000001AAA')" }] },
  counts: { expected: 45, total: 45 },
  steps: ['count_listed', 'login_can_change', 'list_automation', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test']
    .map((code) => ({ code })),
  ...over,
});
const dataop = (over = {}) => precheck({
  page: 'dataop', orgs: [{ alias: 'example-prod', org_type: 'production', role: 'target' }],
  steps: ['still_match_backup', 'login_can_write', 'automation_unchanged', 'type_count', 'write', 'read_back', 'save_results'].map((code) => ({ code })),
  undo: { level: 'standard', mechanics: 'Sets the campaign back from the backup.' },
  ...over,
});

describe('requestProblems', () => {
  test('a whole request has none', () => {
    expect(requestProblems(precheck())).toEqual([]);
    expect(requestProblems(dataop())).toEqual([]);
  });
  test('missing side_effects is refused, saying to add it and that no link was issued', () => {
    const p = requestProblems(precheck({ side_effects: '  ' }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^Add side_effects: the side effects in diagnosis's words, then queue again\. No link was issued\.$/);
  });
  test('missing problem label or sentence is refused with what to add', () => {
    expect(requestProblems(precheck({ problem: { label: 'P1' } }))[0]).toMatch(/^Add the problem: its label \(P1, P1a\)/);
    expect(requestProblems(precheck({ problem: undefined }))).toHaveLength(1);
  });
  test('a simulation mark is refused only from the real source', () => {
    expect(requestProblems(precheck({ simulation: true }))).toEqual([]);
    expect(requestProblems(precheck({ simulation: true }), { real: true })[0]).toMatch(/simulation/);
  });
  test('unknown step codes and steps from another page are refused', () => {
    expect(requestProblems(precheck({ steps: [{ code: 'nope' }] }))[0]).toMatch(/not a known step code/);
    expect(requestProblems(precheck({ steps: [{ code: 'write' }] }))[0]).toMatch(/doesn't belong on a precheck page/);
  });
  test('a pre-check carries no sample', () => {
    expect(requestProblems(precheck({ sample: { fields: [] } }))[0]).toMatch(/pre-check reads it/);
  });
  test('a correction of the object or operation needs a new request', () => {
    const changed = { edit_kind: 'operation', reason: 'Diagnosis now says delete.', items: [{ what: 'operation', old: 'update', new: 'delete' }] };
    expect(requestProblems(precheck({ page: 'correction', changed }))).toEqual([expect.stringMatching(/needs a new request through diagnosis/)]);
    expect(requestProblems(precheck({ page: 'correction' }))).toEqual(['Add changed: a correction page shows what changed.']);
  });
  test('a wording edit has no page, and a correction runs only what its edit touches', () => {
    const changed = (edit_kind) => ({ edit_kind, reason: 'Diagnosis corrected it.', items: [{ what: 'x', old: 'a', new: 'b' }] });
    expect(requestProblems(precheck({ page: 'correction', changed: changed('wording') }))[0]).toMatch(/runs nothing, so it has no page/);
    const field = precheck({ page: 'correction', changed: changed('field'), steps: rerunSteps('field').map((code) => ({ code })) });
    expect(requestProblems(field)).toEqual([]);
    expect(rerunSteps('field')).toEqual(['create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test', 'login_can_change', 'save_backup']);
    expect(requestProblems({ ...field, steps: [{ code: 'count_listed' }] })).toEqual(["Fix steps[0]: a field edit doesn't run count_listed again."]);
  });
  test("a step's org is fixed by its code", () => {
    expect(requestProblems(precheck({ steps: [{ code: 'create_test', org: 'production' }] })))
      .toEqual(['Fix steps[0]: create_test always runs on sandbox; leave org out.']);
  });
  test('a multi-object run: each write_step matches operation.steps', () => {
    const op = { kind: 'multi', steps: [{ object: 'Allocation', kind: 'delete', count: 12 }, { object: 'Gift', kind: 'delete', count: 45 }] };
    const ws = op.steps.map((s) => ({ code: 'write_step', ...s }));
    expect(requestProblems(dataop({ operation: op, steps: ws, counts: { total: 57 } }))).toEqual([]);
    expect(requestProblems(dataop({ operation: op, steps: [ws[0]], counts: { total: 57 } }))).toEqual([expect.stringMatching(/must match operation.steps/)]);
  });
  test('each operation names what it needs', () => {
    expect(requestProblems(dataop({ operation: { kind: 'insert', object: 'Gift' } }))).toEqual(['Add operation.file: the file of rows on the PC.']);
    expect(requestProblems(dataop({ operation: { kind: 'upsert', object: 'Gift' }, counts: { total: 45, update: 30, create: 15 } }))).toEqual(['Add operation.external_id.']);
  });
});

describe('requestProblems, s28: pretend, O17, O2 and O5', () => {
  test('pretend: {scenario} with simulation is fine; every other shape, or no simulation, is refused', () => {
    expect(requestProblems(precheck({ simulation: true, pretend: { scenario: 'count_ok' } }))).toEqual([]);
    expect(requestProblems(precheck({ simulation: true, pretend: { scenario: 'a'.repeat(40) } }))).toEqual([]);
    for (const p of [true, null, 'count_ok', [], {}, { scenario: 5 }, { scenario: '' }, { scenario: 'Count_OK' }, { scenario: 'a/b' },
      { scenario: 'a'.repeat(41) }, { scenario: 'ok', extra: 1 }]) {
      expect(requestProblems(precheck({ simulation: true, pretend: p }))).toEqual([expect.stringMatching(/^Fix pretend: \{"scenario": "<name>"\}/)]);
    }
    expect(requestProblems(precheck({ pretend: { scenario: 'ok' } }))).toEqual([expect.stringMatching(/^Fix pretend: it needs simulation true/)]);
    expect(requestProblems(precheck({ simulation: false, pretend: { scenario: 'ok' } }))).toEqual([expect.stringMatching(/needs simulation true/)]);
  });
  test('O17: an Id list needs exactly one details.queries entry labelled records, and no sandbox records', () => {
    const msg = (n) => [`Add details.queries: exactly one entry labelled "records", the query that lists the Ids (it has ${n}).`];
    expect(requestProblems(precheck({ details: undefined }))).toEqual(msg(0));
    expect(requestProblems(precheck({ details: { queries: [{ label: 'The listed records', soql: 's' }] } }))).toEqual(msg(0));
    expect(requestProblems(precheck({ details: { queries: [{ label: 'records', soql: 'a' }, { label: 'records', soql: 'b' }] } }))).toEqual(msg(2));
    expect(requestProblems(precheck({ details: { queries: [{ label: 'records', soql: 'a' }, { label: 'sandbox records', soql: 'b' }] } })))
      .toEqual(['Leave out details.queries "sandbox records": only a filter has a sandbox query.']);
  });
  describe('s30 (16.2): a filter request', () => {
    const PLAIN = "SELECT Id FROM Gift__c WHERE CreatedDate < 2026-11-20T00:00:00Z AND Status__c = 'Open'";
    const filter = (sel, queries) => precheck({ selected_by: { kind: 'filter', text: 'f', ...sel }, details: { queries }, steps: [{ code: 'count_filter' }] });
    const rec = (soql) => ({ label: 'records', soql });
    test('needs one records query, and one sandbox records query exactly when sandbox_text is set', () => {
      expect(requestProblems(filter({}, [rec(PLAIN)]))).toEqual([]);
      expect(requestProblems(filter({ sandbox_text: 's' }, [rec(PLAIN), { label: 'sandbox records', soql: PLAIN }]))).toEqual([]);
      expect(requestProblems(filter({}, []))).toEqual(['Add details.queries: exactly one entry labelled "records", the filter\'s query on production (it has 0).']);
      expect(requestProblems(filter({}, [rec(PLAIN), rec(PLAIN)]))).toEqual(['Add details.queries: exactly one entry labelled "records", the filter\'s query on production (it has 2).']);
      expect(requestProblems(filter({ sandbox_text: 's' }, [rec(PLAIN)])))
        .toEqual(['Add details.queries: exactly one entry labelled "sandbox records", the filter\'s query on the sandbox, since selected_by.sandbox_text is set (it has 0).']);
      expect(requestProblems(filter({}, [rec(PLAIN), { label: 'sandbox records', soql: PLAIN }])))
        .toEqual(['Leave out details.queries "sandbox records", or add selected_by.sandbox_text: a sandbox query goes with the sandbox\'s filter in words.']);
      expect(requestProblems(filter({ sandbox_text: ' ' }, [rec(PLAIN)]))).toEqual(["Fix selected_by.sandbox_text: the sandbox's filter in words, or leave it out."]);
    });
    test('the AND rule checks the SOQL WHERE clause, never selected_by.text', () => {
      expect(requestProblems(filter({ text: 'created in the last 30 days, or today' }, [rec(PLAIN)]))).toEqual([]);
      for (const soql of [
        PLAIN,
        "SELECT Id, Campaign__c FROM Gift__c\nWHERE Source__c = 'Spring import'\n  AND CreatedDate < 2026-11-20T00:00:00Z\n  AND Campaign__c = null",
        "SELECT Id FROM Gift__c WHERE Note__c = 'this OR that AND (more)' and Amount__c >= -10.5 ORDER BY Id LIMIT 200",
        'SELECT Id FROM Contact WHERE Account.Name != null AND Last_Name__c <> \'x\' AND Closed__c = TRUE AND Day__c <= 2026-11-01',
        "select id from Gift__c where CreatedDate > 2026-11-01T00:00:00.000+00:00",
      ]) expect(filterQueryProblem('records', soql)).toBeNull();
    });
    test('it refuses OR, NOT, IN, LIKE, INCLUDES, EXCLUDES, brackets and relative dates, naming the label and the fix', () => {
      const RULE = 'only comparisons <field> <op> <value> joined by AND (op = != < <= > >=; value a quoted string, a number, true, false, null, or an ISO date or datetime)';
      const w = (clause) => `SELECT Id FROM Gift__c WHERE ${clause}`;
      expect(filterQueryProblem('records', w("A__c = 1 OR B__c = 2"))).toBe(`Fix details.queries "records": ${RULE}; it has OR.`);
      expect(filterQueryProblem('records', w("NOT A__c = 1"))).toBe(`Fix details.queries "records": ${RULE}; it has NOT.`);
      expect(filterQueryProblem('records', w("Id in ('a', 'b')"))).toBe(`Fix details.queries "records": ${RULE}; it has IN.`);
      expect(filterQueryProblem('sandbox records', w("Name LIKE 'A%'"))).toBe(`Fix details.queries "sandbox records": ${RULE}; it has LIKE.`);
      expect(filterQueryProblem('records', w("Tags__c includes ('x')"))).toMatch(/it has INCLUDES\.$/);
      expect(filterQueryProblem('records', w("Tags__c EXCLUDES ('x')"))).toMatch(/it has EXCLUDES\.$/);
      expect(filterQueryProblem('records', w("(A__c = 1 AND B__c = 2)"))).toBe(`Fix details.queries "records": ${RULE}; it has brackets.`);
      for (const rel of ['LAST_N_DAYS:30', 'TODAY', 'YESTERDAY', 'THIS_MONTH', 'LAST_WEEK', 'NEXT_N_DAYS:5', 'LAST_90_DAYS', 'N_DAYS_AGO:3', 'THIS_FISCAL_YEAR']) {
        expect(filterQueryProblem('records', w(`CreatedDate = ${rel} AND A__c = 1`)))
          .toBe(`Fix details.queries "records": no relative date such as ${rel}: a moving filter changes the count between the pre-check and the write; use a fixed date or datetime.`);
      }
      for (const soql of [w('A__c'), w('A__c = '), w('A__c = 1 AND'), w('A__c == 1'), w('A__c = 1 B__c = 2'), w('A__c = Foo'), w('A__c = 1; DELETE'),
        w('A__c = 1, B__c = 2'), 'SELECT Id FROM Gift__c']) {
        expect(filterQueryProblem('records', soql)).toMatch(/^Fix details\.queries "records": (a WHERE clause of )?only comparisons .*\)\.$/);
      }
      expect(filterQueryProblem('records', w("A__c = 'open"))).toBe(`Fix details.queries "records": ${RULE}; it has an unclosed quote.`);
      // s30 cold review: what follows the clause's end is checked too.
      expect(filterQueryProblem('records', w('A__c = 1 LIMIT 5 OR B__c = 2'))).toBe(`Fix details.queries "records": ${RULE}; it has OR.`);
      expect(filterQueryProblem('records', w('A__c = 1 WITH DATA CATEGORY Geo__c AT usa__c'))).toBe(`Fix details.queries "records": ${RULE}; it has WITH DATA.`);
      expect(filterQueryProblem('records', w('A__c = 1 WITH SECURITY_ENFORCED ORDER BY Id LIMIT 10'))).toBeNull();
      expect(filterQueryProblem('records', undefined)).toBe('Fix details.queries "records": its soql, the query, as text.');
      expect(requestProblems(filter({}, [rec(w("A__c = 1 OR B__c = 2"))]))).toEqual([`Fix details.queries "records": ${RULE}; it has OR.`]);
    });
  });
  test('s30 (O23): interrupted.request_id, a lower-case uuid, on a check page only', () => {
    const check = (interrupted) => dataop({ page: 'check', steps: [], interrupted });
    const base = requestProblems(check({ run_tag: 'x-s1-ab12' }));
    expect(requestProblems(check({ run_tag: 'x-s1-ab12', request_id: ID }))).toEqual(base);
    for (const bad of [ID.toUpperCase(), 'not-a-uuid', 5, null, '']) {
      const got = requestProblems(check({ run_tag: 'x-s1-ab12', request_id: bad }));
      expect(got.filter((p) => !base.includes(p))).toEqual(["Fix interrupted.request_id: the interrupted data operation request's id, a lower-case uuid."]);
      expect(got.length).toBe(base.length + 1);
    }
    expect(requestProblems(dataop({ interrupted: { run_tag: 'x', request_id: ID } })))
      .toEqual(['Leave interrupted.request_id out: only a check names the data operation that was interrupted.']);
  });
  test('O2: a whole allows is fine beside the sentences; a malformed one is refused, naming its key', () => {
    const allows = { mode: 'moving', kinds: [], integrations: { allowed: false, reason: 'r' }, failure_tolerance: { rows: 0, reason: 'r' } };
    expect(requestProblems(dataop({ allows, diagnosis_allows: ['A sentence.'] }))).toEqual([]);
    expect(requestProblems(dataop({ allows: { ...allows, mode: 'x' } }))).toEqual(['Fix allows.mode: frozen or moving.']);
  });
  test('O5: undo_of.request_id, a lower-case uuid, on an undo only; undo_of without it as before', () => {
    const undo = (undoOf) => dataop({ page: 'undo', counts: { expected: 45, undo_up_to: 45 }, steps: [{ code: 'skip_edited' }, { code: 'write' }], undo_of: undoOf });
    expect(requestProblems(undo({ run_tag: 'x-s1-ab12' }))).toEqual([]);
    expect(requestProblems(undo({ run_tag: 'x-s1-ab12', request_id: ID }))).toEqual([]);
    for (const bad of [ID.toUpperCase(), 'nope', 42, null]) {
      expect(requestProblems(undo({ run_tag: 'x-s1-ab12', request_id: bad }))).toEqual(["Fix undo_of.request_id: the data operation request's id, a lower-case uuid."]);
    }
    expect(requestProblems(dataop({ undo_of: { run_tag: 'x', request_id: ID } })))
      .toEqual(['Leave undo_of.request_id out: only an undo names the data operation it undoes.']);
  });
  test('the line builders prefix SIMULATION on a real link id when asked (a pretend page), and only then', () => {
    expect(runLine(ID, true)).toBe(`SIMULATION run ${ID}`);
    expect(runResentLine(ID, true)).toBe(`SIMULATION run ${ID} resent`);
    expect(runRerunsLine(ID, true)).toBe(`SIMULATION run ${ID} reruns`);
    expect(runCancelledLine(ID, 'no', true)).toBe(`SIMULATION run ${ID} cancelled: no`);
    expect(runLine(ID)).toBe(`run ${ID}`);
    expect(runLine(ID, false)).toBe(`run ${ID}`);
    expect(runLine('sim-x')).toBe('SIMULATION run sim-x');
  });
});

describe('built text', () => {
  test('What changes is built from the operation', () => {
    expect(whatChanges(precheck())).toBe('Sets Campaign__c to "Spring 2026" on 45 records of Gift.');
    expect(whatChanges(dataop({ operation: { kind: 'upsert', object: 'Gift', external_id: 'Legacy_Id__c' }, counts: { update: 30, create: 15, total: 45 } })))
      .toBe('Updates 30 and creates 15 records of Gift, matched by Legacy_Id__c.');
    expect(whatChanges(dataop({ operation: { kind: 'delete', object: 'Gift' } }))).toBe('Deletes 45 records of Gift to the recycle bin.');
    expect(whatChanges(dataop({ operation: { kind: 'multi', steps: [{ object: 'Gift' }, { object: 'Allocation' }] }, counts: { total: 90 } })))
      .toBe('Runs 2 steps across Gift and Allocation: 90 records in all.');
  });
  test('the count sentence is only on pages that write', () => {
    expect(countSentence(precheck())).toBeNull();
    expect(countSentence(dataop())).toBe('This changes 45 live records of Gift in example-prod.');
    expect(countSentence(dataop({ page: 'undo', counts: { expected: 45, undo_up_to: 44 } }))).toBe('This changes up to 44 live records of Gift in example-prod.');
  });
  test('banner second lines', () => {
    expect(bannerLines(precheck())).toEqual({ production: 'Read only, nothing changes.', sandbox: expect.stringMatching(/^TEST records/) });
    expect(bannerLines(dataop())).toEqual({ production: 'This changes 45 live records.', sandbox: null });
    expect(bannerLines(dataop({ orgs: [{ alias: 'example-dev1', org_type: 'sandbox', role: 'target' }] })))
      .toEqual({ production: null, sandbox: 'This changes 45 records.' });
  });
  test('approve labels', () => {
    expect(approveLabel(precheck())).toBe('Approve this run on PRODUCTION and SANDBOX');
    expect(approveLabel(dataop())).toBe('Approve this run on PRODUCTION');
    expect(approveLabel(dataop({ orgs: [{ alias: 'd', org_type: 'sandbox', role: 'target' }] }))).toBe('Approve this run on SANDBOX');
    expect(approveLabel(dataop({ page: 'undo' }))).toBe('Approve this UNDO on PRODUCTION');
  });
  test('steps are grouped under the agreed headers, in order, as statements', () => {
    const g = groupedSteps(precheck());
    expect(g.map((x) => x.group)).toEqual(['Production pre-check', 'Sandbox rehearsal']);
    expect(g[0].steps[0]).toEqual({ code: 'count_listed', group: 'Production pre-check', org: 'production', text: 'Count how many of the 45 records listed still exist.' });
    expect(g[1].steps.every((s) => s.org === 'sandbox')).toBe(true);
    expect(groupedSteps(dataop()).map((x) => x.group)).toEqual(GROUPS.dataop);
    for (const def of Object.values(STEPS)) expect(def.text({}, precheck())).not.toMatch(/\?\s*$/);
  });
  test('a filter rehearsal uses 3 that match and 1 that does not', () => {
    const g = groupedSteps(precheck({ selected_by: { kind: 'filter', text: "Campaign__c = null" } }));
    expect(g[1].steps[0].text).toBe("Create 3 TEST records that match the filter and 1 that doesn't.");
  });
  test('a write step can pause before it', () => {
    const r = dataop({ operation: { kind: 'multi', steps: [] }, steps: [{ code: 'write_step', object: 'Allocation', kind: 'delete', count: 12, pause_before: true }] });
    expect(groupedSteps(r)[0].steps[0].text).toBe('Pause before this. Allocation: delete 12 records.');
    // A write step with another after it says a failed row stops before the next.
    const two = dataop({ operation: { kind: 'multi', steps: [] }, steps: [{ code: 'write_step', object: 'Allocation', kind: 'delete', count: 12 }, { code: 'write_step', object: 'Gift', kind: 'delete', count: 1 }] });
    expect(groupedSteps(two)[0].steps.map((s) => s.text)).toEqual(['Allocation: delete 12 records. A failed row stops the run before the next step.', 'Gift: delete 1 record.']);
  });
  test('the undo page writes up to N and types the count after skips', () => {
    const r = dataop({ page: 'undo', counts: { expected: 45, undo_up_to: 45 }, steps: [{ code: 'skip_edited' }, { code: 'type_count' }, { code: 'write' }] });
    const texts = groupedSteps(r).flatMap((x) => x.steps.map((s) => s.text));
    expect(texts).toEqual(['Skip any record edited since the run, and list who changed it and when.',
      'You type the exact count left after skips in the terminal; anything else stops with nothing changed.',
      'Put back up to 45 records from the backup.']);
  });
  test('the undo line, and an undo has no undo', () => {
    expect(undoLine(dataop({ undo: { level: 'standard', mechanics: 'Deletes them again.' } }))).toBe('Undo: standard. Deletes them again.');
    expect(undoLine(dataop({ undo: { level: 'standard', mechanics: 'Undeletes them.', deadline: '8 December 2026' } })))
      .toBe('Undo: standard. Undeletes them. Until 8 December 2026.');
    expect(undoLine(dataop({ page: 'undo' }))).toBe('Undo: none. An undo has no undo. A further change is a new request through diagnosis.');
    expect(undoLine(precheck())).toBeNull();
  });
  test('client and org line, and After you approve', () => {
    expect(clientOrgLine(precheck())).toBe('Demo Client · example-prod (production) · example-dev1 (sandbox)');
    const pre = afterApproveLines(precheck());
    expect(pre[0]).toMatch(/within 15 minutes.*Not started\. Nothing ran\./);
    expect(pre).toContain('Nothing in production changes.');
    expect(afterApproveLines(dataop())[1]).toMatch(/type the count, 45\. Anything else stops it with nothing changed\./);
  });
  test('the edit table', () => {
    expect(EDIT_RERUNS.field).toEqual(['rehearsal', 'login', 'backup', 'sample']);
    expect(EDIT_RERUNS.code).toEqual(['rehearsal', 'code_review']);
    expect(EDIT_RERUNS.wording).toEqual([]);
  });
});

describe('valid until', () => {
  const ev = [{ check: 'count', passed_at: '2026-11-20T10:00:00Z' }, { check: 'rehearsal', passed_at: '2026-11-20T09:00:00Z' }];
  test('24 hours from the oldest evidence still in use', () => {
    expect(validUntil(ev)).toBe('2026-11-21T09:00:00.000Z');
    expect(validUntil([{ ...ev[0] }, { ...ev[1], voided: true }])).toBe('2026-11-21T10:00:00.000Z');
  });
  test('no evidence: no expiry', () => {
    expect(validUntil([])).toBeNull();
    expect(checksExpired([])).toBe(false);
  });
  test('expired at the moment it is read', () => {
    expect(checksExpired(ev, Date.parse('2026-11-21T08:59:59Z'))).toBe(false);
    expect(checksExpired(ev, Date.parse('2026-11-21T09:00:00Z'))).toBe(true);
  });
});

describe('code review problems', () => {
  const cr = (over = {}) => ({
    commit: 'a1b2c3d4e5f6',
    files: [{ path: 'force-app/classes/GiftFix.cls', status: 'new', new_text: 'a\nb\nc', problem_labels: ['P1a'] }],
    findings: { fixed_by_cli: [{ id: 'f1', text: 'Removed a debug line.' }], for_you: [{ id: 'y1', text: 'Check the batch size.' }] },
    notes: [{ file: 'force-app/classes/GiftFix.cls', start_line: 1, end_line: 3, problem_label: 'P1a', text: 'New class for P1a.' }],
    ...over,
  });
  test('a whole review has none', () => expect(codeReviewProblems(cr())).toEqual([]));
  test('a note outside its file, duplicate finding ids, and a modified file without old text are refused', () => {
    expect(codeReviewProblems(cr({ notes: [{ file: 'force-app/classes/GiftFix.cls', start_line: 2, end_line: 9, problem_label: 'P1a', text: 'x' }] })))
      .toEqual([expect.stringMatching(/lines 2-9 aren't in/)]);
    expect(codeReviewProblems(cr({ findings: { fixed_by_cli: [{ id: 'f1', text: 'a' }], for_you: [{ id: 'f1', text: 'b' }] } })))
      .toEqual([expect.stringMatching(/an id no other finding has/)]);
    expect(codeReviewProblems(cr({ files: [{ path: 'x.cls', status: 'modified', new_text: 'a' }], notes: [] })))
      .toEqual([expect.stringMatching(/old_text/)]);
  });
});

describe('result lines', () => {
  test("today's shape", () => {
    expect(runLine(ID)).toBe(`run ${ID}`);
    expect(runCancelledLine(ID, '')).toBe(`run ${ID} cancelled`);
    expect(runCancelledLine(ID, 'wait for\nMonday')).toBe(`run ${ID} cancelled: wait for Monday`);
    expect(runResentLine(ID)).toBe(`run ${ID} resent`);
    expect(runRerunsLine(ID)).toBe(`run ${ID} reruns`);
    expect(runRerunsLine('sim-correction-field')).toBe('SIMULATION run sim-correction-field reruns');
    expect(checkLine(ID, { job: 'Aborted', at_goal: 30, at_backup: 15, neither: 0 }))
      .toBe(`check ${ID} done: job Aborted; 30 at goal, 15 at backup, 0 neither`);
    // s30: a pretend check run's line starts SIMULATION; a real one's is unchanged.
    expect(checkLine(ID, { job: 'Completed', at_goal: 45, at_backup: 0, neither: 0 }, true))
      .toBe(`SIMULATION check ${ID} done: job Completed; 45 at goal, 0 at backup, 0 neither`);
    expect(checkLine(ID, { job: 'Completed', at_goal: 45, at_backup: 0, neither: 0 }, false))
      .toBe(`check ${ID} done: job Completed; 45 at goal, 0 at backup, 0 neither`);
    expect(reviewReviewedLine(ID)).toBe(`review ${ID} reviewed`);
    expect(reviewQuestionLine(ID, 'Why 200?')).toBe(`review ${ID} question: Why 200?`);
    expect(reviewChangesLine(ID, 'Use the batch size from settings.')).toBe(`review ${ID} changes required: Use the batch size from settings.`);
  });
  test('text is capped at 200 characters, one line', () => {
    const long = 'x'.repeat(1000);
    // Cut text ends with "…", and stays within the cap.
    expect(reviewQuestionLine(ID, long)).toBe(`review ${ID} question: ${'x'.repeat(LINE_TEXT_MAX - 1)}…`);
    expect(lineText('y'.repeat(LINE_TEXT_MAX))).toBe('y'.repeat(LINE_TEXT_MAX));
    const cut = lineText('w '.repeat(150));
    expect(cut.length).toBeLessThanOrEqual(LINE_TEXT_MAX);
    expect(cut.endsWith('w…')).toBe(true);
  });
  test('a question or a change needs its text', () => {
    expect(() => reviewQuestionLine(ID, ' ')).toThrow();
    expect(() => reviewChangesLine(ID, '')).toThrow();
  });
  test('a simulation line says so, and anything else is refused', () => {
    expect(runLine('sim-precheck-1')).toBe('SIMULATION run sim-precheck-1');
    expect(() => runLine('nope')).toThrow();
  });
});

describe('RunShell (look.js)', () => {
  test('the SIMULATION strip comes from the source, and the red bar only with an Approve button', () => {
    const { rerender } = render(h(RunShell, { source: { kind: 'sim' }, approvable: false }, 'x'));
    expect(screen.getByTestId('run-simulation')).toHaveTextContent('Simulation');
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    rerender(h(RunShell, { source: { kind: 'real' }, approvable: true }, 'x'));
    expect(screen.queryByTestId('run-simulation')).toBeNull();
    expect(screen.getByTestId('run-approval-required')).toHaveTextContent('Approval required');
    expect(screen.queryByText('Approve')).toBeNull();
  });
  test('fails closed: no source, or an unknown kind, still shows the strip', () => {
    const { rerender } = render(h(RunShell, {}, 'x'));
    expect(screen.getByTestId('run-simulation')).toBeInTheDocument();
    rerender(h(RunShell, { source: { kind: 'fake' } }, 'x'));
    expect(screen.getByTestId('run-simulation')).toBeInTheDocument();
  });
  test('reuses the approve page look', () => {
    expect(BUTTON).toMatch(/bg-primary text-white/);
    expect(SECOND_BUTTON).toMatch(/border-border text-primary/);
    expect(typeof localTime).toBe('function');
  });
});

describe('A6: a note sits on the change it explains', () => {
  const review = (note) => ({
    commit: 'abc1234', files: [{ path: 'A.cls', status: 'modified', old_text: 'a\nb\nc\n', new_text: 'a\nB\nc\n', problem_labels: ['P1'] }],
    findings: { fixed_by_cli: [], for_you: [] }, notes: [{ file: 'A.cls', problem_label: 'P1', text: 'Why b changed.', ...note }],
  });
  test('on changed lines it passes; on unchanged lines it is refused', () => {
    expect(codeReviewProblems(review({ start_line: 2, end_line: 2 }))).toEqual([]);
    expect(codeReviewProblems(review({ start_line: 1, end_line: 2 })).join(' ')).toMatch(/aren't changed lines/);
  });
  test("a note's label must be one of its file's labels; a new file's note is one line", () => {
    expect(codeReviewProblems(review({ start_line: 2, end_line: 2, problem_label: 'P9' })).join(' ')).toMatch(/isn't one of A.cls's problem labels/);
    const fresh = { commit: 'abc1234', files: [{ path: 'N.cls', status: 'new', new_text: 'x\n', problem_labels: ['P1'] }], findings: { fixed_by_cli: [], for_you: [] },
      notes: [{ file: 'N.cls', start_line: 1, end_line: 1, problem_label: 'P1', text: 'one\ntwo' }] };
    expect(codeReviewProblems(fresh).join(' ')).toMatch(/a note on a new file is one line/);
  });
});

describe('A4: the undo page and several objects', () => {
  test('an undo page needs undo_of; a multi step needs an object and an operation', () => {
    expect(requestProblems(dataop({ page: 'undo' })).join(' ')).toMatch(/Add undo_of/);
    const op = { kind: 'multi', steps: [{ object: 'Account', kind: 'merge', count: 1 }] };
    expect(requestProblems(dataop({ operation: op, steps: [{ code: 'write_step', object: 'Account', kind: 'merge', count: 1 }] })).join(' '))
      .toMatch(/each needs an object and an operation/);
  });
  test('counts must add up, and each operation carries what its page shows', () => {
    const upsert = { kind: 'upsert', object: 'Gift__c', external_id: 'Ref__c' };
    expect(requestProblems(dataop({ operation: upsert, counts: { expected: 45, total: 45, update: 30, create: 10 } })).join(' ')).toMatch(/update and create must add up/);
    const op = { kind: 'multi', steps: [{ object: 'Account', kind: 'insert', count: 2 }] };
    expect(requestProblems(dataop({ operation: op, counts: { total: 3 }, steps: [{ code: 'write_step', object: 'Account', kind: 'insert', count: 2 }] })).join(' ')).toMatch(/steps' counts must add up/);
    expect(requestProblems(dataop({ operation: { kind: 'delete', object: 'Gift__c' } })).join(' ')).toMatch(/Add undo.deadline/);
    expect(requestProblems(dataop({ operation: { kind: 'undelete', object: 'Gift__c' } })).join(' ')).toMatch(/Add operation.days_left/);
    expect(requestProblems(dataop({ steps: [{ code: 'skip_edited' }] })).join(' ')).toMatch(/skip_edited is for the undo page only/);
    const del = { kind: 'delete', object: 'Gift__c' };
    expect(requestProblems(dataop({ page: 'undo', operation: del, undo_of: { run_tag: 'x-s1-ab12' } })).join(' ')).toMatch(/Add undo_of.deadline/);
    expect(requestProblems(dataop({ page: 'undo', undo_of: { run_tag: 'x-s1-ab12', deadline: '2026-12-01T00:00:00Z' } })).join(' ')).toMatch(/only a delete's undo has a deadline/);
  });
  test('the first "Before the write" step agrees with a count of 1', () => {
    const up = dataop({ operation: { kind: 'upsert', object: 'Gift__c', external_id: 'Ref__c' }, counts: { expected: 2, total: 2, update: 1, create: 1 } });
    expect(STEPS.still_match_backup.text({}, up)).toBe("Confirm the 1 record to update still matches the backup, and the 1 to create still doesn't exist.");
    const un = dataop({ operation: { kind: 'undelete', object: 'Gift__c', days_left: 3 }, counts: { expected: 1, total: 1 } });
    expect(STEPS.still_match_backup.text({}, un)).toBe('Confirm the 1 record is still in the recycle bin.');
  });
  test("a stopped run's undo selects only what it changed, built", () => {
    expect(selectedByText(dataop({ page: 'undo', undo_of: { run_tag: 'x', stopped: true, changed: 1 } }))).toBe('The 1 record the stopped run changed.');
  });
  test('a correction is one version up, and an update undo takes no deadline_reason', () => {
    expect(requestProblems({ ...precheck(), page: 'correction', version: 3, changed: { edit_kind: 'value', from_version: 1, reason: 'r', items: [{ what: 'v', old: 'a', new: 'b' }] } }).join(' ')).toMatch(/one version up/);
    expect(requestProblems(dataop({ page: 'undo', undo_of: { run_tag: 'x', deadline_reason: 'y' } })).join(' ')).toMatch(/only a delete's undo has a deadline/);
  });
  test('one record created reads "1 record"', () => {
    const r = dataop({ operation: { kind: 'upsert', object: 'Gift__c', external_id: 'Ref__c' }, counts: { expected: 31, total: 31, update: 30, create: 1 } });
    expect(whatChanges(r)).toBe('Updates 30 and creates 1 record of Gift__c, matched by Ref__c.');
  });
  test('an undo with no readable deadline is closed', () => {
    expect(undoClosedReason(dataop({ page: 'undo', operation: { kind: 'delete', object: 'Gift__c' }, undo_of: { run_tag: 'x' } }))).toMatch(/^No undo is offered/);
    // An update's undo has no deadline, so it never closes.
    expect(undoClosedReason(dataop({ page: 'undo', undo_of: { run_tag: 'x' } }))).toBeNull();
  });
  test('a mixed multi-object run groups its login check by what is done', () => {
    const text = STEPS.login_can_write.text({}, { operation: { kind: 'multi', steps: [
      { object: 'Account', label_plural: 'Accounts', kind: 'insert' }, { object: 'Contact', kind: 'update' }, { object: 'Lead', label_plural: 'Leads', kind: 'insert' },
    ] } });
    expect(text).toBe('Confirm the login can still create Accounts and Leads, and update Contact.');
  });
});

describe('"Before the write": the login check names what it checks', () => {
  const text = (operation) => STEPS.login_can_write.text({ code: 'login_can_write' }, { operation });
  test('an update names its field', () => {
    expect(text({ kind: 'update', object: 'Gift__c', field: 'Campaign__c' })).toBe('Confirm the login can still update the Campaign__c field.');
  });
  test('the other kinds name what they do', () => {
    expect(text({ kind: 'insert', object: 'Gift__c', object_label: 'Gift' })).toBe('Confirm the login can still create Gift records.');
    expect(text({ kind: 'delete', object: 'Gift__c' })).toBe('Confirm the login can still delete Gift__c records.');
    expect(text({ kind: 'undelete', object: 'Gift__c', object_label: 'Gift' })).toBe('Confirm the login can still restore Gift records.');
  });
});

describe('B4: the status from the evidence, never the chat', () => {
  const at = (h) => new Date(Date.parse('2026-11-24T12:00:00Z') - h * 3600000).toISOString();
  const all = (h) => WRITE_CHECKS.map((check) => ({ check, org: check === 'rehearsal' ? 'sandbox' : 'production', passed_at: at(h) }));

  test('a data operation: passed at the newest check in use when every write check is; waiting otherwise', () => {
    const evidence = [...all(3), { check: 'count', passed_at: at(1) }].map((e, i) => (i === 0 ? { ...e, voided: true } : e));
    const r = statusFromEvidence({ page: 'dataop', evidence, phases: [{ name: 'x', state: 'passed' }] });
    expect(r.phases).toEqual([{ name: 'Pre-check and rehearsal', state: 'passed', at: at(1) }, { name: 'Data operation', state: 'waiting' }]);
    const missing = statusFromEvidence({ page: 'dataop', evidence: all(3).filter((e) => e.check !== 'backup') });
    expect(missing.phases).toEqual([{ name: 'Pre-check and rehearsal', state: 'waiting' }, { name: 'Data operation', state: 'not_started' }]);
  });

  test('a pass after a rerun was asked for says so', () => {
    expect(statusFromEvidence({ page: 'dataop', evidence: all(1), rerun_at: at(2) }).phases[0].rerun).toBe(true);
    expect(statusFromEvidence({ page: 'dataop', evidence: all(3), rerun_at: at(2) }).phases[0].rerun).toBeUndefined();
  });

  test("a correction: waiting, and Still valid is every check in use with its own time, whatever the chat sent", () => {
    const evidence = [{ check: 'count', passed_at: at(2) }, { check: 'login', passed_at: at(2), voided: true }];
    const r = statusFromEvidence({ page: 'correction', evidence, changed: { edit_kind: 'field', still_valid: [{ check: 'backup', passed_at: at(0) }] } });
    expect(r.phases[0]).toEqual({ name: 'Pre-check and rehearsal', state: 'waiting' });
    expect(r.changed).toEqual({ edit_kind: 'field', still_valid: [{ check: 'count', passed_at: at(2) }] });
  });

  test('Still valid leaves out a check that has passed again since the correction', () => {
    const evidence = [{ check: 'count', passed_at: at(3) }, { check: 'backup', passed_at: at(0) }];
    const r = statusFromEvidence({ page: 'correction', corrected_at: at(1), evidence, changed: {} });
    expect(r.changed.still_valid).toEqual([{ check: 'count', passed_at: at(3) }]);
  });

  test('an undo or check page, and no request, are left as they are', () => {
    const undo = { page: 'undo', phases: [{ name: 'Undo', state: 'waiting' }] };
    expect(statusFromEvidence(undo)).toBe(undo);
    expect(statusFromEvidence(null)).toBeNull();
  });
});
