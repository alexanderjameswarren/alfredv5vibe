import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RunPage from './RunPage';
import CodeReviewPage from './CodeReviewPage';
import { reviewSimSource, simSource } from './simulation';

// s20: the page side of the extension contract (spec 14.7). The marks are on real pages only; a simulation gets none.

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const LINK = '11111111-2222-4333-8444-555555555555';
const ACTION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A sample scenario read through a source of kind 'real', with a real link id: the page treats it as live. */
function real(base, overrides = {}) {
  return { ...base, kind: 'real', load: async () => ({ ...(await base.load()), link_id: LINK }), ...overrides };
}
/** A promise the test settles by hand, to hold the Approve request in flight. */
function held() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const top = () => document.querySelector('[data-switchboard-project]');
const openRun = async (source) => {
  render(<RunPage source={source} />);
  await screen.findByTestId('run-desktop');
  await waitFor(() => expect(screen.getByTestId('run-desktop')).not.toHaveTextContent('Checking'));
};

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => expect(global.fetch).not.toHaveBeenCalled());

describe('the run page marks', () => {
  test('Approve: running only while the request is out, then the action id and the line marks', async () => {
    const out = held();
    await openRun(real(simSource('dataop-update'), { approve: () => out.promise }));
    expect(top()).toHaveAttribute('data-switchboard-kind', 'run');
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    fireEvent.click(screen.getByTestId('run-approve'));
    await waitFor(() => expect(top()).toHaveAttribute('data-switchboard-running', ''));
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    out.resolve({ sent: true, link_id: LINK, action_id: ACTION });
    await screen.findByTestId('run-sent');
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(top()).toHaveAttribute('data-switchboard-action-id', ACTION);
    const box = screen.getByTestId('run-result-line');
    expect(box).toHaveAttribute('data-switchboard-line', `run ${LINK}`);
    expect(box).toHaveAttribute('data-switchboard-link-id', LINK);
    expect(box.querySelector('code').textContent).toBe(box.getAttribute('data-switchboard-line'));
  });

  test('a failed Approve drops running and sets no action id', async () => {
    const out = held();
    await openRun(real(simSource('dataop-update'), { approve: () => out.promise }));
    fireEvent.click(screen.getByTestId('run-approve'));
    await waitFor(() => expect(top()).toHaveAttribute('data-switchboard-running', ''));
    out.reject(new Error('Network down.'));
    await screen.findByTestId('run-note');
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    expect(screen.queryByTestId('run-result-line')).toBeNull();
  });

  test('a desktop that is not ready at the click: no request, so no running mark', async () => {
    const approve = jest.fn();
    await openRun(real(simSource('dataop-update', { desktop: ['running', 'not_running'] }), { approve }));
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-desktop-not-ready');
    expect(approve).not.toHaveBeenCalled();
    expect(top()).not.toHaveAttribute('data-switchboard-running');
  });

  test('Resend: running while out, then the action id it returns, and the resent line', async () => {
    const out = held();
    await openRun(real(simSource('not-started-marked'), { resend: () => out.promise }));
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    fireEvent.click(screen.getByTestId('run-resend'));
    await waitFor(() => expect(top()).toHaveAttribute('data-switchboard-running', ''));
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    out.resolve({ sent: true, resent: true, link_id: LINK, action_id: ACTION });
    await screen.findByTestId('run-sent');
    expect(top()).toHaveAttribute('data-switchboard-action-id', ACTION);
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(screen.getByTestId('run-result-line')).toHaveAttribute('data-switchboard-line', `run ${LINK} resent`);
  });

  test("Don't run: the cancelled line, exactly as shown, and no action id", async () => {
    await openRun(real(simSource('dataop-update')));
    fireEvent.change(screen.getByLabelText('Reason for not running (optional)'), { target: { value: '  wait   for Monday ' } });
    fireEvent.click(screen.getByTestId('run-dont'));
    const box = await screen.findByTestId('run-result-line');
    expect(box).toHaveAttribute('data-switchboard-line', `run ${LINK} cancelled: wait for Monday`);
    expect(box.querySelector('code').textContent).toBe(box.getAttribute('data-switchboard-line'));
    expect(box).toHaveAttribute('data-switchboard-link-id', LINK);
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
  });

  test('the expired-checks rerun sets neither running nor an action id', async () => {
    const rerun = jest.fn(async () => ({ sent: true, rerun: true, link_id: LINK, action_id: ACTION }));
    await openRun(real(simSource('dataop-update-expired'), { rerun }));
    fireEvent.click(screen.getByTestId('run-rerun'));
    await screen.findByTestId('run-sent');
    expect(rerun).toHaveBeenCalled();
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    expect(screen.getByTestId('run-result-line')).toHaveAttribute('data-switchboard-link-id', LINK);
  });

  test("a correction's Approve (its reruns): running while out, then no action id", async () => {
    const out = held();
    await openRun(real(simSource('correction-field'), { approve: () => out.promise }));
    fireEvent.click(screen.getByTestId('run-approve'));
    await waitFor(() => expect(top()).toHaveAttribute('data-switchboard-running', ''));
    out.resolve({ sent: true, as_rerun: true, link_id: LINK, action_id: ACTION });
    await screen.findByTestId('run-sent');
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    expect(screen.getByTestId('run-result-line')).toHaveAttribute('data-switchboard-line', `run ${LINK} reruns`);
  });

  test('a reply with no action id sets no action-id mark', async () => {
    await openRun(real(simSource('dataop-update'), { approve: async () => ({ sent: true, link_id: LINK, action_id: null }) }));
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
  });

  test('a simulation page carries none of the marks, before or after Approve', async () => {
    const out = held();
    const base = simSource('dataop-update');
    const approve = jest.fn(() => out.promise);
    await openRun({ ...base, approve });
    expect(top()).toHaveAttribute('data-switchboard-kind', 'simulation');
    fireEvent.click(screen.getByTestId('run-approve'));
    // The request is out: the source's approve has been called and not yet answered.
    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    out.resolve({ sent: true, link_id: 'sim-dataop-update', action_id: ACTION });
    const box = await screen.findByTestId('run-result-line');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    expect(box).not.toHaveAttribute('data-switchboard-line');
    expect(box).not.toHaveAttribute('data-switchboard-link-id');
    expect(document.querySelector('[data-switchboard-line], [data-switchboard-link-id], [data-switchboard-running], [data-switchboard-action-id]')).toBeNull();
  });
});

describe('the code review page marks', () => {
  const openReview = async (source) => {
    render(<CodeReviewPage source={source} />);
    await screen.findByTestId('review-text');
  };

  test('a question: the line marks, and never an action id or a running mark', async () => {
    await openReview(real(reviewSimSource('review-code-fix')));
    fireEvent.change(screen.getByTestId('review-text'), { target: { value: 'Why two places?' } });
    fireEvent.click(screen.getByTestId('review-ask'));
    const box = await screen.findByTestId('run-result-line');
    expect(box).toHaveAttribute('data-switchboard-line', `review ${LINK} question: Why two places?`);
    expect(box).toHaveAttribute('data-switchboard-link-id', LINK);
    expect(document.querySelector('[data-switchboard-action-id], [data-switchboard-running]')).toBeNull();
  });

  test('a simulated review carries no line marks', async () => {
    await openReview(reviewSimSource('review-code-fix'));
    fireEvent.change(screen.getByTestId('review-text'), { target: { value: 'Why two places?' } });
    fireEvent.click(screen.getByTestId('review-ask'));
    const box = await screen.findByTestId('run-result-line');
    expect(box).not.toHaveAttribute('data-switchboard-line');
    expect(box).not.toHaveAttribute('data-switchboard-link-id');
  });
});
