import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RunPage from './RunPage';
import { SCENARIOS } from './simulation';
import { linkEndedReason, liveRunSource } from './liveSource';
import { runEnd } from './runContract';

// s21b (spec 14.8): every way a run can end, read through the live source from a preview shaped like
// switchboard_run_preview's. A failed run says failed, with its reason, and never "finished"; a run that never started
// says so. No end state draws a result line or carries a data-switchboard-line mark: the helper posts those lines.

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const LINK = '841e3702-1a15-4b2b-adb8-67d7b97560a2';
const MIN = 60 * 1000;
const REFUSAL = "refused by the helper: sf_run isn't built yet: sb/lib/sfrun.mjs (runSfRun) comes from the data runs thread; nothing ran";

/** A real pre-check page's preview with its run, as the database returns it (254 plus s21b's ok, pass, summary). */
function preview(run, { evidence = [] } = {}) {
  const now = Date.now();
  const { request } = SCENARIOS['precheck-ids'].build(now);
  return {
    link_id: LINK,
    request: { ...request, simulation: false, evidence },
    fingerprint: 'f',
    total_count: null,
    link: { current: true, used_at: new Date(now - 40 * MIN).toISOString() },
    run: { action_id: '90b02a6a-3741-48d3-a175-14badd5c1d78', consumed_at: new Date(now - 40 * MIN).toISOString(),
      picked_up_at: new Date(now - 39 * MIN).toISOString(), finished_at: new Date(now - 39 * MIN).toISOString(),
      failure_reason: null, not_started: false, rerun: false, ok: null, pass: null, summary: null, ...run },
  };
}
const ended = (run, opts) => {
  render(<RunPage source={liveRunSource('t'.repeat(64), preview(run, opts), { askDesktop: async () => ({ answer: 'no_answer' }) })} />);
};
const phase = () => screen.getAllByTestId('run-phase').find((p) => p.textContent.startsWith('Pre-check and rehearsal'));
/** No end state draws a result line or a line mark. */
const noLine = () => {
  expect(screen.queryByTestId('run-result-line')).toBeNull();
  expect(document.querySelector('[data-switchboard-line]')).toBeNull();
};
const neverFinished = () => {
  expect(screen.getByTestId('run-status')).not.toHaveTextContent(/finished/i);
  expect(screen.queryByTestId('run-used') ?? document.body).not.toHaveTextContent(/finished/i);
};

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => expect(global.fetch).not.toHaveBeenCalled());

describe('how a run ended', () => {
  test('refused before anything ran (the live s21 case): failed, with the refusal, never finished', async () => {
    ended({ status: 'failed', ok: false, summary: REFUSAL });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'failed');
    expect(used).toHaveTextContent(/^Failed /);
    expect(screen.getByTestId('run-end-reason')).toHaveTextContent(`Reason: ${REFUSAL}`);
    expect(phase()).toHaveAttribute('data-live', 'failed');
    expect(phase()).toHaveTextContent('Pre-check and rehearsal: failed');
    neverFinished();
    noLine();
  });

  test('failed partway, after some checks were recorded: failed, with its reason', async () => {
    const at = new Date(Date.now() - 39 * MIN).toISOString();
    ended({ status: 'failed', ok: false, summary: 'stopped at the login check: no edit access on Gift__c' },
      { evidence: [{ check: 'count', org: 'production', passed_at: at }] });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'failed');
    expect(screen.getByTestId('run-end-reason')).toHaveTextContent('Reason: stopped at the login check: no edit access on Gift__c');
    expect(phase()).toHaveAttribute('data-live', 'failed');
    neverFinished();
    noLine();
  });

  test('expired, never picked up: never started, and nothing says failed or finished', async () => {
    ended({ status: 'failed', ok: false, picked_up_at: null, failure_reason: 'expired_not_picked_up', not_started: true,
      summary: 'not picked up within 15 minutes' });
    const box = await screen.findByTestId('run-not-started');
    expect(box).toHaveTextContent('Not started. Nothing ran.');
    expect(screen.queryByTestId('run-used')).toBeNull();
    expect(screen.queryByTestId('run-end-reason')).toBeNull();
    expect(screen.getByTestId('run-status')).not.toHaveTextContent(/finished|failed/i);
    noLine();
  });

  test("cancelled (Don't run): a reopened link says it was voided with the note, and nothing was approved", () => {
    expect(linkEndedReason({ link: { voided_at: '2026-11-25T19:29:43Z', void_reason: 'cancelled: wait' } }))
      .toBe('This link was voided (cancelled: wait). Nothing was approved.');
    expect(runEnd(null)).toBeNull();
  });

  test('finished PASS', async () => {
    ended({ status: 'succeeded', ok: true, pass: true, summary: 'pre-check passed' });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'pass');
    expect(used).toHaveTextContent(/^Finished .*: PASS/);
    expect(phase()).toHaveTextContent('Pre-check and rehearsal: finished: PASS');
    expect(screen.queryByTestId('run-end-reason')).toBeNull();
    noLine();
  });

  test('finished FAIL: finished, the checks failed, and not a failed run', async () => {
    ended({ status: 'succeeded', ok: true, pass: false, summary: 'pre-check: 2 checks failed' });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'fail');
    expect(used).toHaveTextContent(/^Finished .*: FAIL/);
    expect(phase()).toHaveAttribute('data-live', 'finished: FAIL');
    expect(screen.queryByTestId('run-end-reason')).toBeNull();
    noLine();
  });

  test('pruned, failed: ok and pass null, still failed, with the kept summary', async () => {
    ended({ status: 'failed', ok: null, pass: null, summary: REFUSAL });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'failed');
    expect(screen.getByTestId('run-end-reason')).toHaveTextContent(`Reason: ${REFUSAL}`);
    neverFinished();
    noLine();
  });

  test('pruned, succeeded: plain finished, with no PASS or FAIL', async () => {
    ended({ status: 'succeeded', ok: null, pass: null, summary: 'pre-check passed' });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'finished');
    expect(used).not.toHaveTextContent(/PASS|FAIL/);
    expect(phase()).toHaveAttribute('data-live', 'finished');
    noLine();
  });

  test('a run row finished while the action is still consumed (the runner still recording) reads running, not PASS', async () => {
    ended({ status: 'consumed', ok: true, pass: true, summary: 'pre-check passed' });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'running');
    expect(used).not.toHaveTextContent(/PASS|finished/i);
    expect(phase()).toHaveAttribute('data-live', 'running');
    noLine();
  });

  test('failed and finished before its pickup was recorded: the used box only, never waiting', async () => {
    ended({ status: 'failed', ok: false, picked_up_at: null, failure_reason: 'stopped', summary: null });
    const used = await screen.findByTestId('run-used');
    expect(used).toHaveAttribute('data-end', 'failed');
    expect(screen.getByTestId('run-end-reason')).toHaveTextContent('Reason: The run stopped partway.');
    expect(screen.queryByTestId('run-waiting')).toBeNull();
    noLine();
  });

  test('a failed run with no summary and no reason still says failed', () => {
    expect(runEnd({ finished_at: '2026-11-25T19:29:43Z', picked_up_at: '2026-11-25T19:29:43Z', status: 'failed' }))
      .toEqual({ state: 'failed', word: 'failed', reason: 'No reason was recorded.' });
    expect(runEnd({ finished_at: '2026-11-25T19:29:43Z', picked_up_at: '2026-11-25T19:29:43Z', status: 'succeeded', failure_reason: 'stopped' }))
      .toEqual({ state: 'failed', word: 'failed', reason: 'The run stopped partway.' });
  });

  test("Don't run on an open page keeps its own cancelled line and marks (s20), the one line the page posts", async () => {
    const p = preview(null);
    p.run = null;
    render(<RunPage source={{ ...liveRunSource('t'.repeat(64), p, { askDesktop: async () => ({ answer: 'running' }) }), cancel: async () => ({ cancelled: true, reason: 'wait' }) }} />);
    await waitFor(() => expect(screen.getByTestId('run-headline')).toHaveAttribute('data-settled', 'true'));
    fireEvent.click(screen.getByTestId('run-dont'));
    const box = await screen.findByTestId('run-result-line');
    expect(box).toHaveAttribute('data-switchboard-line', `run ${LINK} cancelled: wait`);
    expect(screen.queryByTestId('run-used')).toBeNull();
  });
});
