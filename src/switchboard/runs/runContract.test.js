import { createElement as h } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  afterApproveLines, approveLabel, bannerLines, clientOrgLine, checkLine, checksExpired, codeReviewProblems, countSentence, EDIT_RERUNS, GROUPS, groupedSteps,
  LINE_TEXT_MAX, requestProblems, reviewChangesLine, reviewQuestionLine, reviewReviewedLine, runCancelledLine, runLine,
  rerunSteps, runResentLine, selectedByText, STEPS, undoClosedReason, undoLine, validUntil, whatChanges,
} from './runContract';
import { BUTTON, RunShell, SECOND_BUTTON, localTime } from './look';

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
    expect(rerunSteps('field')).toEqual(['create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test', 'login_can_change']);
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
    expect(EDIT_RERUNS.field).toEqual(['rehearsal', 'login']);
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
    expect(checkLine(ID, { job: 'Aborted', at_goal: 30, at_backup: 15, neither: 0 }))
      .toBe(`check ${ID} done: job Aborted; 30 at goal, 15 at backup, 0 neither`);
    expect(reviewReviewedLine(ID)).toBe(`review ${ID} reviewed`);
    expect(reviewQuestionLine(ID, 'Why 200?')).toBe(`review ${ID} question: Why 200?`);
    expect(reviewChangesLine(ID, 'Use the batch size from settings.')).toBe(`review ${ID} changes required: Use the batch size from settings.`);
  });
  test('text is capped at 200 characters, one line', () => {
    const long = 'x'.repeat(1000);
    expect(reviewQuestionLine(ID, long)).toBe(`review ${ID} question: ${'x'.repeat(LINE_TEXT_MAX)}`);
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
