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

beforeEach(() => {
  supabase.auth.getSession.mockReset();
  supabase.auth.signInWithOAuth.mockReset();
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt1' } } });
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
  const [url, init] = called('preview')[0];
  expect(url).toBe('https://db.example/functions/v1/switchboard-runner/preview');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer jwt1');
  expect(JSON.parse(init.body)).toEqual({ token: 'tok1' });
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
  expect(screen.getByText('Done, you can close this tab.')).toBeInTheDocument();
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
  expect(screen.queryByText(/you can close this tab/i)).not.toBeInTheDocument();
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

test('a lost connection at Approve warns it may have run and offers no retry', async () => {
  runner({ preview: reply(PREVIEW), 'dry-run': CLEAN, approve: () => Promise.reject(new Error('network')) });
  open();
  fireEvent.click(await screen.findByRole('button', { name: /^approve/i }));
  expect(await screen.findByText(/may have run/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument());
});
