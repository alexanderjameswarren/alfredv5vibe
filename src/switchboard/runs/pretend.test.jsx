import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import RunPage from './RunPage';
import { simSource } from './simulation';
import { kindOf, liveReviewSource, liveRunSource } from './liveSource';
import { PRETEND_WAKE_LINE_NOTE, REAL_LINE_NOTE, WAKE_LINE_NOTE, isPretend, isSimulation } from './look';

// s28 (spec 15.2 point 4): a pretend page keeps the SIMULATION strip and carries the s20 marks, as a real page does,
// with its lines starting SIMULATION and a data-switchboard-pretend mark. A plain simulation carries no marks.

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const LINK = '11111111-2222-4333-8444-555555555555';
const ACTION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A scenario read through a pretend source with a real link id, as the live source gives a pretend request. */
function pretend(base, overrides = {}) {
  return { ...base, kind: 'pretend', load: async () => ({ ...(await base.load()), link_id: LINK }), ...overrides };
}
const top = () => document.querySelector('[data-switchboard-project]');
const openRun = async (source) => {
  render(<RunPage source={source} />);
  await screen.findByTestId('run-desktop');
  await waitFor(() => expect(screen.getByTestId('run-desktop')).not.toHaveTextContent('Checking'));
};

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => expect(global.fetch).not.toHaveBeenCalled());

describe('the pretend kind', () => {
  test('the live source gives pretend only to a simulation carrying request.pretend', () => {
    expect(kindOf({ request: { simulation: true, pretend: { scenario: 'count_ok' } } })).toBe('pretend');
    expect(kindOf({ request: { simulation: true } })).toBe('sim');
    expect(kindOf({ request: { simulation: false, pretend: { scenario: 'x' } } })).toBe('real');
    expect(kindOf({ request: { simulation: true, pretend: true } })).toBe('sim');
    expect(kindOf(null)).toBe('sim');
  });
  test('pretend is still a simulation', () => {
    expect(isSimulation({ kind: 'pretend' })).toBe(true);
    expect(isPretend({ kind: 'pretend' })).toBe(true);
    expect(isPretend({ kind: 'sim' })).toBe(false);
  });
});

describe('a pretend page', () => {
  test('the strip stays, with the pretend wording; the page is marked a simulation and pretend, its kind run', async () => {
    await openRun(pretend(simSource('pretend-precheck')));
    expect(screen.getByTestId('run-simulation')).toHaveTextContent('A pretend run: the desktop helper makes the data up. Nothing here reaches any org.');
    expect(document.querySelector('[data-switchboard-simulation]')).not.toBeNull();
    expect(top()).toHaveAttribute('data-switchboard-kind', 'run');
    expect(top()).toHaveAttribute('data-switchboard-pretend', '');
  });

  test('Approve: running while out, the action id, and the line SIMULATION run <link id>, marked', async () => {
    let resolve;
    const approve = () => new Promise((res) => { resolve = res; });
    await openRun(pretend(simSource('pretend-precheck'), { approve }));
    fireEvent.click(screen.getByTestId('run-approve'));
    await waitFor(() => expect(top()).toHaveAttribute('data-switchboard-running', ''));
    resolve({ sent: true, link_id: LINK, action_id: ACTION });
    await screen.findByTestId('run-sent');
    expect(top()).toHaveAttribute('data-switchboard-action-id', ACTION);
    const box = screen.getByTestId('run-result-line');
    expect(box).toHaveAttribute('data-switchboard-line', `SIMULATION run ${LINK}`);
    expect(box).toHaveAttribute('data-switchboard-link-id', LINK);
    expect(box.querySelector('code').textContent).toBe(`SIMULATION run ${LINK}`);
    expect(box.querySelector('[data-switchboard-status]')).not.toBeNull();
    // s32b: nothing posts at Approve; the pretend wake note, and no copy button.
    expect(box).toHaveTextContent(PRETEND_WAKE_LINE_NOTE);
    expect(box).toHaveTextContent('Its SIMULATION result line comes from the tile when the run ends, and this tab closes by itself.');
    expect(within(box).queryByTitle('Copy this line for the chat')).toBeNull();
  });

  test('the sent text says a pretend run went to the helper, its data made up', async () => {
    await openRun(pretend(simSource('pretend-precheck'), { approve: async () => ({ sent: true, link_id: LINK }) }));
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(screen.getByTestId('run-sent')).toHaveTextContent('Pretend: Sent to the desktop helper');
    expect(screen.getByTestId('run-sent-text')).toHaveTextContent('Sent as a pretend run: its data is made up and no org is touched. It must pick the run up within 15 minutes.');
    expect(screen.getByTestId('run-sent-text')).not.toHaveTextContent('Nothing was sent');
  });

  test("the function's own line wins when it has one", async () => {
    await openRun(pretend(simSource('pretend-precheck'), { approve: async () => ({ sent: true, link_id: LINK, line: `SIMULATION run ${LINK}` }) }));
    fireEvent.click(screen.getByTestId('run-approve'));
    expect(await screen.findByTestId('run-result-line')).toHaveAttribute('data-switchboard-line', `SIMULATION run ${LINK}`);
  });

  test('the resent, reruns and cancelled forms all start SIMULATION', async () => {
    const { unmount } = render(<RunPage source={pretend(simSource('not-started-marked'), { resend: async () => ({ sent: true, resent: true, link_id: LINK }) })} />);
    fireEvent.click(await screen.findByTestId('run-resend'));
    expect(await screen.findByTestId('run-result-line')).toHaveAttribute('data-switchboard-line', `SIMULATION run ${LINK} resent`);
    unmount();

    const r2 = render(<RunPage source={pretend(simSource('correction-value'), { approve: async () => ({ sent: true, link_id: LINK, as_rerun: true }) })} />);
    fireEvent.click(await screen.findByTestId('run-approve'));
    expect(await screen.findByTestId('run-result-line')).toHaveAttribute('data-switchboard-line', `SIMULATION run ${LINK} reruns`);
    r2.unmount();

    render(<RunPage source={pretend(simSource('pretend-precheck'))} />);
    await screen.findByTestId('run-dont');
    fireEvent.change(screen.getByLabelText('Reason for not running (optional)'), { target: { value: 'not today' } });
    fireEvent.click(screen.getByTestId('run-dont'));
    expect(await screen.findByTestId('run-result-line')).toHaveAttribute('data-switchboard-line', `SIMULATION run ${LINK} cancelled: not today`);
  });
});

describe('the live sources for a pretend preview', () => {
  const preview = { link_id: LINK, fingerprint: 'fp', request: { simulation: true, pretend: { scenario: 'count_ok' }, page: 'precheck', evidence: [] }, review: { id: 'r' } };
  test('the run source is pretend; the review source is a plain simulation (unmarked, the plain strip)', () => {
    expect(liveRunSource('a'.repeat(64), preview).kind).toBe('pretend');
    expect(liveReviewSource('a'.repeat(64), preview).kind).toBe('sim');
    expect(liveRunSource('a'.repeat(64), { ...preview, request: { ...preview.request, simulation: 'true' } }).kind).toBe('sim');
  });
});

describe('a real page is unchanged', () => {
  const real = (base) => ({ ...base, kind: 'real', load: async () => ({ ...(await base.load()), link_id: LINK }) });
  test('no pretend mark, no strip, the real line and note', async () => {
    await openRun(real(simSource('dataop-update'), {}));
    expect(top()).toHaveAttribute('data-switchboard-kind', 'run');
    expect(top()).not.toHaveAttribute('data-switchboard-pretend');
    expect(screen.queryByTestId('run-simulation')).toBeNull();
  });
  test('Approve: the bare line, the wake note with no copy button, and the plain sent text', async () => {
    await openRun({ ...real(simSource('dataop-update')), approve: async () => ({ sent: true, link_id: LINK }) });
    fireEvent.click(screen.getByTestId('run-approve'));
    const box = await screen.findByTestId('run-result-line');
    expect(box).toHaveAttribute('data-switchboard-line', `run ${LINK}`);
    // s32b: nothing goes to the chat at Approve; the result line comes from the tile.
    expect(box).toHaveTextContent(WAKE_LINE_NOTE);
    expect(box).not.toHaveTextContent(REAL_LINE_NOTE);
    expect(within(box).queryByTitle('Copy this line for the chat')).toBeNull();
    // The status block the extension fills is still there, hidden.
    expect(box.querySelector('[data-switchboard-status]')).toHaveAttribute('hidden');
    expect(screen.getByTestId('run-sent-text')).toHaveTextContent('It must pick the run up within 15 minutes.');
    expect(screen.getByTestId('run-sent')).not.toHaveTextContent(/Pretend|Simulated/);
  });
});

describe('a plain simulation', () => {
  test('keeps no marks, its strip and sent text as before', async () => {
    await openRun(simSource('dataop-update'));
    expect(screen.getByTestId('run-simulation')).toHaveTextContent('Sample data. Nothing here reaches any org.');
    expect(top()).toHaveAttribute('data-switchboard-kind', 'simulation');
    expect(top()).not.toHaveAttribute('data-switchboard-pretend');
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(top()).not.toHaveAttribute('data-switchboard-running');
    expect(top()).not.toHaveAttribute('data-switchboard-action-id');
    const box = screen.getByTestId('run-result-line');
    expect(box).not.toHaveAttribute('data-switchboard-line');
    expect(box).not.toHaveAttribute('data-switchboard-link-id');
    expect(box.querySelector('[data-switchboard-status]')).toBeNull();
    expect(screen.getByTestId('run-sent-text')).toHaveTextContent('Nothing was sent: this is a simulation, and no org was touched.');
    expect(screen.getByTestId('run-sent')).toHaveTextContent('Simulated: Sent to the desktop helper');
  });
});
