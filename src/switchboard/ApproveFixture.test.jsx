import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { supabase } from '../supabaseClient';
import App from '../App';

// dataops_alfred-d4x s6b: the dev-only fixture route. It renders the real ApprovePage with a sample sf_dataop, never
// calls fetch or Supabase, and is absent when NODE_ENV is production.

jest.mock('../supabaseClient', () => ({
  supabaseUrl: 'https://db.example',
  supabaseAnonKey: 'anon',
  supabase: { auth: { getSession: jest.fn(), signInWithOAuth: jest.fn() } },
}));
jest.mock('../Alfred', () => () => 'ALFRED HOME');
jest.mock('../OAuthConsent', () => () => 'CONSENT');

const ENV = process.env.NODE_ENV;

/**
 * The real App at the fixture's address, rendered with NODE_ENV as given. App checks NODE_ENV when it renders the
 * route as well as when it loads, so production can be shown here without loading a second copy of React. That the
 * build itself drops the route and its import is checked on the build output (s6b report).
 */
function appAt(path, env = ENV) {
  window.history.pushState({}, '', path);
  process.env.NODE_ENV = env;
  return render(<App />);
}

beforeEach(() => {
  global.fetch = jest.fn(() => { throw new Error('the fixture must never call fetch'); });
  supabase.auth.getSession.mockReset();
});
afterEach(() => {
  process.env.NODE_ENV = ENV;
  window.history.pushState({}, '', '/');
});

test('dev server: /approve-fixture/sf_dataop shows the sf_dataop page, and nothing reaches the runner or Supabase', async () => {
  appAt('/approve-fixture/sf_dataop');
  const banner = await screen.findByTestId('approve-production');
  expect(banner).toHaveClass('bg-orange-400', 'text-black');
  expect(screen.getByTestId('approve-fixture-bar')).toHaveTextContent('nothing here reaches Supabase or the runner');
  expect(screen.getByTestId('approve-dataop-count')).toHaveTextContent('About to change 26,571 live records');
  expect(screen.getByTestId('approve-dataop-write')).toHaveTextContent('Batch Apex class DemoLinkInstallmentsBatch');
  expect(screen.getByTestId('approve-dataop-rehearsal')).toHaveTextContent('Rehearsed on demo-dev1');
  expect(screen.getByTestId('approve-dataop-rows').querySelectorAll('tbody tr[data-knock-on]')).toHaveLength(2);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(supabase.auth.getSession).not.toHaveBeenCalled();
});

test('production: the route is absent, so the address falls through to Alfred', async () => {
  appAt('/approve-fixture/sf_dataop', 'production');
  expect(await screen.findByText('ALFRED HOME')).toBeInTheDocument();
  expect(screen.queryByTestId('approve-fixture-bar')).toBeNull();
  expect(screen.queryByTestId('approve-production')).toBeNull();
});

test('the toggles: bulk write, and no rehearsal', async () => {
  appAt('/approve-fixture/sf_dataop');
  await screen.findByTestId('approve-dataop');
  fireEvent.click(screen.getByLabelText(/bulk write/i));
  await waitFor(() => expect(screen.getByTestId('approve-dataop-write')).toHaveTextContent('Bulk dataop'));
  expect(screen.getByText(/BY BULK$/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/no rehearsal/i));
  await waitFor(() => expect(screen.queryByTestId('approve-dataop-rehearsal')).toBeNull());
  expect(screen.getByTestId('approve-dataop-write')).toHaveTextContent('Bulk dataop');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('Approve and Don\'t run answer locally', async () => {
  appAt('/approve-fixture/sf_dataop');
  fireEvent.click(await screen.findByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('Sent to the desktop helper')).toBeInTheDocument();
  expect(screen.getByText('dataop fixture-action')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/no rehearsal/i));
  fireEvent.change(await screen.findByLabelText(/reason for not running/i), { target: { value: 'just looking' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('dataop fixture-action cancelled: just looking')).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('an unknown kind says there is no fixture for it', async () => {
  appAt('/approve-fixture/git');
  expect(await screen.findByText(/No fixture for git/)).toBeInTheDocument();
});
