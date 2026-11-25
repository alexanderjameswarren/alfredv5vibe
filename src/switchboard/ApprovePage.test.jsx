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
/** s22: a sql page shows Approve disabled while its dry run is pending, so wait for it to be on offer. */
const approveOn = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: /^approve/i })).toBeEnabled());
  return screen.getByRole('button', { name: /^approve/i });
};
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
  fireEvent.click(await approveOn());
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
  await approveOn();
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
  fireEvent.click(await approveOn());
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
    // s22: wait for the dry run, since Approve is shown disabled until it answers.
    await approveOn();
    fireEvent.click(screen.getByRole('button', { name: button }));
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
  // C1: no "Approve" heading under "Alfred".
  expect(screen.queryByText('Approve')).toBeNull();
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
  // s22: Approve is shown while the dry run runs, but can't be clicked.
  expect(screen.getByRole('button', { name: /^approve/i })).toBeDisabled();
  finish(await CLEAN());
  expect(await screen.findByText(/runs a select/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^approve/i })).toBeEnabled();
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
  fireEvent.click(await approveOn());
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
  fireEvent.click(await approveOn());
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
  fireEvent.click(await approveOn());
  expect(await screen.findByText(/does not match what this link approved/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
});

test('a busy dry run keeps the page and can be tried again', async () => {
  let n = 0;
  runner({ preview: reply(PREVIEW), 'dry-run': () => (n++ ? CLEAN() : reply({ ok: false, error: 'another run is in progress.' }, 409)) });
  open();
  expect(await screen.findByText(/another run is in progress/)).toBeInTheDocument();
  dryRun();
  expect(await approveOn()).toBeInTheDocument();
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
  fireEvent.click(await approveOn());
  expect(await screen.findByText(/may have run/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument());
});

// --- git actions (spec §11.3) ---

const GIT = { ok: true, kind: 'git', action_id: 'g1', headline: 'GITPUSH FINISH switchboard2-h8r: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE',
  fingerprint: 'fpg', project_code: 'switchboard2-h8r', payload: { command: 'gitpush', mode: 'finish', finish: 'phase' } };

test('git: says what will run, no dry run, Approve sends it to the helper', async () => {
  runner({ preview: reply(GIT), approve: reply({ ok: true, action_id: 'g1', sent: true }) });
  const { container } = openAt('/approve/tok1?kind=git&exp=2000000000');
  expect(await screen.findByText(/finishes this phase only/i)).toHaveTextContent('removes the worktree');
  expect(screen.queryByTestId('approve-sql')).not.toBeInTheDocument();
  expect(screen.getByText(/git has no dry run/i)).toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(0);
  expect(container.querySelector('[data-switchboard-run-id]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(screen.getByText(/result comes back to the chat/i)).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fpg' });
  expect(container.querySelector('[data-switchboard-run-id]')).toHaveAttribute('data-switchboard-run-id', 'g1');
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'git');
  expect(screen.getByText('git g1')).toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(0);
});

test('git: Don\'t run cancels without a dry run', async () => {
  runner({ preview: reply(GIT), cancel: reply({ ok: true, cancelled: true, reason: 'later' }) });
  const { container } = open();
  fireEvent.change(await screen.findByLabelText(/reason for not running/i), { target: { value: 'later' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('git g1 cancelled: later')).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-cancelled]')).not.toBeNull();
  expect(called('dry-run')).toHaveLength(0);
});

test('git: a refusal at Approve is shown and nothing is marked sent', async () => {
  runner({ preview: reply(GIT), approve: reply({ ok: false, error: 'switchboard is switched off.' }, 409) });
  const { container } = open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText(/switched off/)).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-run-id]')).toBeNull();
});

test('git: plain words for each command', () => {
  const { gitLines } = jest.requireActual('./ApprovePage');
  const w = (p) => gitLines(p, 'p-a1').join(' ');
  expect(w({ command: 'gitpush', mode: 'checkpoint', paths: ['a.sql', 'docs/'] })).toMatch(/these paths.*a\.sql, docs\/.*Releases the database claims/);
  expect(w({ command: 'gitpush', mode: 'checkpoint', all: true, db: 'keep' })).toMatch(/every uncommitted path.*Keeps the database claims/);
  expect(w({ command: 'gitpush', mode: 'finish', finish: 'project-done' })).toMatch(/whole project.*removes the worktree.*docs\/history/);
  expect(w({ command: 'gitpush', mode: 'push', message: 'm1' })).toMatch(/gitpush push.*Commit message: m1/);
  expect(w({ command: 'gitcom', message: 'fix x', include_unclaimed: 'all' })).toMatch(/claimed files.*every unclaimed change.*Commit message: fix x/);
  expect(w({ command: 'gitsync' })).toMatch(/merges main into its worktree/);
  expect(w({ command: 'gitnewtree', install: false })).toMatch(/Skips npm install/);
  expect(w({ command: 'gitnewtree' })).toMatch(/project code already names.*Runs npm install/);
  expect(w({ command: 'gitnewtree', repo: 'C:\\Users\\Alex\\projects\\alfred-v5' })).toMatch(/In the repo C:\\Users\\Alex\\projects\\alfred-v5\./);
});

test('git: a finish opens by closing the project\'s VS Code window; a checkpoint is unchanged', async () => {
  const { gitLines } = jest.requireActual('./ApprovePage');
  expect(gitLines({ command: 'gitpush', mode: 'finish', finish: 'phase' }, 'p-a1')[0])
    .toBe('Closes the p-a1 VS Code window, then finishes: runs gitpush finish for p-a1.');
  expect(gitLines({ command: 'gitpush', mode: 'checkpoint', paths: ['a.sql'] }, 'p-a1'))
    .toEqual(['Runs gitpush checkpoint for p-a1.', 'Commits these paths, merges them into main and pushes: a.sql.', 'Releases the database claims.']);
  runner({ preview: reply(GIT) });
  open();
  expect(await screen.findByText(/^Closes the switchboard2-h8r VS Code window, then finishes/)).toBeInTheDocument();
});

test('git: a finish with no_prod_deploy says approving confirms nothing went to production; a plain finish does not (w3k s9)', async () => {
  const NPD = { ...GIT, project_code: 'cd_ab_diagnose-r4m',
    headline: 'GITPUSH FINISH cd_ab_diagnose-r4m: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE; APPROVING CONFIRMS NOTHING FROM CD_AB_DIAGNOSE-R4M WENT TO PRODUCTION',
    payload: { command: 'gitpush', mode: 'finish', finish: 'phase', no_prod_deploy: true } };
  runner({ preview: reply(NPD) });
  const a = open();
  expect(await screen.findByTestId('approve-no-prod-deploy'))
    .toHaveTextContent('Approving confirms nothing from cd_ab_diagnose-r4m went to production.');
  a.unmount();
  runner({ preview: reply(GIT) });
  open();
  await screen.findByText(GIT.headline);
  expect(screen.queryByTestId('approve-no-prod-deploy')).toBeNull();
});

// --- sb setup (spec §11.5) ---

const SB = { ok: true, kind: 'sb_setup', action_id: 's1', headline: 'SB ORG ADD acme-dev FOR CLIENT acme', fingerprint: 'fps',
  project_code: 'switchboard2-h8r',
  payload: { command: 'org add', client: 'acme', orgs: [{ alias: 'acme-dev', type: 'developer', level: 'objects', login: 'admin', cli_deploy: true }] } };

test('sb setup: the answers, the files it writes and the login warning; Approve sends it, marked sb_setup', async () => {
  runner({ preview: reply(SB), approve: reply({ ok: true, action_id: 's1', sent: true }) });
  const { container } = open();
  expect(await screen.findByText(/Org acme-dev: type developer, level objects, login admin, CLI may deploy: yes/)).toBeInTheDocument();
  expect(screen.getByText(/client data may reach claude: no/i)).toBeInTheDocument();
  expect(screen.getByTestId('approve-sb-writes')).toHaveTextContent('Approving writes: orgs.json.');
  expect(screen.getByTestId('approve-sb-writes')).toHaveTextContent(/salesforce login may open/i);
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sb_setup');
  expect(called('dry-run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fps' });
  expect(container.querySelector('[data-switchboard-run-id]')).toHaveAttribute('data-switchboard-run-id', 's1');
  expect(screen.getByText('sb s1')).toBeInTheDocument();
});

test('sb setup: Don\'t run gives the sb cancelled line', async () => {
  runner({ preview: reply(SB), cancel: reply({ ok: true, cancelled: true, reason: '' }) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('sb s1 cancelled')).toBeInTheDocument();
});

test('sb setup: client start lists its source, orgs and every file it writes', () => {
  const { sbLines, sbFiles } = jest.requireActual('./ApprovePage');
  const p = { command: 'client start', client: 'acme', repo: 'https://github.com/a/b.git', project: 'acme-x1', name: 'Acme',
    sandboxes: ['acme-dev'], integration_ok: false,
    orgs: [{ alias: 'acme-dev', type: 'developer', level: 'metadata' }, { alias: 'acme-uat', type: 'partial', level: 'objects', shared: true }] };
  const w = sbLines(p).join(' ');
  expect(w).toMatch(/sb client start for client acme.*Clones https:\/\/github.com\/a\/b.git.*Project: acme-x1.*Panel name: Acme/);
  expect(w).toMatch(/Sandboxes that may run: acme-dev.*integration user: no.*Org acme-dev: type developer, level metadata\..*Org acme-uat: type partial, level objects, shared: yes/);
  expect(sbFiles(p)).toEqual(['repos.json', 'orgs.json', 'projects.json', "the repo's .git/info/exclude"]);
  expect(sbFiles({ ...p, project: undefined })).not.toContain('projects.json');
});

test('sb setup: from_sandbox shows the whole folder it writes and that it must be empty', async () => {
  const folder = 'C:\\Users\\Alex\\projects\\actblue\\acme-nonprofit';
  runner({ preview: reply({ ...SB, project_code: 'sb-acme', payload: { command: 'client start', client: 'acme', from_sandbox: 'acme-dev', folder,
    orgs: SB.payload.orgs } }) });
  open();
  const shown = await screen.findByTestId('approve-sb-folder');
  expect(shown).toHaveTextContent(`Writes the code into ${folder}. The folder must be empty.`);
  expect(screen.getByText(new RegExp(`from sandbox acme-dev into ${folder.replace(/\\/g, '\\\\')}, which must be empty`))).toBeInTheDocument();
});

// --- sf check by link (spec §11.4, s86pa) ---

const SF = { ok: true, kind: 'sf_check', action_id: 'f1', headline: 'SF CHECK: METADATA ApexClass ON SANDBOX acme-dev, READ ONLY',
  fingerprint: 'fpf', project_code: 'sf-acme-dev', payload: { check: 'metadata', alias: 'acme-dev', metadata_type: 'ApexClass' } };

test('sf check: what it runs, no dry run; Approve sends it, marked sf_check', async () => {
  runner({ preview: reply(SF), approve: reply({ ok: true, action_id: 'f1', sent: true }) });
  const { container } = open();
  const lines = await screen.findByTestId('approve-sf');
  expect(lines).toHaveTextContent('Runs sf metadata ApexClass on sandbox acme-dev, read only.');
  expect(lines).toHaveTextContent('The helper first proves it is a sandbox listed in orgs.json; production is refused.');
  expect(lines).toHaveTextContent('Nothing is written.');
  expect(screen.getByText(/An sf check has no dry run/)).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sf_check');
  expect(screen.queryByTestId('approve-sb-writes')).toBeNull();
  expect(called('dry-run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fpf' });
  expect(container.querySelector('[data-switchboard-run-id]')).toHaveAttribute('data-switchboard-run-id', 'f1');
  expect(screen.getByText('sf f1')).toBeInTheDocument();
});

test('sf check: Don\'t run gives the sf cancelled line', async () => {
  runner({ preview: reply(SF), cancel: reply({ ok: true, cancelled: true, reason: '' }) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('sf f1 cancelled')).toBeInTheDocument();
});

test('sf check: lines without a metadata type', () => {
  const { sfLines } = jest.requireActual('./ApprovePage');
  expect(sfLines({ check: 'limits', alias: 'acme-dev' })[0]).toBe('Runs sf limits on sandbox acme-dev, read only.');
});

test('sb setup: no folder line without from_sandbox', async () => {
  runner({ preview: reply(SB) });
  open();
  await screen.findByTestId('approve-sb-writes');
  expect(screen.queryByTestId('approve-sb-folder')).toBeNull();
});

// --- the red bar (s86ag, Alex 2026-11-10): "this page waits for your Approve click"; none when it runs by itself ---

const noGreen = (c) => expect(c.innerHTML).not.toMatch(/green/i);
const SYNC = { ok: true, kind: 'git', action_id: 'g1', headline: 'GITSYNC', fingerprint: 'fpg', project_code: 'p-a1', payload: { command: 'gitsync' } };

test('waits for Approve: red Approval required bar at the very top (sql, sf_check, git)', async () => {
  for (const p of [PREVIEW, { ...SF, stakes: 'none' }, { ...SYNC, stakes: 'none' }, { ...PREVIEW, stakes: 'change' }]) {
    runner({ preview: reply(p), 'dry-run': CLEAN });
    const { container, unmount } = open();
    const head = await screen.findByTestId('run-approval-required');
    expect(head).toHaveTextContent('Approval required');
    expect(head).toHaveClass('bg-red-700', 'w-full');
    expect(container.firstChild.firstChild).toBe(head);
    noGreen(container);
    unmount();
  }
});

test('runs by itself (a sql test): no bar, nothing green', async () => {
  for (const p of [{ ...PREVIEW, test: true }, { ...PREVIEW, test: true, stakes: 'change' }]) {
    runner({ preview: reply(p), 'dry-run': () => reply({ ok: true, test: true, run_id: 'dry1', summary: 'undone' }) });
    const { container, unmount } = open();
    await screen.findByText(p.headline);
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    expect(screen.queryByText(/approval required/i)).toBeNull();
    noGreen(container);
    unmount();
  }
});

test('the bar ignores the url', async () => {
  runner({ preview: reply(SF) });
  const a = openAt('/approve/tok1?kind=sql&stakes=none&exp=1');
  expect(await screen.findByTestId('run-approval-required')).toBeInTheDocument();
  a.unmount();
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': CLEAN });
  openAt('/approve/tok1?kind=sql&stakes=change&exp=1');
  await screen.findByText(PREVIEW.headline);
  expect(screen.queryByTestId('run-approval-required')).toBeNull();
});

test('runsByItself: only a sql test', () => {
  const { runsByItself } = jest.requireActual('./ApprovePage');
  expect(runsByItself({ test: true })).toBe(true);
  expect(runsByItself({ kind: 'sql', test: true })).toBe(true);
  for (const p of [null, {}, { kind: 'sql' }, { test: 'true' }, { kind: 'sf_check', test: true }, { kind: 'git', test: true }, { kind: 'sb_setup' },
    { kind: 'sf_read', test: true }]) {
    expect(runsByItself(p)).toBe(false);
  }
});

// --- s90d: the chained link, and no Approve heading on a test that runs by itself ---

test('chain: a chained git link says it sends the prompt at the tap; a plain one does not', async () => {
  const CHAINED = { ...SYNC, headline: 'GITSYNC p-a1: MERGES MAIN INTO THE WORKTREE, THEN SENDS PROMPT p-a1-s90e-ab12 AT YOUR TAP',
    payload: { command: 'gitsync', then: { send: 'p-a1-s90e-ab12' } } };
  runner({ preview: reply(CHAINED) });
  const a = open();
  expect(await screen.findByTestId('approve-chain')).toHaveTextContent('Then sends the prompt p-a1-s90e-ab12 when you tap the tile.');
  a.unmount();
  runner({ preview: reply(SYNC) });
  open();
  await screen.findByText(SYNC.headline);
  expect(screen.queryByTestId('approve-chain')).toBeNull();
});

// C1 (s19): the "Approve" heading is gone on every page; the red bar says it (inbox note ac562aef).
test('no page has the Approve heading: a sql test, a real sql run, a git link', async () => {
  for (const [p, dry] of [[{ ...PREVIEW, test: true }, () => reply({ ok: true, test: true, run_id: 'dry1', summary: 'undone' })], [PREVIEW, CLEAN], [SYNC, CLEAN]]) {
    runner({ preview: reply(p), 'dry-run': dry });
    const b = open();
    await screen.findByText(p.headline);
    expect(screen.queryByTestId('approve-heading')).toBeNull();
    expect(screen.queryByText(/^approve$/i)).toBeNull();
    expect(screen.getByText('Alfred')).toBeInTheDocument();
    b.unmount();
  }
});

// --- s89e: Salesforce reads (spec 10) ---

const READ_PROD = { alias: 'cd-prod', production: true, level: 'data', object: 'Contribution__c', fields: ['Id', 'Status__c'], limit: 50,
  filters: [{ field: 'Status__c', op: '=', value: 'Failed' }, { field: 'Amount__c', op: 'in', value: [5, 10] }] };
const SFR = { ok: true, kind: 'sf_read', action_id: 'r1', fingerprint: 'fpr', project_code: 'sf-cd-prod', payload: READ_PROD,
  headline: 'PRODUCTION FULL DATA: SF READ DATA ON PRODUCTION cd-prod: 2 FIELDS OF Contribution__c, UP TO 50 ROWS, READ ONLY' };
const SFR_COUNT = { ...SFR, action_id: 'r2', headline: 'SF READ IDS ON SANDBOX ab-dev: A COUNT OF Contact, READ ONLY',
  payload: { alias: 'ab-dev', production: false, level: 'ids', object: 'Contact', count: true } };

test('sf read: org, production, level, object, fields, filters and limit; red bar and PRODUCTION FULL DATA banner', async () => {
  runner({ preview: reply(SFR), approve: reply({ ok: true, action_id: 'r1', sent: true }) });
  const { container } = open();
  const lines = await screen.findByTestId('approve-sf-read');
  expect(lines).toHaveTextContent('Reads PRODUCTION org cd-prod, read only: GET requests, nothing written.');
  expect(lines).toHaveTextContent('Level: data.');
  expect(lines).toHaveTextContent('Object: Contribution__c.');
  expect(lines).toHaveTextContent('Fields: Id, Status__c.');
  expect(lines).toHaveTextContent('Limit: up to 50 rows.');
  expect(lines).toHaveTextContent('Filter 1: Status__c = "Failed"');
  expect(lines).toHaveTextContent('Filter 2: Amount__c in [5,10]');
  expect(screen.getByTestId('run-approval-required')).toHaveTextContent('Approval required');
  const banner = screen.getByTestId('approve-production-full-data');
  expect(banner).toHaveTextContent(/production full data/i);
  expect(banner).toHaveClass('bg-red-700', 'uppercase');
  expect(screen.getByText(/An sf read has no dry run/)).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sf_read');
  expect(called('dry-run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fpr' });
  expect(screen.getByText('sf r1')).toBeInTheDocument();
});

test('sf read: a sandbox count has the red bar but no full-data banner, and says count only', async () => {
  runner({ preview: reply(SFR_COUNT) });
  open();
  const lines = await screen.findByTestId('approve-sf-read');
  expect(lines).toHaveTextContent('Reads sandbox org ab-dev');
  expect(lines).toHaveTextContent('A count only: no rows.');
  expect(lines).toHaveTextContent('Filters: none.');
  expect(screen.getByTestId('run-approval-required')).toBeInTheDocument();
  expect(screen.queryByTestId('approve-production-full-data')).toBeNull();
});

test('sf read: production ids is not full data; Don\'t run gives the sf cancelled line', async () => {
  runner({ preview: reply({ ...SFR_COUNT, payload: { ...SFR_COUNT.payload, production: true } }), cancel: reply({ ok: true, cancelled: true, reason: '' }) });
  open();
  await screen.findByTestId('approve-sf-read');
  expect(screen.queryByTestId('approve-production-full-data')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('sf r2 cancelled')).toBeInTheDocument();
});

test('sf read: lines for the object list and a describe', () => {
  const { sfReadLines, isProductionFullData } = jest.requireActual('./ApprovePage');
  expect(sfReadLines({ alias: 'a', production: false, level: 'objects' })).toContain("The org's object list.");
  const d = sfReadLines({ alias: 'a', production: false, level: 'metadata', object: 'Account' });
  expect(d).toContain('Object: Account.');
  expect(d).toContain("The object's describe: its fields and types, no records.");
  expect(d.some((l) => l.startsWith('Filter'))).toBe(false);
  expect(isProductionFullData(READ_PROD)).toBe(true);
  for (const p of [null, { production: true, level: 'ids' }, { production: false, level: 'data' }, { production: 'true', level: 'data' }]) {
    expect(isProductionFullData(p)).toBe(false);
  }
});

// --- dataops_alfred-d4x A2: a production data run (kind sf_dataop) ---

const STAMP = '0123456789abcdef'.repeat(4);
const DATAOP = { alias: 'cd-prod', repo: 'C:\\Users\\Alex\\projects\\common-defense', plan: 'dataops/fixc-plan.json', stamp: STAMP,
  preflight_at: '2026-11-18T15:00:00Z', object: 'Demo_Gift__c',
  problem: 'Forty-five gifts were saved without a link to their plan, so the plan totals miss them.', expected: 26571,
  write: { kind: 'batch', class: 'FixCLinkBatch' },
  rows: [{ label: 'Gifts in the list with no plan link', before: 26571, goal: 0 },
         { label: 'Gifts in the list still marked as paid', before: 45, goal: 45 },
         { label: 'Plans whose paid total went up today', before: 0, goal: 12, knock_on: true }],
  rehearsal: { sandbox: 'cd-dev1', at: '2026-11-18T16:00:00Z' } };
const DOP = { ok: true, kind: 'sf_dataop', action_id: 'd1', fingerprint: 'fpd', project_code: 'cd_ab_link_installments-q8d', payload: DATAOP,
  headline: 'PRODUCTION DATA RUN cd_ab_link_installments-q8d ON cd-prod: ABOUT TO CHANGE 26,571 LIVE RECORDS OF Demo_Gift__c BY BATCH FixCLinkBatch' };

test('sf_dataop: orange PRODUCTION banner with black text, the count, problem, write, stamp, times and rows', async () => {
  const { localTime } = jest.requireActual('./ApprovePage');
  runner({ preview: reply(DOP), approve: reply({ ok: true, action_id: 'd1', sent: true }) });
  const { container } = open();
  const banner = await screen.findByTestId('approve-production');
  expect(banner).toHaveTextContent(/production, live client data/i);
  expect(banner).toHaveClass('bg-orange-400', 'text-black');
  expect(banner).not.toHaveClass('bg-red-700');
  expect(banner).not.toHaveClass('text-white');
  expect(screen.queryByTestId('approve-production-full-data')).toBeNull();
  expect(screen.getByTestId('approve-dataop-count')).toHaveTextContent('About to change 26,571 live records');
  expect(screen.getByTestId('approve-dataop-problem')).toHaveTextContent(DATAOP.problem);
  expect(screen.getByTestId('approve-dataop-write')).toHaveTextContent('Batch Apex class FixCLinkBatch');
  const stamp = screen.getByTestId('approve-dataop-stamp');
  expect(stamp).toHaveTextContent('0123456789ab');
  expect(stamp).toHaveTextContent(STAMP);
  expect(screen.getByTestId('approve-dataop-preflight')).toHaveTextContent(localTime('2026-11-18T15:00:00Z'));
  expect(screen.getByTestId('approve-dataop-rehearsal')).toHaveTextContent(`Rehearsed on cd-dev1 at ${localTime('2026-11-18T16:00:00Z')}`);
  const rows = screen.getByTestId('approve-dataop-rows').querySelectorAll('tbody tr');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent('Gifts in the list with no plan link26,5710');
  expect(rows[0]).toHaveClass('font-bold');
  expect(rows[1]).not.toHaveClass('font-bold');
  expect(rows[0]).not.toHaveAttribute('data-knock-on');
  expect(rows[2]).toHaveAttribute('data-knock-on');
  expect(rows[2]).toHaveTextContent('Knock-on check: Plans whose paid total went up today');
  expect(screen.getByText(/its sandbox rehearsal was the dry run/)).toBeInTheDocument();
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sf_dataop');
  expect(screen.getByTestId('run-approval-required')).toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(screen.getByText(/within 15 minutes/)).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fpd' });
  expect(screen.getByText('dataop d1')).toBeInTheDocument();
});

test('sf_dataop: bulk, one record, no rehearsal; a knock-on label already prefixed is not doubled', async () => {
  const { rehearsal: _r, ...rest } = DATAOP;
  const payload = { ...rest, expected: 1, write: { kind: 'bulk' },
    rows: [{ label: 'Knock-on check: Plans whose paid total went up today', before: 0, goal: 1, knock_on: true }] };
  runner({ preview: reply({ ...DOP, payload }) });
  open();
  expect(await screen.findByTestId('approve-dataop-count')).toHaveTextContent(/^About to change 1 live record$/);
  expect(screen.getByTestId('approve-dataop-write')).toHaveTextContent('Bulk dataop');
  expect(screen.queryByTestId('approve-dataop-rehearsal')).toBeNull();
  const row = screen.getByTestId('approve-dataop-rows').querySelector('tbody tr');
  expect(row).toHaveTextContent(/^Knock-on check: Plans whose paid total went up today01$/);
});

test('sf_dataop: Don\'t run gives the dataop cancelled line', async () => {
  runner({ preview: reply(DOP), cancel: reply({ ok: true, cancelled: true, reason: 'not today' }) });
  open();
  await screen.findByTestId('approve-dataop');
  fireEvent.change(screen.getByLabelText(/reason for not running/i), { target: { value: 'not today' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('dataop d1 cancelled: not today')).toBeInTheDocument();
});

test('sf_dataop: helpers for the stamp, times and labels', () => {
  const { shortStamp, localTime, rowLabel } = jest.requireActual('./ApprovePage');
  expect(shortStamp(STAMP)).toBe('0123456789ab');
  expect(shortStamp(undefined)).toBe('');
  expect(localTime('not a time')).toBe('not a time');
  expect(rowLabel({ label: 'Plans up', knock_on: true })).toBe('Knock-on check: Plans up');
  expect(rowLabel({ label: 'Plans up' })).toBe('Plans up');
});

test('the other kinds have no orange banner and no data-run panel', async () => {
  for (const preview of [SFR, { ...PREVIEW, kind: 'git', payload: { command: 'gitsync' } }]) {
    runner({ preview: reply(preview) });
    const { unmount } = open();
    await screen.findByTestId(preview.kind === 'sf_read' ? 'approve-sf-read' : 'approve-git');
    expect(screen.queryByTestId('approve-production')).toBeNull();
    expect(screen.queryByTestId('approve-dataop')).toBeNull();
    expect(screen.getByText(/has no dry run\. Approve runs this once, on your computer\./)).toBeInTheDocument();
    unmount();
  }
});

// --- dataop_link-k7d A1: production exports and counts (kind sf_dataquery) ---

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const REQ = 'c'.repeat(64);
const SEL = "SELECT Id, GiftCommitmentId FROM GiftTransaction\nWHERE Source__c = 'ActBlue'\n";
const DQ_BASE = { alias: 'cd-prod', org_type: 'production', repo: 'C:\\Users\\Alex\\projects\\common-defense', run: 'data-ops/cd_fixc-q8d/fixc-2026-11-19',
  run_tag: 'cd_fixc-q8d-s4-ab12', request_sha256: REQ };
const DQ_EXPORT = { ...DQ_BASE, queries: [{ step: 'manifest', soql: SEL, sha256: H1, file: 'selection.soql' },
  { step: 'undo', soql: `\n\t  ${SEL}`, sha256: H2, file: 'selection.soql' }] };
const DQ_COUNT = { ...DQ_BASE, queries: [
  { step: 'rules', soql: "SELECT COUNT() FROM GiftTransaction WHERE Source__c = 'ActBlue' AND GiftCommitmentId = null", sha256: H1,
    label: 'Installments with no gift commitment' }] };
const DQ = (payload) => ({ ok: true, kind: 'sf_dataquery', action_id: 'q1', fingerprint: 'fpq', project_code: 'cd_fixc-q8d', payload,
  headline: 'PRODUCTION EXPORT cd_fixc-q8d ON cd-prod: 2 QUERIES (manifest, undo), READ ONLY', expires_at: '2026-11-19T12:30:00Z' });

test('sf_dataquery: orange PRODUCTION, READ ONLY banner saying exports; org, repo, run folder, run tag and request hash', async () => {
  runner({ preview: reply(DQ(DQ_EXPORT)), approve: reply({ ok: true, action_id: 'q1', sent: true }) });
  const { container } = open();
  const banner = await screen.findByTestId('approve-production-read');
  expect(banner).toHaveTextContent(/production, read only/i);
  expect(banner).toHaveClass('bg-orange-400', 'text-black');
  expect(screen.getByTestId('approve-production-read-mode')).toHaveTextContent('Bulk exports');
  expect(screen.queryByTestId('approve-production')).toBeNull();
  expect(screen.queryByTestId('approve-dataop')).toBeNull();
  expect(screen.getByTestId('approve-dataquery')).toHaveAttribute('data-dataquery-mode', 'exports');
  expect(screen.getByTestId('approve-dataquery-mode')).toHaveTextContent('Exports 2 queries to files on your computer');
  expect(screen.getByTestId('approve-dataquery-alias')).toHaveTextContent('cd-prod');
  expect(screen.getByTestId('approve-dataquery-repo')).toHaveTextContent('C:\\Users\\Alex\\projects\\common-defense');
  expect(screen.getByTestId('approve-dataquery-run')).toHaveTextContent('data-ops/cd_fixc-q8d/fixc-2026-11-19');
  expect(screen.getByTestId('approve-dataquery-run-tag')).toHaveTextContent('cd_fixc-q8d-s4-ab12');
  const req = screen.getByTestId('approve-dataquery-request');
  expect(req.querySelector('summary')).toHaveTextContent('cccccccccccc…');
  expect(req.querySelector('summary')).toHaveAttribute('title', REQ);
  expect(req).toHaveTextContent(REQ);
  expect(screen.getByTestId('approve-dataquery-returns')).toHaveTextContent(/one count per query \(the rows exported\) and a pass or fail/);
  expect(screen.getByTestId('approve-dataquery-returns')).toHaveTextContent(/No rows, Ids or field values reach Alfred/);
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sf_dataquery');
  expect(screen.queryByTestId('approve-sandbox-read')).toBeNull();
  expect(screen.queryByTestId('approve-org-type-missing')).toBeNull();
  expect(screen.getByTestId('run-approval-required')).toBeInTheDocument();
  expect(screen.getByText(/A production read has no dry run/)).toBeInTheDocument();
  expect(called('dry-run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(screen.getByText(/within 15 minutes/)).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fpq' });
  expect(screen.getByText('dataquery q1')).toBeInTheDocument();
});

test('sf_dataquery: each query in order with its step, file or label, short and full hash, and its SOQL whole with blank space kept', async () => {
  runner({ preview: reply(DQ(DQ_EXPORT)) });
  open();
  const items = await screen.findAllByTestId('approve-dataquery-query');
  expect(items.map((li) => li.getAttribute('data-step'))).toEqual(['manifest', 'undo']);
  expect(items[0].querySelector('[data-testid="approve-dataquery-source"]')).toHaveTextContent('File selection.soql');
  const sha = items[1].querySelector('[data-testid="approve-dataquery-sha"]');
  expect(sha.querySelector('summary')).toHaveTextContent('bbbbbbbbbbbb…');
  expect(sha.querySelector('summary')).toHaveAttribute('title', H2);
  expect(sha).toHaveTextContent(H2);
  const soql = screen.getAllByTestId('approve-dataquery-soql');
  expect(soql[0].textContent).toBe(SEL);
  expect(soql[1].textContent).toBe(`\n\t  ${SEL}`);
  expect(soql[1].tagName).toBe('PRE');
  expect(soql[1]).toHaveClass('whitespace-pre-wrap', 'break-words', 'font-mono');
});

test('sf_dataquery: a count link says counts, shows the rule label, and keeps no request row without its hash', async () => {
  const { request_sha256: _r, ...noReq } = DQ_COUNT;
  runner({ preview: reply(DQ({ ...noReq, queries: [{ ...DQ_COUNT.queries[0], file: 'rules.soql', label: undefined }] })) });
  const first = open();
  await screen.findByTestId('approve-dataquery');
  expect(screen.queryByTestId('approve-dataquery-request')).toBeNull();
  first.unmount();
  runner({ preview: reply(DQ(DQ_COUNT)) });
  open();
  expect(await screen.findByTestId('approve-production-read-mode')).toHaveTextContent('Counts');
  expect(screen.getByTestId('approve-dataquery')).toHaveAttribute('data-dataquery-mode', 'counts');
  expect(screen.getByTestId('approve-dataquery-mode')).toHaveTextContent('Counts 1 query');
  expect(screen.getByTestId('approve-dataquery-source')).toHaveTextContent('Rule Installments with no gift commitment');
  expect(screen.getByTestId('approve-dataquery-step')).toHaveTextContent('rules');
  expect(screen.getByTestId('approve-dataquery-returns')).toHaveTextContent(/\(the COUNT\(\)\)/);
});

test('sf_dataquery: a 100,000-character export is shown whole, never cut', async () => {
  const long = `SELECT Id FROM Contact WHERE Name != '${'x'.repeat(99950)}'`;
  runner({ preview: reply(DQ({ ...DQ_BASE, queries: [{ step: 'before', soql: long, sha256: H1, label: 'broad snapshot' }] })) });
  open();
  const pre = await screen.findByTestId('approve-dataquery-soql');
  expect(pre.textContent).toHaveLength(long.length);
  expect(pre.textContent).toBe(long);
  expect(pre).toHaveClass('break-words', 'max-w-full');
});

test('sf_dataquery: SOQL wraps between words (break-words, overflow-wrap), never mid-word by break-all; text kept whole', async () => {
  const soql = "SELECT COUNT() FROM GiftTransaction WHERE Source__c = 'ActBlue' AND GiftCommitmentId = null AND CreatedDate > 2026-11-18T00:00:00Z";
  runner({ preview: reply(DQ({ ...DQ_BASE, queries: [{ step: 'rules', soql: `\n  ${soql}\n`, sha256: H1, label: 'New since the freeze' }] })) });
  open();
  const pre = await screen.findByTestId('approve-dataquery-soql');
  // whitespace-pre-wrap keeps blank space and line breaks and wraps at spaces; break-words (overflow-wrap: break-word)
  // breaks inside a word only when that one word is wider than the box. break-all would split "AND" as "A" / "ND".
  expect(pre).toHaveClass('whitespace-pre-wrap', 'break-words');
  expect(pre).not.toHaveClass('break-all');
  expect(pre.className).not.toMatch(/break-all|word-break|truncate|line-clamp|overflow-hidden|max-h-/);
  expect(pre.textContent).toBe(`\n  ${soql}\n`);
});

test('sf_dataquery: Don\'t run gives the dataquery cancelled line; an expired link says so and runs nothing', async () => {
  runner({ preview: reply(DQ(DQ_COUNT)), cancel: reply({ ok: true, cancelled: true, reason: 'wrong round' }) });
  const first = open();
  await screen.findByTestId('approve-dataquery');
  fireEvent.change(screen.getByLabelText(/reason for not running/i), { target: { value: 'wrong round' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('dataquery q1 cancelled: wrong round')).toBeInTheDocument();
  first.unmount();
  runner({ preview: reply({ ok: false, error: 'this link has expired.' }, 409) });
  open();
  expect(await screen.findByText(/This link has expired\. Links last 30 minutes\. Nothing ran\./)).toBeInTheDocument();
});

// dataquery_fixes-v3n: the banner follows org_type.
test('sf_dataquery org_type sandbox: a sky-blue SANDBOX, READ ONLY banner, never orange, red or the word production', async () => {
  runner({ preview: reply({ ...DQ({ ...DQ_COUNT, alias: 'actblue', org_type: 'sandbox' }),
    headline: 'SANDBOX COUNTS cd_fixc-q8d ON actblue: 1 QUERY (rules), READ ONLY' }) });
  open();
  const banner = await screen.findByTestId('approve-sandbox-read');
  expect(banner).toHaveTextContent(/sandbox, read only/i);
  expect(banner).toHaveTextContent(/counts/i);
  expect(banner).toHaveClass('bg-sky-700', 'text-white');
  expect(banner.className).not.toMatch(/orange|red/);
  expect(banner).not.toHaveTextContent(/production/i);
  expect(screen.getByTestId('approve-sandbox-read-mode')).toHaveTextContent('Counts');
  expect(screen.queryByTestId('approve-production-read')).toBeNull();
  expect(screen.queryByTestId('approve-production')).toBeNull();
  expect(screen.queryByTestId('approve-org-type-missing')).toBeNull();
  expect(screen.getByText('SANDBOX COUNTS cd_fixc-q8d ON actblue: 1 QUERY (rules), READ ONLY')).toBeInTheDocument();
  expect(screen.getByTestId('approve-dataquery')).toHaveAttribute('data-dataquery-mode', 'counts');
});

test('sf_dataquery with no org_type (an old link): the orange PRODUCTION banner plus "org type not recorded"', async () => {
  const { org_type: _o, ...old } = DQ_EXPORT;
  runner({ preview: reply(DQ(old)) });
  open();
  const banner = await screen.findByTestId('approve-production-read');
  expect(banner).toHaveTextContent(/production, read only/i);
  expect(banner).toHaveClass('bg-orange-400', 'text-black');
  expect(screen.getByTestId('approve-org-type-missing')).toHaveTextContent(/org type not recorded/i);
  expect(banner).toContainElement(screen.getByTestId('approve-org-type-missing'));
  expect(screen.queryByTestId('approve-sandbox-read')).toBeNull();
});

test('sf_dataquery: dataqueryOrgType takes only the two values', () => {
  const { dataqueryOrgType } = jest.requireActual('./ApprovePage');
  expect(dataqueryOrgType({ org_type: 'sandbox' })).toBe('sandbox');
  expect(dataqueryOrgType({ org_type: 'production' })).toBe('production');
  for (const p of [{}, null, undefined, { org_type: 'Sandbox' }, { org_type: '' }, { org_type: true }]) expect(dataqueryOrgType(p)).toBeNull();
});

test('sf_dataquery: helpers for the mode and the short hash', () => {
  const { dataqueryMode, shortHash } = jest.requireActual('./ApprovePage');
  expect(dataqueryMode(DQ_EXPORT)).toBe('exports');
  expect(dataqueryMode({ queries: [{ step: 'undo' }] })).toBe('exports');
  expect(dataqueryMode(DQ_COUNT)).toBe('counts');
  expect(dataqueryMode({ queries: [{ step: 'preflight-counts' }] })).toBe('counts');
  expect(shortHash(H1)).toBe('a'.repeat(12));
  expect(shortHash(undefined)).toBe('');
});

test('the other kinds have no read-only banner and no dataquery panel; sf_dataop keeps its own', async () => {
  for (const preview of [DOP, SFR, { ...PREVIEW, kind: 'git', payload: { command: 'gitsync' } }]) {
    runner({ preview: reply(preview) });
    const { unmount } = open();
    await screen.findByTestId(preview.kind === 'sf_read' ? 'approve-sf-read' : preview.kind === 'sf_dataop' ? 'approve-dataop' : 'approve-git');
    expect(screen.queryByTestId('approve-production-read')).toBeNull();
    expect(screen.queryByTestId('approve-sandbox-read')).toBeNull();
    expect(screen.queryByTestId('approve-dataquery')).toBeNull();
    unmount();
  }
});

// --- dataop_write-j5w A2: Data run v2's write link (kind sf_datawrite) ---

const H3 = 'd'.repeat(64);
const H4 = 'e'.repeat(64);
const SELSHA = 'f'.repeat(64);
const BROAD = "SELECT Id, GiftCommitmentId, Amount, LastModifiedById FROM GiftTransaction\nWHERE Source__c = 'ActBlue'";
const IDS12 = Array.from({ length: 12 }, (_, i) => `'a0D5e00000${String(i + 1).padStart(5, '0')}AAA'`).join(', ');
const BROAD12 = `SELECT Id, Amount, LastModifiedById FROM GiftTransaction WHERE Id IN (${IDS12})`;
const WAIT_SOQL = 'SELECT COUNT() FROM GiftCommitment WHERE Rollup_Pending__c = true';
const DW_BASE = { alias: 'cd-prod', org_type: 'production', repo: 'C:\\Users\\Alex\\projects\\common-defense',
  run: 'data-ops/cd_fixc-q8d/fixc-2026-11-19', run_tag: 'cd_fixc-q8d-s9-ab12', request_sha256: REQ, selection_sha256: SELSHA,
  object: 'GiftTransaction', problem: 'Forty-five installments were saved without a link to their gift commitment.', expected: 45 };
const DW_BATCH = { ...DW_BASE, write: { kind: 'batch', class: 'FixCLinkBatch' },
  uploads: [{ purpose: 'exclude', file: 'exclude.csv', sha256: H3, rows: 3 }],
  queries: [
    { step: 'gate', soql: SEL, sha256: SELSHA, file: 'selection.soql' },
    { step: 'gate', soql: BROAD, sha256: H1, label: 'gate: broad snapshot' },
    { step: 'after', soql: BROAD, sha256: H1, label: 'after: broad snapshot' },
    { step: 'after', soql: SEL, sha256: SELSHA, label: 'after: selection' },
    { step: 'after-counts', soql: "SELECT COUNT() FROM GiftTransaction WHERE Source__c = 'ActBlue' AND GiftCommitmentId = null", sha256: H2,
      label: 'Installments with no gift commitment' },
    { step: 'after-counts', soql: WAIT_SOQL, sha256: H4, label: 'Commitments whose totals are updating: wait',
      wait: { stable_minutes: 2, limit_minutes: 30 } },
  ] };
const DW_BULK = { ...DW_BASE, alias: 'actblue', org_type: 'sandbox', write: { kind: 'bulk', operation: 'update', csv: 'update.csv', csv_sha256: H3 },
  queries: [{ step: 'gate', soql: SEL, sha256: SELSHA, file: 'selection.soql' },
    { step: 'after', soql: BROAD, sha256: H1, label: 'after: broad snapshot' }] };
const DW_UNDO = { ...DW_BASE, expected: 12, write: { kind: 'undo', class: 'FixCUndoBatch', ids_file: 'undo-ids.csv', ids_sha256: H4 },
  uploads: [{ purpose: 'undo-ids', file: 'undo-ids.csv', sha256: H4, rows: 12 }],
  queries: [{ step: 'gate', soql: BROAD12, sha256: H1, label: 'gate: broad snapshot' },
    { step: 'after', soql: BROAD12, sha256: H1, label: 'after: broad snapshot' }] };
const DW = (payload, headline = 'PRODUCTION DATA WRITE cd_fixc-q8d ON cd-prod: ABOUT TO CHANGE 45 LIVE RECORDS OF GiftTransaction BY BATCH FixCLinkBatch') =>
  ({ ok: true, kind: 'sf_datawrite', action_id: 'w1', fingerprint: 'fpw', project_code: 'cd_fixc-q8d', payload, headline,
    expires_at: '2026-11-19T12:30:00Z' });
const text = (id) => screen.getByTestId(id).textContent;

test('sf_datawrite production: orange PRODUCTION banner, the plain sentence, every field in full', async () => {
  runner({ preview: reply(DW(DW_BATCH)), approve: reply({ ok: true, action_id: 'w1', sent: true }) });
  const { container } = open();
  const banner = await screen.findByTestId('approve-production-write');
  expect(banner).toHaveTextContent(/production, changes live records/i);
  expect(banner).toHaveClass('bg-orange-400', 'text-black');
  expect(screen.queryByTestId('approve-sandbox-write')).toBeNull();
  expect(screen.queryByTestId('approve-production')).toBeNull();
  expect(screen.queryByTestId('approve-production-read')).toBeNull();
  expect(text('approve-datawrite-sentence')).toBe('This changes 45 live records of GiftTransaction in cd-prod.');
  expect(text('approve-datawrite-problem')).toBe(DW_BASE.problem);
  expect(text('approve-datawrite-alias')).toBe('cd-prod');
  expect(text('approve-datawrite-object')).toBe('GiftTransaction');
  expect(text('approve-datawrite-repo')).toBe('C:\\Users\\Alex\\projects\\common-defense');
  expect(text('approve-datawrite-run')).toBe('data-ops/cd_fixc-q8d/fixc-2026-11-19');
  expect(text('approve-datawrite-run-tag')).toBe('cd_fixc-q8d-s9-ab12');
  expect(text('approve-datawrite-request')).toContain(REQ);
  expect(text('approve-datawrite-selection')).toContain(SELSHA);
  expect(text('approve-datawrite-write')).toBe('Batch Apex class FixCLinkBatch: new FixCLinkBatch(), runs SELECTION = selection.soql');
  // Nothing folded away: no <details> in the write panel.
  expect(screen.getByTestId('approve-datawrite').querySelector('details')).toBeNull();
  expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'sf_datawrite');
  expect(screen.getByText(/A data write has no dry run here/)).toHaveTextContent(/against the live org/);
  expect(called('dry-run')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(JSON.parse(called('approve')[0][1].body)).toEqual({ token: 'tok1', fingerprint: 'fpw' });
  expect(screen.getByText('datawrite w1')).toBeInTheDocument();
});

test('sf_datawrite: every query in order under its step, with its label or file, full SOQL, full hash and its wait', async () => {
  runner({ preview: reply(DW(DW_BATCH)) });
  open();
  await screen.findByTestId('approve-datawrite');
  const stages = screen.getAllByTestId('approve-datawrite-stage');
  expect(stages.map((s) => s.getAttribute('data-step'))).toEqual(['gate', 'after', 'after-counts']);
  expect(stages.map((s) => s.querySelector('h2').textContent)).toEqual(['Gate', 'After', 'After counts']);
  const qs = screen.getAllByTestId('approve-datawrite-query');
  expect(qs.map((q) => q.getAttribute('data-step'))).toEqual(DW_BATCH.queries.map((q) => q.step));
  qs.forEach((q, i) => {
    const want = DW_BATCH.queries[i];
    expect(q.querySelector('[data-testid="approve-datawrite-soql"]').textContent).toBe(want.soql);
    expect(q.querySelector('[data-testid="approve-datawrite-sha"]').textContent).toContain(want.sha256);
    expect(q.querySelector('[data-testid="approve-datawrite-source"]').textContent).toBe(want.file ? `File ${want.file}` : want.label);
    expect(q.textContent.startsWith(`${i + 1}.`)).toBe(true);
  });
  expect(screen.getAllByTestId('approve-datawrite-wait')).toHaveLength(1);
  expect(text('approve-datawrite-wait')).toBe('Waits until the count is steady for 2 minutes, for at most 30 minutes.');
  expect(screen.queryByTestId('approve-datawrite-ids')).toBeNull();
});

test('sf_datawrite: the files it writes to production, with the fixed titles, and the leftover line', async () => {
  runner({ preview: reply(DW(DW_BATCH)) });
  open();
  await screen.findByTestId('approve-datawrite-files');
  expect(screen.getByTestId('approve-datawrite-files').querySelector('h2')).toHaveTextContent('Files the run writes to production');
  const up = screen.getByTestId('approve-datawrite-upload');
  expect(up).toHaveAttribute('data-purpose', 'exclude');
  expect(up.querySelector('[data-testid="approve-datawrite-upload-title"]').textContent).toBe('dataop-exclude:FixCLinkBatch');
  expect(up).toHaveTextContent('exclude.csv (3 rows)');
  expect(up.querySelector('[data-testid="approve-datawrite-upload-sha"]').textContent).toContain(H3);
  // s6b: exclude.csv once. The upload is listed, so the "if you leave records out" line is not.
  expect(screen.queryByTestId('approve-datawrite-exclude')).toBeNull();
  expect(screen.getByTestId('approve-datawrite-files').textContent.match(/exclude\.csv/g)).toHaveLength(1);
  expect(text('approve-datawrite-failures')).toBe('Creates the failure file, a ContentVersion titled dataop-failures:FixCLinkBatch:<18-character job Id>');
  expect(text('approve-datawrite-failures-title')).toBe('dataop-failures:FixCLinkBatch:<18-character job Id>');
  expect(text('approve-datawrite-leftover')).toBe("A file left over from a run that wasn't closed out makes the helper refuse to start; sb closeout clears it.");
  const after = screen.getByTestId('approve-datawrite-after');
  for (const line of [/pick the run up within 15 minutes/, /runs the gate first/, /asks for Enter before the live write and before any upload; q stops it with nothing changed/,
    /limited to 4 hours/, /Only counts and PASS or FAIL come back to Alfred/]) expect(after).toHaveTextContent(line);
});

test('sf_datawrite: with no exclude upload, the page says exclude.csv once, as "if you leave records out at the gate"', async () => {
  const { uploads: _u, ...noUploads } = DW_BATCH;
  runner({ preview: reply(DW(noUploads)) });
  open();
  await screen.findByTestId('approve-datawrite-files');
  expect(screen.queryByTestId('approve-datawrite-upload')).toBeNull();
  expect(text('approve-datawrite-exclude')).toBe('exclude.csv, if you leave records out at the gate, titled dataop-exclude:FixCLinkBatch');
  expect(screen.getByTestId('approve-datawrite-files').textContent.match(/exclude\.csv/g)).toHaveLength(1);
  expect(screen.getByTestId('approve-datawrite-leftover')).toBeInTheDocument();
});

test('sf_datawrite sandbox batch: Enter "before the write", never "live write"; uploads still named', async () => {
  runner({ preview: reply(DW({ ...DW_BATCH, alias: 'actblue', org_type: 'sandbox' })) });
  open();
  const after = await screen.findByTestId('approve-datawrite-after');
  expect(after).toHaveTextContent(/asks for Enter before the write and before any upload; q stops it with nothing changed/);
  expect(after).not.toHaveTextContent(/live write/);
  expect(screen.getByTestId('approve-datawrite-files').querySelector('h2')).toHaveTextContent('Files the run writes to the sandbox');
});

test('sf_datawrite sandbox: a sky-blue SANDBOX banner, "sandbox records", never orange or the word production', async () => {
  runner({ preview: reply(DW(DW_BULK, 'SANDBOX DATA WRITE cd_fixc-q8d ON actblue: ABOUT TO CHANGE 45 RECORDS OF GiftTransaction BY BULK UPDATE')) });
  open();
  const banner = await screen.findByTestId('approve-sandbox-write');
  expect(banner).toHaveTextContent(/sandbox, changes records/i);
  expect(banner).toHaveClass('bg-sky-700', 'text-white');
  expect(banner.className).not.toMatch(/orange|red/);
  expect(banner).not.toHaveTextContent(/production/i);
  expect(screen.queryByTestId('approve-production-write')).toBeNull();
  expect(text('approve-datawrite-sentence')).toBe('This changes 45 sandbox records of GiftTransaction in actblue.');
  expect(text('approve-datawrite-write')).toBe(`Bulk update from update.csv${'d'.repeat(12)}${H3}`);
  expect(text('approve-datawrite-csv-sha')).toContain(H3);
  // s6b: a bulk write uploads nothing. Left-out records come out of the CSV; no file lines, no leftover line, and a
  // title that doesn't claim the run writes files.
  const files = screen.getByTestId('approve-datawrite-files');
  expect(files.querySelector('h2')).toHaveTextContent('Records left out at the gate');
  expect(files).not.toHaveTextContent(/Files the run writes/);
  expect(text('approve-datawrite-bulk-exclude')).toBe('Records left out at the gate are removed from the CSV before the write.');
  for (const id of ['approve-datawrite-upload', 'approve-datawrite-exclude', 'approve-datawrite-failures', 'approve-datawrite-leftover']) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
  const after = screen.getByTestId('approve-datawrite-after');
  expect(after).toHaveTextContent(/asks for Enter before the write; q stops it with nothing changed/);
  expect(after).not.toHaveTextContent(/live write|upload/);
  expect(screen.getByText(/against the sandbox/)).toBeInTheDocument();
  expect(screen.queryByText(/live records/)).toBeNull();
});

test('sf_datawrite undo: the reverse class, the Id file with its hash and rows, dataop-undo:<Class>, and the 12 Ids', async () => {
  runner({ preview: reply(DW(DW_UNDO, 'PRODUCTION DATA WRITE cd_fixc-q8d ON cd-prod: ABOUT TO CHANGE 12 LIVE RECORDS OF GiftTransaction BY UNDO FixCUndoBatch')) });
  open();
  await screen.findByTestId('approve-production-write');
  expect(text('approve-datawrite-sentence')).toBe('This changes 12 live records of GiftTransaction in cd-prod.');
  expect(text('approve-datawrite-write')).toContain('Undo: reverse batch FixCUndoBatch reading undo-ids.csv, 12 rows');
  expect(text('approve-datawrite-ids-sha')).toContain(H4);
  expect(text('approve-datawrite-ids-rows')).toBe('12 rows');
  const up = screen.getByTestId('approve-datawrite-upload');
  expect(up).toHaveAttribute('data-purpose', 'undo-ids');
  expect(up.querySelector('[data-testid="approve-datawrite-upload-title"]').textContent).toBe('dataop-undo:FixCUndoBatch');
  expect(screen.queryByTestId('approve-datawrite-exclude')).toBeNull();
  expect(text('approve-datawrite-failures-title')).toBe('dataop-failures:FixCUndoBatch:<18-character job Id>');
  const ids = screen.getAllByTestId('approve-datawrite-ids');
  expect(ids).toHaveLength(2);
  for (const n of ids) expect(n.textContent).toBe('This query lists 12 record Ids.');
  expect(screen.getAllByTestId('approve-datawrite-soql')[0].textContent).toBe(BROAD12);
});

// s10: any query that lists Ids says how many, an after-count included; one with none says nothing.
test('sf_datawrite: an after-count that lists Ids says "This query lists N record Ids."', async () => {
  const withIds = { ...DW_BATCH, queries: DW_BATCH.queries.map((q) => (q.step === 'after-counts' && !q.wait
    ? { ...q, soql: "SELECT COUNT() FROM GiftTransaction WHERE Id IN ('a0D000000000001AAA','a0D000000000002AAA')" } : q)) };
  runner({ preview: reply(DW(withIds)) });
  open();
  await screen.findByTestId('approve-datawrite');
  const ids = screen.getAllByTestId('approve-datawrite-ids');
  expect(ids).toHaveLength(1);
  expect(ids[0].textContent).toBe('This query lists 2 record Ids.');
  expect(ids[0].closest('[data-testid="approve-datawrite-query"]')).toHaveAttribute('data-step', 'after-counts');
});

test('sf_datawrite: Don\'t run gives the datawrite cancelled line', async () => {
  runner({ preview: reply(DW(DW_BATCH)), cancel: reply({ ok: true, cancelled: true, reason: 'not today' }) });
  open();
  await screen.findByTestId('approve-datawrite');
  fireEvent.change(screen.getByLabelText(/reason for not running/i), { target: { value: 'not today' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('datawrite w1 cancelled: not today')).toBeInTheDocument();
});

test('sf_datawrite: helpers for the org type, the Id count, the titles and the sentence', () => {
  const { datawriteOrgType, datawriteIdCount, datawriteUploadTitle, datawriteSentence } = jest.requireActual('./ApprovePage');
  expect(datawriteOrgType({ org_type: 'sandbox' })).toBe('sandbox');
  for (const p of [{ org_type: 'production' }, {}, null, { org_type: 'Sandbox' }]) expect(datawriteOrgType(p)).toBe('production');
  expect(datawriteIdCount(BROAD12)).toBe(12);
  expect(datawriteIdCount("WHERE Id = 'a0D000000000001' OR Name = 'Closed Won' OR Name = 'a0D0000000000012'")).toBe(1);
  expect(datawriteUploadTitle('exclude', { kind: 'batch', class: 'X' })).toBe('dataop-exclude:X');
  expect(datawriteUploadTitle('undo-ids', { kind: 'undo', class: 'Y' })).toBe('dataop-undo:Y');
  expect(datawriteUploadTitle('exclude', { kind: 'bulk' })).toBeNull();
  expect(datawriteSentence({ ...DW_BASE, expected: 1 })).toBe('This changes 1 live record of GiftTransaction in cd-prod.');
  expect(datawriteSentence({ ...DW_BASE, expected: 26571 })).toBe('This changes 26,571 live records of GiftTransaction in cd-prod.');
});

test('sf_dataop and sf_dataquery pages are unchanged: no write banner or datawrite panel', async () => {
  for (const preview of [DOP, DQ(DQ_EXPORT), DQ({ ...DQ_COUNT, org_type: 'sandbox' })]) {
    runner({ preview: reply(preview) });
    const { unmount } = open();
    await screen.findByTestId(preview.kind === 'sf_dataop' ? 'approve-dataop' : 'approve-dataquery');
    expect(screen.queryByTestId('approve-production-write')).toBeNull();
    expect(screen.queryByTestId('approve-sandbox-write')).toBeNull();
    expect(screen.queryByTestId('approve-datawrite')).toBeNull();
    if (preview.kind === 'sf_dataop') expect(screen.getByTestId('approve-production')).toHaveTextContent('Production, live client data');
    else expect(screen.getByTestId(preview.payload.org_type === 'sandbox' ? 'approve-sandbox-read' : 'approve-production-read')).toBeInTheDocument();
    unmount();
  }
});

test('sf read: a metadata read of several objects lists them', () => {
  const { sfReadLines } = jest.requireActual('./ApprovePage');
  const lines = sfReadLines({ alias: 'cd-prod', production: true, level: 'metadata', objects: ['Contact', 'Account'] });
  expect(lines).toContain('Objects (2): Contact, Account.');
  expect(lines.some((l) => l.startsWith('Object:'))).toBe(false);
});

// sb3_pages-h6v C1 (s19): today's page takes look.js's look and drops the "Approve" heading, with no behaviour change.
// Every kind's data-switchboard-* marks (the extension's) and its result line are pinned as they were before C1.
describe('C1: every kind keeps its marks and its result line, and never shows the SIMULATION strip', () => {
  const marksOf = (c) => [...c.querySelectorAll('*')].flatMap((el) => [...el.attributes]
    .filter((a) => a.name.startsWith('data-switchboard')).map((a) => `${a.name}=${a.value}`));
  const lineOf = () => screen.getByTitle('Copy this line for the chat').parentElement.querySelector('code').textContent;
  // [preview, the kind mark, its project mark, the id the line carries once approved, the line's word]: as before C1.
  const KINDS = {
    sql: [PREVIEW, 'sql', 'switchboard2-h8r', DRY, 'sql'],
    git: [GIT, 'git', 'switchboard2-h8r', 'g1', 'git'],
    sb_setup: [SB, 'sb_setup', 'switchboard2-h8r', 's1', 'sb'],
    sf_check: [SF, 'sf_check', 'sf-acme-dev', 'f1', 'sf'],
    sf_read: [SFR, 'sf_read', 'sf-cd-prod', 'r1', 'sf'],
    'sf_dataquery production': [DQ(DQ_EXPORT), 'sf_dataquery', 'cd_fixc-q8d', 'q1', 'dataquery'],
    'sf_dataquery sandbox': [DQ({ ...DQ_EXPORT, org_type: 'sandbox' }), 'sf_dataquery', 'cd_fixc-q8d', 'q1', 'dataquery'],
    sf_dataop: [DOP, 'sf_dataop', 'cd_ab_link_installments-q8d', 'd1', 'dataop'],
    'sf_datawrite batch': [DW(DW_BATCH), 'sf_datawrite', 'cd_fixc-q8d', 'w1', 'datawrite'],
    'sf_datawrite bulk': [DW(DW_BULK), 'sf_datawrite', 'cd_fixc-q8d', 'w1', 'datawrite'],
    'sf_datawrite undo': [DW(DW_UNDO), 'sf_datawrite', 'cd_fixc-q8d', 'w1', 'datawrite'],
  };
  const STATUS = ['data-switchboard-status=', 'data-switchboard-status-text=', 'data-switchboard-retry='];
  const pinned = (kind, project, id, extra = []) => [`data-switchboard-project=${project}`, `data-switchboard-kind=${kind}`,
    `data-switchboard-run-id=${id}`, ...extra, ...STATUS];
  const noStrip = (c) => {
    expect(screen.queryByTestId('run-simulation')).toBeNull();
    expect(c.querySelector('[data-switchboard-simulation]')).toBeNull();
    expect(screen.queryByText(/^simulation$/i)).toBeNull();
  };

  test.each(Object.keys(KINDS))('%s, approved: running while it waits, then its marks and line', async (name) => {
    const [p, kind, project, id, word] = KINDS[name];
    let finish;
    runner({ preview: reply(p), 'dry-run': CLEAN, approve: () => new Promise((r) => { finish = r; }) });
    const { container } = open();
    noStrip(container);
    // Waits for the click: the red bar, and no "Approve" heading.
    const approve = await approveOn();
    expect(screen.getByTestId('run-approval-required')).toHaveTextContent(/^Approval required$/);
    fireEvent.click(approve);
    await waitFor(() => expect(container.querySelector('[data-switchboard-running]')).not.toBeNull());
    // While the approval is under way: the running mark (the url's kind for sql, the runner's kind otherwise) and the
    // project and kind marks, nothing else.
    expect(marksOf(container)).toEqual([`data-switchboard-running=${kind}`, `data-switchboard-project=${project}`, `data-switchboard-kind=${kind}`]);
    finish(await reply(kind === 'sql' ? { ok: true, run_id: DRY, summary: 'done' } : { ok: true, sent: true }));
    await screen.findByText('Paste this into the Claude chat, then close this tab.');
    noStrip(container);
    expect(marksOf(container)).toEqual(pinned(kind, project, id));
    expect(lineOf()).toBe(`${word} ${id}`);
    // s19c: once approved nothing waits for a click, so the bar is gone (before s19c it stayed: spec 14.6).
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    // The extension fills the text and shows Try again inside the hidden status block.
    const status = container.querySelector('[data-switchboard-status]');
    expect(status).toHaveAttribute('hidden');
    expect(status.querySelector('[data-switchboard-status-text]')).not.toBeNull();
    expect(status.querySelector('button[data-switchboard-retry]')).toHaveTextContent('Try again');
  });

  // s22 (Alex, "Bar first: yes"): on sql the bar shows from the page's load, with its checking note, while the dry run
  // is pending; s19c's rule holds once it answers.
  test('s22, sql: the bar with "checking the SQL first…" and a disabled Approve while the dry run runs; plain once clean', async () => {
    let finish;
    runner({ preview: reply(PREVIEW), 'dry-run': () => new Promise((r) => { finish = r; }) });
    open();
    await screen.findByText(/running the dry run/i);
    const bar = screen.getByTestId('run-approval-required');
    expect(bar).toHaveTextContent('Approval required — checking the SQL first…');
    expect(screen.getByTestId('run-approval-note')).toHaveClass('normal-case');
    expect(screen.getByRole('button', { name: /^approve/i })).toBeDisabled();
    finish(await CLEAN());
    await approveOn();
    expect(screen.getByTestId('run-approval-required')).toHaveTextContent(/^Approval required$/);
    expect(screen.queryByTestId('run-approval-note')).toBeNull();
  });

  test('s22, sql: no bar once the dry run fails or its counts differ, and Approve stays off', async () => {
    runner({ preview: reply(PREVIEW), 'dry-run': MISMATCH });
    const b = open();
    await screen.findByText('Counts differ from what was expected, rolled back');
    expect(screen.getByRole('button', { name: /^approve/i })).toBeDisabled();
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    b.unmount();
    runner({ preview: reply(PREVIEW), 'dry-run': () => reply({ ok: false, run_id: 'dry1', summary: 'relation t does not exist' }) });
    const c = open();
    await screen.findByText('The dry run failed, rolled back');
    expect(screen.queryByRole('button', { name: /^approve/i })).toBeNull();
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    c.unmount();
    // A dry run the runner refuses, or one that can't reach it, sets a note: no bar, no Approve.
    runner({ preview: reply(PREVIEW), 'dry-run': () => Promise.reject(new Error('offline')) });
    const d = open();
    await screen.findByText(/Couldn't reach the runner/);
    expect(screen.queryByRole('button', { name: /^approve/i })).toBeNull();
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    d.unmount();
    // A refusal with no words at all still ends the check: no bar, and the dry run can be tried again.
    runner({ preview: reply(PREVIEW), 'dry-run': () => reply({ ok: false }, 500) });
    open();
    await screen.findByRole('button', { name: /^dry run$/i });
    expect(screen.queryByRole('button', { name: /^approve/i })).toBeNull();
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
  });

  test('s22, a sql test: no bar and no Approve while it runs, since it runs by itself', async () => {
    runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': () => new Promise(() => {}) });
    open();
    await screen.findByText(/running the test/i);
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    expect(screen.queryByRole('button', { name: /^approve/i })).toBeNull();
  });

  test('s22, git keeps s19c: no bar before its page is ready, the plain bar once Approve is offered', async () => {
    let show;
    runner({ preview: () => new Promise((r) => { show = r; }) });
    open();
    await waitFor(() => expect(show).toBeDefined());
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    show(await reply(SYNC));
    await approveOn();
    expect(screen.getByTestId('run-approval-required')).toHaveTextContent(/^Approval required$/);
    expect(screen.queryByTestId('run-approval-note')).toBeNull();
  });

  test('a ?kind=deploy link: the running and kind marks carry the link\'s kind, the line stays sql', async () => {
    let finish;
    runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: () => new Promise((r) => { finish = r; }) });
    const { container } = openAt('/approve/tok1?kind=deploy&exp=2000000000');
    fireEvent.click(await approveOn());
    await waitFor(() => expect(container.querySelector('[data-switchboard-running]')).not.toBeNull());
    expect(marksOf(container)).toEqual(['data-switchboard-running=deploy', 'data-switchboard-project=switchboard2-h8r', 'data-switchboard-kind=deploy']);
    finish(await reply({ ok: true, run_id: DRY, summary: 'done' }));
    await screen.findByText('Paste this into the Claude chat, then close this tab.');
    noStrip(container);
    expect(marksOf(container)).toEqual(pinned('deploy', 'switchboard2-h8r', DRY));
    expect(lineOf()).toBe(`sql ${DRY}`);
  });

  test.each(Object.keys(KINDS))('%s, not run: its marks and line', async (name) => {
    const [p, kind, project, id, word] = KINDS[name];
    // A sql cancel carries the runner's run id; every other kind carries the action id.
    const runId = kind === 'sql' ? 'c1' : id;
    runner({ preview: reply(p), 'dry-run': CLEAN, cancel: reply({ cancelled: true, reason: 'wait', run_id: 'c1' }) });
    const { container } = open();
    await approveOn();
    expect(screen.getByTestId('run-approval-required')).toHaveTextContent(/^Approval required$/);
    fireEvent.change(screen.getByLabelText('Reason for not running (optional)'), { target: { value: 'wait' } });
    fireEvent.click(screen.getByRole('button', { name: "Don't run" }));
    await screen.findByText('Paste this into the Claude chat, then close this tab.');
    noStrip(container);
    expect(marksOf(container)).toEqual(pinned(kind, project, runId, ['data-switchboard-cancelled=', 'data-switchboard-reason=wait']));
    expect(lineOf()).toBe(`${word} ${runId} cancelled: wait`);
    // s19c: after Don't run nothing waits for a click either, so the bar is gone.
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
  });

  test('sql test: runs on open, with no bar and no heading; its marks and line', async () => {
    runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': () => reply({ ok: true, test: true, run_id: 'dry1', summary: 'undone' }) });
    const { container } = open();
    await screen.findByText('Paste this into the Claude chat, then close this tab.');
    noStrip(container);
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    expect(screen.queryByTestId('approve-heading')).toBeNull();
    expect(marksOf(container)).toEqual(pinned('sql', 'switchboard2-h8r', 'dry1'));
    expect(lineOf()).toBe('sql dry1');
  });

  test('sign-in, loading and an ended link: no strip, no bar, no marks', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    const a = open();
    await screen.findByText(/sign in to alfred/i);
    noStrip(a.container);
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    expect(marksOf(a.container)).toEqual([]);
    a.unmount();
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt1' } } });
    runner({ preview: reply({ ok: false, error: 'no such link' }, 404) });
    const b = open();
    await screen.findByText(/this link doesn't exist/i);
    noStrip(b.container);
    expect(marksOf(b.container)).toEqual([]);
  });
});
