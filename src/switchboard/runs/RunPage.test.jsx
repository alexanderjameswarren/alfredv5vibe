import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RunPage from './RunPage';
import { scenarioNames, simSource } from './simulation';

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const HOUR = 60 * 60 * 1000;
const open = async (name, opts) => {
  const source = simSource(name, opts);
  const view = render(<RunPage source={source} />);
  await screen.findByTestId('run-desktop');
  await waitFor(() => expect(screen.getByTestId('run-desktop')).not.toHaveTextContent('Checking'));
  return { source, ...view };
};
/** The red bar and the Approve button: shown together or not at all. */
const together = () => expect(Boolean(screen.queryByTestId('run-approval-required'))).toBe(Boolean(screen.queryByTestId('run-approve')));

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => expect(global.fetch).not.toHaveBeenCalled());

describe('the run page, on sample data', () => {
  test('the data operation page shows parts 1-16 in the agreed order', async () => {
    await open('dataop-update');
    const order = ['run-simulation', 'run-approval-required', 'run-banner-production', 'run-headline', 'run-phase-header', 'run-client-org',
      'run-count-sentence', 'run-problem', 'run-status', 'run-sample', 'run-undo', 'run-will', 'run-desktop', 'run-after', 'run-details', 'run-approve'];
    const nodes = order.map((id) => screen.getByTestId(id));
    nodes.slice(1).forEach((node, i) => {
      // eslint-disable-next-line no-bitwise
      expect(nodes[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(screen.getByLabelText('Reason for not running (optional)')).toBeInTheDocument();
    expect(screen.getByTestId('run-count-sentence')).toHaveTextContent('This changes 45 live records of Gift in example-prod.');
    expect(screen.getByTestId('run-banner-production')).toHaveTextContent('This changes 45 live records.');
    expect(screen.queryByTestId('run-banner-sandbox')).toBeNull();
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Approve this run on PRODUCTION');
    expect(screen.getByTestId('run-undo')).toHaveTextContent('Undo: standard. Sets each campaign back to empty from the backup.');
    expect(screen.getAllByTestId('run-group').map((g) => g.querySelector('h3').textContent)).toEqual(['Before the write', 'Write', 'After the write']);
    expect(screen.getByTestId('run-stops')).toHaveTextContent('The run stops at the first step that fails.');
    expect(screen.getByTestId('run-details')).not.toHaveAttribute('open');
    expect(screen.queryByText('Approve', { exact: true })).toBeNull();
    expect(screen.queryByTestId('run-changed')).toBeNull();
  });

  test('the pre-check page: both banners, no count sentence, no sample, the two groups, pills by org', async () => {
    await open('precheck-ids');
    expect(screen.getByTestId('run-banner-production')).toHaveTextContent('Read only, nothing changes.');
    expect(screen.getByTestId('run-banner-sandbox')).toHaveTextContent('Sandbox, test records only');
    // eslint-disable-next-line no-bitwise
    expect(screen.getByTestId('run-banner-production').compareDocumentPosition(screen.getByTestId('run-banner-sandbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('run-org')).toHaveTextContent('example-dev1 (sandbox rehearsal)');
    expect(screen.queryByTestId('run-count-sentence')).toBeNull();
    expect(screen.queryByTestId('run-sample')).toBeNull();
    expect(screen.getByTestId('run-phase-header')).toHaveTextContent('Pre-check and rehearsal prior to data operation');
    const groups = screen.getAllByTestId('run-group');
    expect(groups.map((g) => g.querySelector('h3').textContent)).toEqual(['Production pre-check', 'Sandbox rehearsal']);
    expect([...groups[0].querySelectorAll('[data-testid="run-pill"]')].every((p) => p.dataset.org === 'production')).toBe(true);
    expect([...groups[1].querySelectorAll('[data-testid="run-pill"]')].every((p) => p.dataset.org === 'sandbox')).toBe(true);
    expect(screen.getByTestId('run-valid-until')).toHaveTextContent('No checks have passed yet');
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Approve this run on PRODUCTION and SANDBOX');
  });

  test('a sandbox filter that must differ shows both and a Not rehearsed line', async () => {
    await open('precheck-filter-differs');
    expect(screen.getByTestId('run-selected-by')).toHaveTextContent(/Production: .*Sandbox: /);
    expect(screen.getByTestId('run-not-rehearsed')).toHaveTextContent('Not rehearsed: The 30-day limit on CreatedDate.');
    expect(screen.getAllByTestId('run-step')[0]).toHaveTextContent("Count what the filter matches now, against diagnosis's expected 45.");
  });

  test('kept sandbox data and temporary code are on the status line', async () => {
    await open('dataop-update-kept');
    expect(screen.getByTestId('run-kept-sandbox')).toHaveTextContent('3 TEST gifts');
    expect(screen.getByTestId('run-kept-code')).toHaveTextContent('GiftCampaignFixBatch');
  });

  test('the project mark stays; a simulation never carries a run-id mark or the extension status block', async () => {
    const { container } = await open('dataop-update');
    const mark = container.querySelector('[data-switchboard-project]');
    expect(mark).toHaveAttribute('data-switchboard-project', 'demo_gift_campaign-x1y');
    expect(mark).toHaveAttribute('data-switchboard-kind', 'simulation');
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(container.querySelector('[data-switchboard-run-id]')).toBeNull();
    expect(container.querySelector('[data-switchboard-status]')).toBeNull();
    expect(screen.getByTestId('run-result-line')).toHaveTextContent('SIMULATION run sim-dataop-update');
  });
});

describe('the red bar and the Approve button always appear together', () => {
  test.each(scenarioNames())('%s, desktop ready, then approved', async (name) => {
    await open(name);
    together();
    expect(screen.getByTestId('run-approve')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    together();
    expect(screen.queryByTestId('run-approve')).toBeNull();
  });

  test.each(scenarioNames())('%s, desktop not ready', async (name) => {
    await open(name, { desktop: ['not_running'] });
    together();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    expect(screen.getByTestId('run-dont')).toBeInTheDocument();
  });

  test("after Don't run", async () => {
    await open('dataop-update');
    fireEvent.change(screen.getByLabelText('Reason for not running (optional)'), { target: { value: 'Wait for Monday' } });
    fireEvent.click(screen.getByTestId('run-dont'));
    await screen.findByTestId('run-cancelled');
    together();
    expect(screen.getByTestId('run-result-line')).toHaveTextContent('SIMULATION run sim-dataop-update cancelled: Wait for Monday');
  });

  test('checks expired: no Approve, no red bar', async () => {
    await open('dataop-update', { now: Date.now() - 25 * HOUR });
    together();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    expect(screen.getByTestId('run-expired')).toBeInTheDocument();
  });

  test('checks that expire while the page is open: the click approves nothing, and both go', async () => {
    // The scenario's oldest evidence is 3 hours before `now`: 23 hours 59 minutes ago here.
    const { source } = await open('dataop-update', { now: Date.now() - 21 * HOUR + 60 * 1000 });
    expect(screen.getByTestId('run-approve')).toBeInTheDocument();
    const approve = jest.spyOn(source, 'approve');
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * HOUR);
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    now.mockRestore();
    together();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    expect(screen.getByTestId('run-expired')).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
  });

  test('a recheck that passes says "checked just now"', async () => {
    await open('dataop-update');
    expect(screen.getByTestId('run-desktop')).toHaveTextContent('(checked when this page opened)');
    fireEvent.click(screen.getByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(screen.getByTestId('run-desktop')).toHaveTextContent('Desktop ready: Switchboard panel and helper running (checked just now)');
  });

  test('each desktop answer has its own words, and none says reload this page', async () => {
    for (const [answer, words] of [['no_extension', 'Approve from Chrome on your desktop.'], ['helper_down', 'the helper not running'],
      ['no_answer', "didn't answer"]]) {
      const view = await open('dataop-update', { desktop: [answer] });
      expect(screen.getByTestId('run-desktop')).toHaveTextContent(words);
      expect(screen.getByTestId('run-desktop')).not.toHaveTextContent('reload this page');
      view.unmount();
    }
  });

  test('an error at the click keeps the page and says nothing was approved', async () => {
    const { source } = await open('dataop-update');
    jest.spyOn(source, 'approve').mockRejectedValue(new Error('The runner did not answer.'));
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    expect(screen.getByTestId('run-note')).toHaveTextContent('The runner did not answer. Nothing was approved.');
    expect(screen.getByTestId('run-problem')).toBeInTheDocument();
    together();
  });

  test('the desktop is asked again at the click; if it is not ready, nothing is approved and both go', async () => {
    const { source } = await open('dataop-update', { desktop: ['running', 'not_running'] });
    const approve = jest.spyOn(source, 'approve');
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    await waitFor(() => expect(screen.queryByTestId('run-approve')).toBeNull());
    together();
    expect(approve).not.toHaveBeenCalled();
    expect(screen.queryByTestId('run-sent')).toBeNull();
  });
});
