import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RunPage from './RunPage';
import { scenarioNames, simSource } from './simulation';
import { BUTTON } from './look';
import { STEPS } from './runContract';

const STEPS_TEXT = (code, r) => STEPS[code].text({ code }, r);

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const HOUR = 60 * 60 * 1000;
const open = async (name, opts) => {
  const source = simSource(name, opts);
  const view = render(<RunPage source={source} />);
  await screen.findByTestId('run-desktop');
  await waitFor(() => expect(screen.getByTestId('run-desktop')).not.toHaveTextContent('Checking'));
  return { source, ...view };
};
/** The red bar and the page's action button (Approve, the rerun or the resend): shown together or not at all. */
const together = () => expect(Boolean(screen.queryByTestId('run-approval-required'))).toBe(Boolean(document.querySelector('[data-action]')));

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
    expect(screen.getAllByTestId('run-step').find((s) => s.dataset.code === 'login_can_write')).toHaveTextContent('Confirm the login can still update the Campaign__c field.');
    expect(screen.queryByTestId('run-check-again')).toBeNull();
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
  // These offer no buttons at all (closed, used, or a rerun already asked for); their own tests are below.
  const approvable = scenarioNames().filter((n) => !['undo-closed', 'run-picked-up', 'run-finished', 'dataop-update-rerun-waiting'].includes(n));
  test.each(approvable)('%s, desktop ready, then approved', async (name) => {
    await open(name, { desktop: ['running'] });
    together();
    // The action is Approve, the rerun (checks expired) or the resend (not started).
    const action = document.querySelector('[data-action]');
    expect(action).toBeInTheDocument();
    fireEvent.click(action);
    await screen.findByTestId('run-sent');
    together();
    expect(document.querySelector('[data-action]')).toBeNull();
  });

  test.each(approvable)('%s, desktop not ready', async (name) => {
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
    for (const [answer, words] of [['no_extension', 'Approve from Chrome on your desktop.'], ['helper_down', "The helper isn't running"],
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

  test('the desktop is asked again at the click; if it is not ready, nothing is approved, both go, and Check again is offered', async () => {
    const { source } = await open('dataop-update', { desktop: ['running', 'not_running'] });
    const approve = jest.spyOn(source, 'approve');
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    await waitFor(() => expect(screen.queryByTestId('run-approve')).toBeNull());
    together();
    expect(approve).not.toHaveBeenCalled();
    expect(screen.queryByTestId('run-sent')).toBeNull();
    expect(screen.getByTestId('run-desktop')).toHaveTextContent("The Switchboard panel and the helper aren't running. Start Switchboard on your desktop. (checked just now)");
    expect(screen.getByTestId('run-desktop-not-ready')).toContainElement(screen.getByTestId('run-check-again'));
  });
});

describe('the desktop states', () => {
  const OPENED = '(checked when this page opened)';
  test.each([
    ['not_running', `The Switchboard panel and the helper aren't running. Start Switchboard on your desktop. ${OPENED}`],
    ['panel_down', `The Switchboard panel isn't running. Start Switchboard on your desktop. ${OPENED}`],
    ['helper_down', `The helper isn't running. Start Switchboard on your desktop. ${OPENED}`],
    ['no_extension', `No Alfred extension in this browser. Approve from Chrome on your desktop. ${OPENED}`],
    ['no_answer', `The Alfred extension didn't answer. Reload it, then Check again. ${OPENED}`],
  ])('%s draws the "Desktop not ready" section and no Approve button', async (answer, reason) => {
    await open('dataop-update', { desktop: [answer] });
    together();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    const section = screen.getByTestId('run-desktop-not-ready');
    expect(section.className).toMatch(/bg-red-50/);
    expect(section.className).toMatch(/border-red-600/);
    expect(section.querySelector('h2')).toHaveTextContent(/^Desktop not ready$/);
    expect(screen.getByTestId('run-desktop')).toHaveTextContent(reason);
    expect(screen.getByTestId('run-desktop')).toHaveAttribute('data-answer', answer);
    expect(section).toContainElement(screen.getByTestId('run-desktop'));
    // Heading, then the reason, then Check again in the primary style; the section sits above Don't run.
    const check = screen.getByTestId('run-check-again');
    expect(section.lastElementChild).toBe(check);
    expect(check.className).toBe(BUTTON);
    // eslint-disable-next-line no-bitwise
    expect(section.compareDocumentPosition(screen.getByTestId('run-dont')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('when the desktop is ready: the plain line, Approve, and no not-ready section', async () => {
    await open('dataop-update');
    expect(screen.queryByTestId('run-desktop-not-ready')).toBeNull();
    expect(screen.getByTestId('run-desktop')).toHaveTextContent(`Desktop ready: Switchboard panel and helper running ${OPENED}`);
    // eslint-disable-next-line no-bitwise
    expect(screen.getByTestId('run-desktop').compareDocumentPosition(screen.getByTestId('run-after')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('run-approve')).toBeInTheDocument();
  });

  test('Check again asks once; when the desktop is now running, Approve and the red bar come back together', async () => {
    const { source } = await open('dataop-update', { desktop: ['no_answer', 'running'] });
    const ask = jest.spyOn(source, 'checkDesktop');
    await act(async () => { fireEvent.click(screen.getByTestId('run-check-again')); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('run-desktop')).toHaveTextContent('Desktop ready: Switchboard panel and helper running (checked just now)');
    expect(screen.queryByTestId('run-check-again')).toBeNull();
    expect(screen.getByTestId('run-approve')).toBeInTheDocument();
    together();
  });

  test('the desktop scenarios give their own answers: not running, then running after Check again', async () => {
    await open('desktop-not-running');
    expect(screen.getByTestId('run-desktop')).toHaveAttribute('data-answer', 'not_running');
    await act(async () => { fireEvent.click(screen.getByTestId('run-check-again')); });
    expect(screen.getByTestId('run-approve')).toBeInTheDocument();
    together();
  });

  test('a desktop check that throws at the Approve click approves nothing; both go and Check again is offered', async () => {
    const { source } = await open('dataop-update');
    jest.spyOn(source, 'checkDesktop').mockRejectedValue(new Error('gone'));
    const approve = jest.spyOn(source, 'approve');
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    expect(approve).not.toHaveBeenCalled();
    together();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    expect(screen.getByTestId('run-desktop')).toHaveAttribute('data-answer', 'no_answer');
    expect(screen.getByTestId('run-check-again')).toBeInTheDocument();
  });

  test('a double click approves once and asks the desktop once', async () => {
    const { source } = await open('dataop-update');
    const ask = jest.spyOn(source, 'checkDesktop');
    const approve = jest.spyOn(source, 'approve');
    await act(async () => {
      const button = screen.getByTestId('run-approve');
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  test('Approve and Check again never show at once; while a Check again is in flight the section stays, its button disabled', async () => {
    const { source } = await open('dataop-update', { desktop: ['no_answer'] });
    expect(screen.queryByTestId('run-approve')).toBeNull();
    let answer;
    jest.spyOn(source, 'checkDesktop').mockImplementation(() => new Promise((res) => { answer = res; }));
    await act(async () => { fireEvent.click(screen.getByTestId('run-check-again')); });
    expect(screen.queryByTestId('run-approve')).toBeNull();
    expect(screen.getByTestId('run-check-again')).toBeDisabled();
    expect(screen.getByTestId('run-desktop')).toHaveTextContent('Checking the desktop');
    await act(async () => { answer({ answer: 'running', panel: true, helper: true }); });
    expect(screen.getByTestId('run-approve')).toBeInTheDocument();
    expect(screen.queryByTestId('run-check-again')).toBeNull();
  });

  test('Check again that still fails keeps the state and the button', async () => {
    await open('dataop-update', { desktop: ['no_extension', 'helper_down'] });
    await act(async () => { fireEvent.click(screen.getByTestId('run-check-again')); });
    expect(screen.getByTestId('run-desktop')).toHaveTextContent("The helper isn't running. Start Switchboard on your desktop. (checked just now)");
    expect(screen.getByTestId('run-check-again')).toBeInTheDocument();
    together();
  });

  test('the page asks nothing by itself: one ask at open, none while it sits', async () => {
    jest.useFakeTimers();
    try {
      const source = simSource('dataop-update', { desktop: ['not_running'] });
      const ask = jest.spyOn(source, 'checkDesktop');
      render(<RunPage source={source} />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { jest.advanceTimersByTime(10 * 60 * 1000); });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('no Check again after Don\'t run, or on a closed undo; checks expired still offers it, for the rerun', async () => {
    const only = (text) => {
      expect(screen.queryByTestId('run-check-again')).toBeNull();
      expect(screen.queryByTestId('run-desktop-not-ready')).toBeNull();
      expect(screen.getAllByTestId('run-desktop')).toHaveLength(1);
      expect(screen.getByTestId('run-desktop')).toHaveTextContent(text);
    };
    // Expired: the rerun needs the desktop too, so the not-ready section stands in for it.
    const view = await open('dataop-update-expired', { desktop: ['no_answer'] });
    expect(screen.getByTestId('run-desktop-not-ready')).toBeInTheDocument();
    expect(screen.queryByTestId('run-rerun')).toBeNull();
    together();
    view.unmount();
    await open('dataop-update', { desktop: ['not_running'] });
    fireEvent.click(screen.getByTestId('run-dont'));
    await screen.findByTestId('run-cancelled');
    only("Desktop not ready: the Switchboard panel and the helper aren't running. (checked when this page opened)");
  });

  test('while the desktop has not answered yet: one Checking line, no section, no Approve, no red bar', async () => {
    const source = simSource('dataop-update');
    source.checkDesktop = () => new Promise(() => {});
    render(<RunPage source={source} />);
    await screen.findByTestId('run-desktop');
    expect(screen.getAllByTestId('run-desktop')).toHaveLength(1);
    expect(screen.getByTestId('run-desktop')).toHaveTextContent('Checking the desktop…');
    expect(screen.queryByTestId('run-desktop-not-ready')).toBeNull();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    together();
  });

  test('a Check again that throws keeps the section, as no answer, with the button usable again', async () => {
    const { source } = await open('dataop-update', { desktop: ['not_running'] });
    jest.spyOn(source, 'checkDesktop').mockRejectedValue(new Error('gone'));
    await act(async () => { fireEvent.click(screen.getByTestId('run-check-again')); });
    expect(screen.getByTestId('run-desktop-not-ready')).toBeInTheDocument();
    expect(screen.getByTestId('run-desktop')).toHaveAttribute('data-answer', 'no_answer');
    expect(screen.getByTestId('run-check-again')).toBeEnabled();
    together();
  });

  test('focus: to Check again when the section appears after the Approve click, to Approve when a check succeeds', async () => {
    await open('dataop-update', { desktop: ['running', 'not_running', 'running'] });
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    await waitFor(() => expect(screen.getByTestId('run-check-again')).toHaveFocus());
    await act(async () => { fireEvent.click(screen.getByTestId('run-check-again')); });
    await waitFor(() => expect(screen.getByTestId('run-approve')).toHaveFocus());
  });
});

const stepText = (code) => screen.getAllByTestId('run-step').filter((s) => s.dataset.code === code).map((s) => s.textContent.trim());

describe('screen b: the other operations', () => {
  test('insert: its file of rows and one sample row to be created', async () => {
    await open('dataop-insert');
    expect(screen.getByTestId('run-what-changes')).toHaveTextContent('Creates 12 records of Gift__c from gifts-to-create.csv.');
    expect(stepText('write')[0]).toContain('Create 12 records from gifts-to-create.csv on your PC.');
    expect(screen.getAllByTestId('run-sample-record')).toHaveLength(1);
    expect(screen.getByTestId('run-sample-role')).toHaveTextContent('To create:');
    expect(screen.getByTestId('run-count-sentence')).toHaveTextContent('This changes 12 live records of Gift in example-prod.');
    expect(stepText('login_can_write')[0]).toContain('Confirm the login can still create Gift records.');
  });

  test('upsert: the update and create split, one sample of each, the total typed', async () => {
    await open('dataop-upsert');
    expect(screen.getByTestId('run-count')).toHaveTextContent('45: 30 to update, 15 to create');
    expect(screen.getAllByTestId('run-sample-role').map((e) => e.textContent)).toEqual(['To update:', 'To create:']);
    expect(stepText('type_count')[0]).toContain('You type the count, 45, in the terminal');
    expect(stepText('write')[0]).toContain('Update 30 and create 15 records, matched by Import_Ref__c.');
  });

  test('delete: knock-on counts, a sample with its child count, the undo deadline', async () => {
    await open('dataop-delete');
    const k = screen.getByTestId('run-knock-on');
    expect(k).toHaveTextContent('11 records deleted with their parents');
    expect(k).toHaveTextContent('3 links on other records blanked');
    expect(k).toHaveTextContent('0 links blocking the delete');
    expect(screen.getByTestId('run-sample-children')).toHaveTextContent('2 child records deleted with it.');
    expect(screen.getByTestId('run-undo')).toHaveTextContent(/^Undo: standard\. Restores them, with their children, from the recycle bin\. Until \d+ \w+ \d{4}\.$/);
    expect(stepText('write')[0]).toContain('Delete the 8 records to the recycle bin.');
  });

  test('undelete: days remaining, a sample with who deleted it and when', async () => {
    await open('dataop-undelete');
    expect(screen.getByTestId('run-days-left')).toHaveTextContent('9 days left before Salesforce empties the recycle bin.');
    expect(screen.getByTestId('run-sample-deleted')).toHaveTextContent(/^Deleted by Sam Example, .+; 9 days left in the recycle bin\.$/);
    expect(stepText('write')[0]).toContain('Restore the 8 records from the recycle bin.');
  });

  test('several objects: each step with its count, Pause before this, the total typed, the login names each object, backup-only undo', async () => {
    await open('dataop-multi');
    expect(stepText('write_step')).toEqual([
      'Production Accounts: create 20 records. A failed row stops the run before the next step.',
      'Production Contacts: create 35 records. A failed row stops the run before the next step.',
      'Production Pause before this. Opportunities: create 35 records.',
    ]);
    expect(stepText('login_can_write')[0]).toContain('Confirm the login can still create Accounts, Contacts and Opportunities.');
    expect(stepText('type_count')[0]).toContain('You type the count, 90, in the terminal');
    expect(screen.getByTestId('run-count')).toHaveTextContent('90 in all: 20 Accounts, 35 Contacts, 35 Opportunities');
    expect(screen.getByTestId('run-count-sentence')).toHaveTextContent('This changes 90 live records of Accounts, Contacts and Opportunities in example-prod.');
    expect(screen.getByTestId('run-undo')).toHaveTextContent(/^Undo: backup only\./);
  });
});

describe('screen c: the undo page', () => {
  test('Approve this UNDO, up to N, the count typed after skips, an undo has no undo', async () => {
    await open('undo');
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Approve this UNDO on PRODUCTION');
    expect(screen.getByTestId('run-count-sentence')).toHaveTextContent('This changes up to 45 live records of Gift in example-prod.');
    expect(screen.getByTestId('run-count')).toHaveTextContent('Up to 45');
    expect(screen.getByTestId('run-undo-scope')).toHaveTextContent('Records edited since the run are skipped and listed with who changed them and when.');
    expect(stepText('skip_edited')[0]).toContain('Skip any record edited since the run');
    expect(stepText('type_count')[0]).toContain('You type the exact count left after skips in the terminal');
    expect(screen.getByTestId('run-undo')).toHaveTextContent('Undo: none. An undo has no undo. A further change is a new request through diagnosis.');
    expect(screen.getByTestId('run-phase-header')).toHaveTextContent('Undo of a data operation');
  });

  test('after a stopped run, only what that run changed', async () => {
    await open('undo-stopped');
    expect(screen.getByTestId('run-undo-scope')).toHaveTextContent('stopped before it finished, so this undo covers only the 20 records it changed.');
    expect(screen.getByTestId('run-count-sentence')).toHaveTextContent('This changes up to 20 live records');
  });

  test('after the undo deadline: the reason, and no buttons, red bar or not-ready section', async () => {
    for (const desktop of [['running'], ['not_running']]) {
      const view = render(<RunPage source={simSource('undo-closed', { desktop })} />);
      await screen.findByTestId('run-undo-closed');
      expect(screen.getByTestId('run-undo-closed')).toHaveTextContent('No undo is offered: the deleted gifts left the recycle bin after 15 days. A further change is a new request through diagnosis.');
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByTestId('run-approval-required')).toBeNull();
      expect(screen.queryByTestId('run-desktop-not-ready')).toBeNull();
      // Nothing on the page reads as if the undo could still run.
      expect(screen.queryByTestId('run-after')).toBeNull();
      expect(screen.queryByTestId('run-desktop')).toBeNull();
      expect(screen.queryByTestId('run-count-sentence')).toBeNull();
      expect(screen.getByTestId('run-undo-scope')).not.toHaveTextContent('Undo possible until');
      expect(screen.getByTestId('run-banner-production')).toHaveTextContent('Nothing changes: no undo is offered.');
      view.unmount();
    }
  });

  test('a closed undo shows no expired note, however old its evidence', async () => {
    render(<RunPage source={simSource('undo-closed', { now: Date.now() - 2 * 24 * HOUR })} />);
    await screen.findByTestId('run-undo-closed');
    expect(screen.queryByTestId('run-expired')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test("the undo page's What changes describes the undo, not the original run", async () => {
    await open('undo');
    expect(screen.getByTestId('run-what-changes')).toHaveTextContent('Puts back up to 45 records of Gift__c from the backup of run demo_gift_campaign-x1y-s5-cd34.');
  });

  test("a delete's undo whose deadline passes while the page is open approves nothing at the click", async () => {
    const { source } = await open('undo-delete');
    const approve = jest.spyOn(source, 'approve');
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 24 * HOUR);
    await act(async () => { fireEvent.click(screen.getByTestId('run-approve')); });
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-undo-closed')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    now.mockRestore();
  });
});

describe('s6 fixes from Alex', () => {
  test('an undo has no 24-hour expiry: no "Checks valid until", and still approvable days later', async () => {
    await open('undo', { now: Date.now() - 3 * 24 * HOUR });
    expect(screen.queryByTestId('run-valid-until')).toBeNull();
    expect(screen.queryByTestId('run-expired')).toBeNull();
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Approve this UNDO on PRODUCTION');
  });

  test("an update's undo has no deadline; a delete's does", async () => {
    const view = await open('undo');
    expect(screen.getByTestId('run-undo-scope')).not.toHaveTextContent('Undo possible until');
    view.unmount();
    await open('undo-delete');
    expect(screen.getByTestId('run-undo-scope')).toHaveTextContent('Undo possible until');
    expect(screen.getByTestId('run-what-changes')).toHaveTextContent('Restores up to 8 records of Gift__c from the recycle bin');
  });

  test('the stopped-run undo selects only what that run changed', async () => {
    await open('undo-stopped');
    expect(screen.getByTestId('run-selected-by')).toHaveTextContent(/^The 20 records the stopped run changed\.$/);
  });

  test.each([
    ['dataop-update', 'Confirm the records still match the backup.'],
    ['dataop-delete', 'Confirm the records still match the backup.'],
    ['dataop-insert', 'Confirm none of the rows already exists.'],
    ['dataop-multi', 'Confirm none of the rows already exists.'],
    ['dataop-upsert', "Confirm the 30 records to update still match the backup, and the 15 to create still don't exist."],
    ['dataop-undelete', 'Confirm the 8 records are still in the recycle bin.'],
  ])('%s: the first "Before the write" step', async (name, words) => {
    await open(name);
    expect(stepText('still_match_backup')[0]).toBe(`Production ${words}`);
  });

  test('the multi-object undo line', async () => {
    await open('dataop-multi');
    expect(screen.getByTestId('run-undo')).toHaveTextContent(/^Undo: backup only\. The Ids of everything created are saved on your PC\. Undoing across several objects isn't in this version\.$/);
  });
});

describe('A5: screen d, the correction page', () => {
  test('version up by one, the changed block, only the rerun checks, then Still valid with times', async () => {
    await open('correction-field');
    expect(screen.getByTestId('run-version')).toHaveTextContent(/^Request version 2, corrected /);
    const changed = screen.getByTestId('run-changed');
    expect(changed).toHaveTextContent('Campaign__c');
    expect(changed).toHaveTextContent('Appeal__c');
    expect(changed).toHaveTextContent("Why: The Spring appeal report reads Appeal__c, not Campaign__c; diagnosis named the wrong field.");
    // A field edit reruns the rehearsal, the login check and the backup (Alex, s7).
    expect(screen.getAllByTestId('run-step').map((s) => s.dataset.code)).toEqual(['login_can_change', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test']);
    // ...and the sample record (Alex, s8b), so it leaves "Still valid".
    expect(screen.getAllByTestId('run-still-valid-check').map((e) => e.textContent.split(',')[0])).toEqual(['Count', 'Triggers and flows']);
    // eslint-disable-next-line no-bitwise
    expect(screen.getByTestId('run-will').compareDocumentPosition(screen.getByTestId('run-still-valid')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Approve this run on PRODUCTION and SANDBOX');
  });

  test('a wording-only edit has no page of its own: the next page carries the block', async () => {
    await open('dataop-update-wording');
    expect(screen.getByTestId('run-phase-header')).toHaveTextContent('Data operation');
    expect(screen.getByTestId('run-changed')).toHaveTextContent('Side effects');
    expect(screen.queryByTestId('run-still-valid')).toBeNull();
  });
});

describe('A5: not started, checks expired, check what happened', () => {
  test.each(['not-started-marked', 'not-started-worked-out'])('%s: "Not started. Nothing ran." and Try again resends with the same link id', async (name) => {
    const { source } = await open(name);
    expect(screen.getByTestId('run-not-started')).toHaveTextContent('Not started. Nothing ran.');
    expect(screen.queryByTestId('run-approve')).toBeNull();
    const resend = jest.spyOn(source, 'resend');
    fireEvent.click(screen.getByTestId('run-resend'));
    await screen.findByTestId('run-sent');
    expect(resend).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('run-result-line')).toHaveTextContent(`SIMULATION run sim-${name} resent`);
  });

  test('approved under 15 minutes ago and not picked up: waiting, no buttons', async () => {
    const source = simSource('dataop-update');
    const load = source.load;
    source.load = async () => ({ ...(await load()), run: { consumed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), picked_up_at: null } });
    render(<RunPage source={source} />);
    await screen.findByTestId('run-waiting');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('run-not-started')).toBeNull();
    together();
  });

  test('checks expired: no Approve; the rerun is the approval, with its steps in full beneath it', async () => {
    const { source } = await open('dataop-update-expired');
    expect(screen.queryByTestId('run-approve')).toBeNull();
    const rerun = screen.getByTestId('run-rerun');
    expect(rerun).toHaveTextContent('Run the pre-check and rehearsal again');
    together();
    const will = screen.getByTestId('run-rerun-will');
    // eslint-disable-next-line no-bitwise
    expect(rerun.compareDocumentPosition(will) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...will.querySelectorAll('[data-testid="run-step"]')].map((s) => s.dataset.code))
      .toEqual(['count_listed', 'login_can_change', 'list_automation', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test']);
    const spy = jest.spyOn(source, 'rerun');
    const approve = jest.spyOn(source, 'approve');
    fireEvent.click(rerun);
    await screen.findByTestId('run-sent');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-sent')).toHaveTextContent('Once they pass, this same page offers the data operation.');
  });

  test('in rerun mode, the banners and "After you approve" describe the pre-check, not the write', async () => {
    await open('dataop-update-expired');
    expect(screen.getByTestId('run-banner-production')).toHaveTextContent('Read only, nothing changes.');
    expect(screen.getByTestId('run-after')).toHaveTextContent('runs the production pre-check first, read only, then the sandbox rehearsal');
    expect(screen.getByTestId('run-after')).not.toHaveTextContent('type the count');
  });

  test.each([['run-picked-up', 'Picked up'], ['run-finished', 'Finished']])('%s: the link is used; the page only reports', async (name, words) => {
    render(<RunPage source={simSource(name)} />);
    await screen.findByTestId('run-used');
    expect(screen.getByTestId('run-used')).toHaveTextContent(words);
    expect(screen.queryByRole('button')).toBeNull();
    together();
  });

  test('a rerun already asked for: no second rerun, no expired note', async () => {
    render(<RunPage source={simSource('dataop-update-rerun-waiting')} />);
    await screen.findByTestId('run-rerun-waiting');
    expect(screen.queryByTestId('run-rerun')).toBeNull();
    expect(screen.queryByTestId('run-expired')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    together();
  });

  test('waiting for pickup with the checks expired: no expired note', async () => {
    const source = simSource('dataop-update-expired');
    const load = source.load;
    source.load = async () => ({ ...(await load()), run: { consumed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), picked_up_at: null } });
    render(<RunPage source={source} />);
    await screen.findByTestId('run-waiting');
    expect(screen.queryByTestId('run-expired')).toBeNull();
  });

  test('not started and expired: the link counts as unused, so the rerun is offered and runs (no dead end)', async () => {
    const { source } = await open('not-started-expired');
    expect(screen.getByTestId('run-not-started')).toBeInTheDocument();
    // The not-started text says the checks expired; no second expired note.
    expect(screen.queryByTestId('run-expired')).toBeNull();
    expect(screen.getByTestId('run-not-started-rerun')).toHaveTextContent('This link counts as unused because the run never started');
    expect(screen.queryByTestId('run-resend')).toBeNull();
    together();
    const rerun = jest.spyOn(source, 'rerun');
    fireEvent.click(screen.getByTestId('run-rerun'));
    await screen.findByTestId('run-sent');
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('run-result-line')).toHaveTextContent('SIMULATION run sim-not-started-expired');
  });

  // After the rerun from a not-started link: the stored run is still the old one; a later rerun_at supersedes it.
  const afterRerun = (passed) => {
    const source = simSource('not-started-expired');
    const load = source.load;
    source.load = async () => {
      const page = await load();
      const at = new Date(Date.now() - (passed ? 40 : 5) * 60 * 1000).toISOString();
      const evidence = passed
        ? page.request.evidence.map((e) => ({ ...e, passed_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }))
        : page.request.evidence;
      return { ...page, request: { ...page.request, rerun_at: at, evidence } };
    };
    return source;
  };

  test('not started, then the rerun asked for: no second rerun, no resend', async () => {
    render(<RunPage source={afterRerun(false)} />);
    await screen.findByTestId('run-rerun-waiting');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('run-not-started')).toBeNull();
    together();
  });

  test('not started, then the rerun passed: the page offers the data operation, not Try again', async () => {
    render(<RunPage source={afterRerun(true)} />);
    expect(await screen.findByTestId('run-approve')).toHaveTextContent('Approve this run on PRODUCTION');
    expect(screen.queryByTestId('run-resend')).toBeNull();
    expect(screen.queryByTestId('run-not-started')).toBeNull();
    together();
  });

  test("the undo page's triggers-and-flows step, as agreed with the hub", async () => {
    await open('undo');
    expect(stepText('automation_unchanged')[0]).toBe('Production Confirm the triggers and flows are the same as when the run was recorded. If they differ, the undo stops with nothing changed.');
  });

  test('after the rerun passed, the same page offers the data operation', async () => {
    await open('dataop-update-rerun-passed');
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Approve this run on PRODUCTION');
    expect(screen.getAllByTestId('run-phase')[0]).toHaveTextContent('Pre-check and rehearsal: passed (run again)');
  });

  test('check what happened: read only, the three steps, the interrupted run, the job state and three counts back', async () => {
    await open('check');
    expect(screen.getByTestId('run-banner-production')).toHaveTextContent('Read only, nothing changes.');
    expect(screen.queryByTestId('run-count-sentence')).toBeNull();
    expect(screen.queryByTestId('run-sample')).toBeNull();
    expect(screen.queryByTestId('run-undo')).toBeNull();
    expect(screen.getByTestId('run-what-changes')).toHaveTextContent('Nothing: this page only reads.');
    expect(screen.getByTestId('run-interrupted')).toHaveTextContent('Write, after about 20 of 45 records');
    expect(screen.getAllByTestId('run-group').map((g) => g.querySelector('h3').textContent)).toEqual(['What happened']);
    expect(stepText('job_state')).toHaveLength(1);
    expect(stepText('compare_records')[0]).toContain('Compare each record with the backup and with the goal.');
    expect(stepText('find_temp_code')[0]).toContain('Look for temporary code left in production.');
    expect(screen.getByTestId('run-after')).toHaveTextContent('Back to Alfred: the job state and three counts');
    expect(screen.getByTestId('run-approve')).toHaveTextContent('Check what happened on PRODUCTION');
  });
});

describe('A7 fixes', () => {
  const settled = async (name, opts) => {
    render(<RunPage source={simSource(name, opts)} />);
    await waitFor(() => expect(screen.getByTestId('run-headline')).toHaveAttribute('data-settled', 'true'));
  };

  test('closed undo: "Undo: not offered, the deadline has passed" in the status line, and no "This run will:"', async () => {
    await settled('undo-closed');
    expect(screen.getByTestId('run-status')).toHaveTextContent('Undo: not offered, the deadline has passed.');
    // It replaces the waiting Undo phase: no "Undo: waiting" above it.
    expect(screen.getByTestId('run-status')).not.toHaveTextContent('waiting');
    expect(screen.getAllByTestId('run-phase').map((p) => p.textContent)).toEqual([expect.stringMatching(/^Data operation: passed/)]);
    expect(screen.queryByTestId('run-will')).toBeNull();
  });

  test("a delete's undo: the login check is to restore", async () => {
    await open('undo-delete');
    expect(stepText('login_can_write')[0]).toBe('Production Confirm the login can still restore Gift records.');
  });

  test.each([['run-picked-up', 'running', 'Data operation: running, picked up'], ['run-finished', 'finished', 'Data operation: finished, ']])(
    '%s: the status line says %s, not waiting', async (name, state, words) => {
      await settled(name);
      const phase = screen.getAllByTestId('run-phase').find((p) => p.textContent.startsWith('Data operation'));
      // The phase keeps its state; data-live says what the stored run shows.
      expect(phase).toHaveAttribute('data-live', state);
      expect(phase).toHaveTextContent(words);
      expect(screen.getByTestId('run-status')).not.toHaveTextContent('waiting');
    },
  );

  test('a finished run with a failure reads "stopped", not "finished"', async () => {
    const source = simSource('run-finished');
    const load = source.load;
    source.load = async () => { const p = await load(); return { ...p, run: { ...p.run, failure_reason: 'stopped_at_step' } }; };
    render(<RunPage source={source} />);
    await screen.findByTestId('run-used');
    expect(screen.getByTestId('run-used')).toHaveTextContent(/^Stopped /);
    expect(screen.getAllByTestId('run-phase').find((p) => p.textContent.startsWith('Data operation'))).toHaveAttribute('data-live', 'stopped');
  });

  test('a closed undo has one "Undo:" line, in the status line', async () => {
    await settled('undo-closed');
    expect(screen.queryByTestId('run-undo')).toBeNull();
  });

  test('run pages keep max-w-3xl', async () => {
    await open('dataop-update');
    expect(screen.getByTestId('run-card').className).toMatch(/max-w-3xl/);
  });

  test("an upsert's undo: the login check is to delete and update", () => {
    expect(STEPS_TEXT('login_can_write', { page: 'undo', operation: { kind: 'upsert', object: 'Gift__c', object_label: 'Gift', external_id: 'Ref__c' } }))
      .toBe('Confirm the login can still delete and update Gift records.');
  });

  test('check what happened: no "nothing expires" line', async () => {
    await open('check');
    expect(screen.queryByTestId('run-valid-until')).toBeNull();
  });

  test.each([
    ['correction-value', ['create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'], ['Count', 'Login check', 'Triggers and flows', 'Backup', 'Sample record'], 'Approve this run on SANDBOX'],
    ['correction-records', ['count_listed', 'save_backup'], ['Login check', 'Triggers and flows', 'Sandbox rehearsal'], 'Approve this run on PRODUCTION'],
    ['correction-records-filter', ['count_filter', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'], ['Login check', 'Triggers and flows'], 'Approve this run on PRODUCTION and SANDBOX'],
    ['correction-sandbox-filter', ['create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'], ['Count', 'Login check', 'Triggers and flows', 'Backup', 'Sample record'], 'Approve this run on SANDBOX'],
    ['correction-code', ['create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'], ['Count', 'Login check', 'Triggers and flows', 'Backup', 'Sample record'], 'Approve this run on SANDBOX'],
  ])('%s: only what the edit reruns, the rest still valid, and the button names the orgs it touches', async (name, steps, still, label) => {
    await open(name);
    expect(screen.getByTestId('run-changed')).toBeInTheDocument();
    expect(screen.getAllByTestId('run-step').map((s) => s.dataset.code)).toEqual(steps);
    expect(screen.getAllByTestId('run-still-valid-check').map((e) => e.textContent.split(',')[0])).toEqual(still);
    expect(screen.getByTestId('run-approve')).toHaveTextContent(new RegExp(`^${label}$`));
  });
});
