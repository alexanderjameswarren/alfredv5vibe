import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApprovePage from './ApprovePage';
import { supabase } from '../supabaseClient';

jest.mock('../supabaseClient', () => ({
  supabaseUrl: 'https://db.example',
  supabaseAnonKey: 'anon',
  supabase: { auth: { getSession: jest.fn(), signInWithOAuth: jest.fn() } },
}));

const PREVIEW = { ok: true, action_id: 'a1', headline: 'THIS RUNS A SELECT', sql: 'select 1;\nselect 2;', fingerprint: 'fp1',
  project_code: 'switchboard2-h8r', expires_at: '2026-11-01T12:30:00Z' };
const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

/** fetch answers per route; a function answer can change between calls. */
function runner(routes) {
  global.fetch = jest.fn((url) => {
    const r = routes[url.split('/').pop()];
    return typeof r === 'function' ? r() : r;
  });
}
const called = (route) => global.fetch.mock.calls.filter(([u]) => u.endsWith(`/${route}`));
const open = () =>
  render(
    <MemoryRouter initialEntries={['/approve/tok1']}>
      <Routes>
        <Route path="/approve/:token" element={<ApprovePage />} />
      </Routes>
    </MemoryRouter>
  );
const dryRun = () => fireEvent.click(screen.getByRole('button', { name: /^dry run$/i }));
const CLEAN = () => reply({ ok: true, run_id: 'dry1', summary: 'runs a select' });
const DRY = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  supabase.auth.getSession.mockReset();
  supabase.auth.signInWithOAuth.mockReset();
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt1' } } });
});

const openAt = (entry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/approve/:token" element={<ApprovePage />} />
      </Routes>
    </MemoryRouter>
  );
const runningMark = (c) => c.querySelector('[data-switchboard-running]');

test('running shows only while an approved run is under way, with the link\'s kind', async () => {
  let finish;
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: () => new Promise((r) => { finish = r; }) });
  const { container } = openAt('/approve/tok1?kind=git&exp=2000000000');
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  await waitFor(() => expect(runningMark(container)).toHaveAttribute('data-switchboard-running', 'git'));
  finish(await reply({ ok: true, run_id: DRY, summary: 'done' }));
  await screen.findByText('Ran for real');
  expect(runningMark(container)).toBeNull();
  expect(container.querySelector('[data-switchboard-run-id]')).not.toBeNull();
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'git');
});

test('a dry run is not running; a link with no kind is SQL', async () => {
  let finish;
  runner({ preview: reply(PREVIEW), 'dry-run': () => new Promise((r) => { finish = r; }) });
  const { container } = open();
  await screen.findByText(/running the dry run/i);
  expect(runningMark(container)).toBeNull();
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sql');
  finish(await CLEAN());
  await screen.findByRole('button', { name: /^approve/i });
  expect(runningMark(container)).toBeNull();
});

test('a test action is running from open, until its result', async () => {
  let finish;
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': () => new Promise((r) => { finish = r; }) });
  const { container } = open();
  await screen.findByText(/running the test/i);
  expect(runningMark(container)).toHaveAttribute('data-switchboard-running', 'sql');
  finish(await reply({ ok: true, test: true, run_id: DRY, summary: 'passed' }));
  await screen.findByText('Test run, undone');
  expect(runningMark(container)).toBeNull();
});

test('a refused Approve stops running', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: reply({ ok: false, error: 'busy, try again' }, 409) });
  const { container } = open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  await screen.findByText(/busy, try again/);
  expect(runningMark(container)).toBeNull();
});

test('every finished outcome keeps the place the extension reports a failed post in', async () => {
  const cases = [
    [{ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: reply({ ok: true, run_id: DRY, summary: 'done' }) }, /^approve/i],
    [{ preview: reply(PREVIEW), 'dry-run': CLEAN, cancel: reply({ cancelled: true, run_id: DRY, reason: '' }) }, /^don't run/i],
  ];
  for (const [routes, button] of cases) {
    runner(routes);
    const { container, unmount } = open();
    fireEvent.click(await screen.findByRole('button', { name: button }));
    await waitFor(() => expect(container.querySelector('[data-switchboard-run-id]')).not.toBeNull());
    expect(container.querySelector('[data-switchboard-status]')).toHaveAttribute('hidden');
    expect(container.querySelector('[data-switchboard-retry]')).not.toBeNull();
    unmount();
  }
});

test('signed out asks for login and calls nothing', async () => {
  supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
  runner({});
  open();
  fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));
  expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('shows the headline, project and whole SQL, with his JWT and the token', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN });
  open();
  expect(await screen.findByText('THIS RUNS A SELECT')).toBeInTheDocument();
  expect(screen.getByText('switchboard2-h8r')).toHaveAttribute('data-switchboard-project', 'switchboard2-h8r');
  expect(screen.getByTestId('approve-sql').textContent).toBe(PREVIEW.sql);
  expect(screen.getByText('Approve')).toHaveClass('text-dark');
  const [url, init] = called('preview')[0];
  expect(url).toBe('https://db.example/functions/v1/switchboard-runner/preview');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer jwt1');
  expect(JSON.parse(init.body)).toEqual({ token: 'tok1' });
});

test('the description sits above the SQL; an older action without one shows none', async () => {
  runner({ preview: reply({ ...PREVIEW, description: 'Sets status to done for 3 reminders' }), 'dry-run': CLEAN });
  const { unmount } = open();
  const shown = await screen.findByText('Sets status to done for 3 reminders');
  expect(shown.compareDocumentPosition(screen.getByTestId('approve-sql')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  unmount();
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN });
  open();
  await screen.findByText('THIS RUNS A SELECT');
  expect(screen.queryByTestId('approve-description')).not.toBeInTheDocument();
});

test('the dry run starts by itself, once, and Approve waits for it; no run id on the page', async () => {
  let finish;
  runner({ preview: reply(PREVIEW), 'dry-run': () => new Promise((r) => { finish = r; }) });
  const { container } = open();
  expect(await screen.findByText(/running the dry run/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  finish(await CLEAN());
  expect(await screen.findByText(/runs a select/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^approve/i })).toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(1);
  expect(container.querySelector('[data-switchboard-run-id]')).toBeNull();
});

test('a failed dry run shows why and offers no Approve', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': reply({ ok: false, run_id: 'dry1', summary: 'failed at statement 1: boom' }) });
  open();
  expect(await screen.findByText(/failed at statement 1: boom/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
});

test('Approve sends the fingerprint, shows the result and puts the run id on the page', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN,
    approve: reply({ ok: true, run_id: 'run9', summary: 'done it', conformance: 'CONFORMANT' }) });
  const { container } = open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  expect(await screen.findByText(/done it/)).toBeInTheDocument();
  expect(screen.getByText('sql run9')).toBeInTheDocument();
  expect(screen.getByText('Paste this into the Claude chat, then close this tab.')).toBeInTheDocument();
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
  const copy = screen.getByRole('button', { name: /^copy$/i });
  expect(copy.querySelector('svg')).not.toBeNull();
  fireEvent.click(copy);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sql run9');
  expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument();
  // The extension's place: under the line, in the card, empty and hidden until it has something to say.
  const status = container.querySelector('[data-switchboard-status]');
  expect(status).not.toBeVisible();
  expect(status.querySelector('[data-switchboard-status-text]').textContent).toBe('');
  expect(status.querySelector('button[data-switchboard-retry]').textContent).toBe('Try again');
  expect(screen.getByText('sql run9').compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(status.closest('.shadow-md')).not.toBeNull();
  expect(screen.getByText(/CONFORMANT/)).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-run-id]').getAttribute('data-switchboard-run-id')).toBe('run9');
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fp1' });
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /dry run/i })).not.toBeInTheDocument();
});

test('a real run that fails still shows its run id, and cannot be approved again', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: reply({ ok: false, run_id: 'run9', summary: 'failed at statement 1: boom' }) });
  const { container } = open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  expect(await screen.findByText(/failed at statement 1: boom/)).toBeInTheDocument();
  // Claude still needs to hear about a failure.
  expect(screen.getByText('sql run9')).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-run-id]').getAttribute('data-switchboard-run-id')).toBe('run9');
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
});

test.each([
  [404, 'no such link.', /doesn't exist/i],
  [410, 'this link has already been used.', /already been used/i],
  [410, 'this link has expired.', /has expired/i],
  [401, 'unauthorized', /isn't allowed/i],
])('preview %i %s has a clear message and no SQL', async (status, error, want) => {
  runner({ preview: reply({ ok: false, error }, status) });
  open();
  expect(await screen.findByText(want)).toBeInTheDocument();
  expect(screen.queryByTestId('approve-sql')).not.toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(0);
});

test('a mismatched link at Approve says so and nothing more can be run', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN,
    approve: reply({ ok: false, error: 'switchboard_consume_link: the SQL does not match what this link approved.' }, 409) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  expect(await screen.findByText(/does not match what this link approved/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
});

test('a busy dry run keeps the page and can be tried again', async () => {
  let n = 0;
  runner({ preview: reply(PREVIEW), 'dry-run': () => (n++ ? CLEAN() : reply({ ok: false, error: 'another run is in progress.' }, 409)) });
  open();
  expect(await screen.findByText(/another run is in progress/)).toBeInTheDocument();
  dryRun();
  expect(await screen.findByRole('button', { name: /^approve/i })).toBeInTheDocument();
});

const COUNTS = [
  { statement: 1, action: 'inserts rows into t', count: 2, expected: 2, differs: false },
  { statement: 2, action: 'updates rows in t', count: 1, expected: 5, differs: true },
];
const MISMATCH = () => reply({ ok: false, mismatch: true, run_id: 'dry1', summary: 'inserts 2 rows into t; updates 1 row in t', counts: COUNTS });
const copied = () => navigator.clipboard.writeText.mock.calls.at(-1)[0];
const copyDetails = async () => {
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
  fireEvent.click(await screen.findByRole('button', { name: /copy details/i }));
};

test('the dry run lists each statement\'s rows', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': reply({ ok: true, run_id: 'dry1', summary: 's', counts: [
    { statement: 1, action: 'deletes rows from t', count: 3, expected: 3, differs: false },
    { statement: 3, action: 'updates rows in u', count: 1, expected: 'unknown', differs: false },
  ] }) });
  open();
  expect(await screen.findByText(/statement 1: deletes rows from t: 3 rows/i)).toBeInTheDocument();
  expect(screen.getByText(/statement 3: updates rows in u: 1 row$/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^approve/i })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /copy details/i })).not.toBeInTheDocument();
});

test('a count mismatch disables Approve, shows expected against actual, and copies the details', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': MISMATCH });
  open();
  expect(await screen.findByText(/statement 2: updates rows in t: 1 row, expected 5/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^approve/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /dry run again/i })).toBeEnabled();
  await copyDetails();
  const text = copied();
  expect(text).toContain('Action: a1');
  expect(text).toContain('Dry run: dry1');
  expect(text).toContain('counts differ from what was expected');
  expect(text).toContain('Statement 2: updates rows in t: 1 row, expected 5');
  expect(text).toContain('Statement 1: inserts rows into t: 2 rows');
});

test('Copy details sits beside a failed dry run and a refusal, not beside the run line', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': reply({ ok: false, run_id: 'dry1', summary: 'failed at statement 1: boom' }) });
  const { unmount } = open();
  await copyDetails();
  expect(copied()).toContain('failed at statement 1: boom');
  unmount();
  runner({ preview: reply(PREVIEW), 'dry-run': reply({ ok: false, error: 'another run is in progress.' }, 409) });
  const second = open();
  await copyDetails();
  expect(copied()).toContain('another run is in progress.');
  expect(copied()).toContain('Action: a1');
  second.unmount();
  runner({ preview: reply({ ok: false, error: 'this link has expired.' }, 410) });
  open();
  await copyDetails();
  expect(copied()).toMatch(/has expired/);
});

test('Don\'t run sends the reason, puts the dry run id and the cancelled line on the page', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, cancel: reply({ ok: true, cancelled: true, run_id: DRY, reason: 'wrong table' }) });
  const { container } = open();
  fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: 'wrong table' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText(`sql ${DRY} cancelled: wrong table`)).toBeInTheDocument();
  expect(JSON.parse(called('cancel')[0][1].body)).toEqual({ token: 'tok1', reason: 'wrong table' });
  const mark = container.querySelector('[data-switchboard-run-id]');
  expect(mark.getAttribute('data-switchboard-run-id')).toBe(DRY);
  expect(mark).toHaveAttribute('data-switchboard-cancelled');
  expect(mark.getAttribute('data-switchboard-reason')).toBe('wrong table');
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-retry]')).not.toBeNull();
});

test('Don\'t run with no reason has a plain line; it is offered on a mismatch and a failure too', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': MISMATCH, cancel: reply({ ok: true, cancelled: true, run_id: DRY, reason: '' }) });
  const { unmount } = open();
  fireEvent.click(await screen.findByRole('button', { name: /don't run/i }));
  expect(await screen.findByText(`sql ${DRY} cancelled`)).toBeInTheDocument();
  unmount();
  runner({ preview: reply(PREVIEW), 'dry-run': reply({ ok: false, run_id: 'dry1', summary: 'failed at statement 1: boom' }) });
  open();
  expect(await screen.findByRole('button', { name: /don't run/i })).toBeInTheDocument();
});

test('a Don\'t run the runner refuses keeps the page and says why', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, cancel: reply({ ok: false, error: 'the runner hit an error; see its logs.' }, 500) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /don't run/i }));
  expect(await screen.findByText(/the runner hit an error/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^approve/i })).toBeInTheDocument();
});

test('a test action runs once by itself, never offers Approve, and puts its run id on the page', async () => {
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': reply({ ok: true, test: true, run_id: DRY, summary: 'updates 1 row in t', counts: [] }) });
  const { container } = open();
  expect(await screen.findByText(`sql ${DRY}`)).toBeInTheDocument();
  expect(screen.getByText(/test run, undone/i)).toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(1);
  expect(container.querySelector('[data-switchboard-run-id]').getAttribute('data-switchboard-run-id')).toBe(DRY);
  expect(container.querySelector('[data-switchboard-cancelled]')).toBeNull();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /don't run/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /dry run/i })).not.toBeInTheDocument();
});

test('a failed test still posts its run id, with Copy details; a busy one can be tried again', async () => {
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': reply({ ok: false, test: true, run_id: DRY, summary: 'failed at statement 1: boom' }) });
  const { unmount } = open();
  expect(await screen.findByText(`sql ${DRY}`)).toBeInTheDocument();
  await copyDetails();
  expect(copied()).toContain('boom');
  unmount();
  let n = 0;
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': () => (n++ ? reply({ ok: true, test: true, run_id: DRY, summary: 's' }) : reply({ ok: false, error: 'another run is in progress.' }, 409)) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /run the test/i }));
  expect(await screen.findByText(`sql ${DRY}`)).toBeInTheDocument();
});

test('a lost connection at Approve warns it may have run and offers no retry', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: () => Promise.reject(new Error('network')) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  expect(await screen.findByText(/may have run/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument());
});
