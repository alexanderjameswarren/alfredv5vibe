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
    const head = await screen.findByTestId('approve-stakes-change');
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
    expect(screen.queryByTestId('approve-stakes-change')).toBeNull();
    expect(screen.queryByText(/approval required/i)).toBeNull();
    noGreen(container);
    unmount();
  }
});

test('the bar ignores the url', async () => {
  runner({ preview: reply(SF) });
  const a = openAt('/approve/tok1?kind=sql&stakes=none&exp=1');
  expect(await screen.findByTestId('approve-stakes-change')).toBeInTheDocument();
  a.unmount();
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': CLEAN });
  openAt('/approve/tok1?kind=sql&stakes=change&exp=1');
  await screen.findByText(PREVIEW.headline);
  expect(screen.queryByTestId('approve-stakes-change')).toBeNull();
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
  expect(screen.getByTestId('approve-heading')).toHaveTextContent('Approve');
  a.unmount();
  runner({ preview: reply(SYNC) });
  open();
  await screen.findByText(SYNC.headline);
  expect(screen.queryByTestId('approve-chain')).toBeNull();
});

test('a sql test has no Approve heading; a real sql run and a git link keep it', async () => {
  runner({ preview: reply({ ...PREVIEW, test: true }), 'dry-run': () => reply({ ok: true, test: true, run_id: 'dry1', summary: 'undone' }) });
  const a = open();
  await screen.findByText(PREVIEW.headline);
  expect(screen.queryByTestId('approve-heading')).toBeNull();
  expect(screen.queryByText(/^approve$/i)).toBeNull();
  a.unmount();
  for (const p of [PREVIEW, SYNC]) {
    runner({ preview: reply(p), 'dry-run': CLEAN });
    const b = open();
    await screen.findByText(p.headline);
    expect(screen.getByTestId('approve-heading')).toHaveTextContent('Approve');
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
  expect(screen.getByTestId('approve-stakes-change')).toHaveTextContent('Approval required');
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
  expect(screen.getByTestId('approve-stakes-change')).toBeInTheDocument();
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
