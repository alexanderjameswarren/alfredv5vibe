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

// dataop_link-k7d s6: the sf_dataquery fixture.
test('dev server: /approve-fixture/sf_dataquery shows the export link with manifest and undo, and nothing is fetched', async () => {
  appAt('/approve-fixture/sf_dataquery');
  expect(await screen.findByTestId('approve-production-read')).toHaveTextContent(/production, read only/i);
  expect(screen.getByTestId('approve-production-read-mode')).toHaveTextContent('Bulk exports');
  expect(screen.getAllByTestId('approve-dataquery-query').map((li) => li.getAttribute('data-step'))).toEqual(['manifest', 'undo']);
  expect(screen.getByText(/EXPORT demo_link_installments-x1y ON demo-prod: 2 QUERIES \(manifest, undo\), READ ONLY/)).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(supabase.auth.getSession).not.toHaveBeenCalled();
});

test('the sf_dataquery choices: a leading newline kept, a count link, and the 100,000-character export', async () => {
  appAt('/approve-fixture/sf_dataquery');
  await screen.findByTestId('approve-dataquery');
  fireEvent.change(screen.getByTestId('approve-fixture-dataquery'), { target: { value: 'newline' } });
  await waitFor(() => expect(screen.getAllByTestId('approve-dataquery-query')).toHaveLength(1));
  expect(screen.getByTestId('approve-dataquery-soql').textContent.startsWith('\n\n    SELECT Id')).toBe(true);
  fireEvent.change(screen.getByTestId('approve-fixture-dataquery'), { target: { value: 'count' } });
  await waitFor(() => expect(screen.getByTestId('approve-production-read-mode')).toHaveTextContent('Counts'));
  expect(screen.getAllByTestId('approve-dataquery-query')).toHaveLength(3);
  expect(screen.getAllByTestId('approve-dataquery-source')[0]).toHaveTextContent('Rule Installments with no plan link');
  fireEvent.change(screen.getByTestId('approve-fixture-dataquery'), { target: { value: 'long' } });
  await waitFor(() => expect(screen.getByTestId('approve-dataquery-soql').textContent.length).toBeGreaterThan(99000));
  expect(screen.getByTestId('approve-dataquery-soql').textContent.length).toBeLessThanOrEqual(100000);
  expect(global.fetch).not.toHaveBeenCalled();
});

// dataquery_fixes-v3n: the sandbox and no-org-type choices.
test('the sf_dataquery fixture: a sandbox link has the SANDBOX banner and headline; an old link says org type not recorded', async () => {
  appAt('/approve-fixture/sf_dataquery');
  await screen.findByTestId('approve-production-read');
  expect(screen.queryByTestId('approve-org-type-missing')).toBeNull();
  fireEvent.change(screen.getByTestId('approve-fixture-dataquery'), { target: { value: 'sandbox' } });
  const banner = await screen.findByTestId('approve-sandbox-read');
  expect(banner).toHaveTextContent(/sandbox, read only/i);
  expect(banner).toHaveClass('bg-sky-700');
  expect(screen.queryByTestId('approve-production-read')).toBeNull();
  expect(screen.getByText(/^SANDBOX COUNTS demo_link_installments-x1y ON demo-sandbox: 3 QUERIES \(rules\), READ ONLY$/)).toBeInTheDocument();
  fireEvent.change(screen.getByTestId('approve-fixture-dataquery'), { target: { value: 'untyped' } });
  expect(await screen.findByTestId('approve-org-type-missing')).toHaveTextContent(/org type not recorded/i);
  expect(screen.getByTestId('approve-production-read')).toHaveClass('bg-orange-400');
  expect(screen.queryByTestId('approve-sandbox-read')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('sf_dataquery fixture: Approve and Don\'t run answer locally', async () => {
  appAt('/approve-fixture/sf_dataquery');
  fireEvent.click(await screen.findByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('dataquery fixture-action')).toBeInTheDocument();
  fireEvent.change(screen.getByTestId('approve-fixture-dataquery'), { target: { value: 'count' } });
  fireEvent.change(await screen.findByLabelText(/reason for not running/i), { target: { value: 'just looking' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('dataquery fixture-action cancelled: just looking')).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('production: the sf_dataquery fixture route is absent too', async () => {
  appAt('/approve-fixture/sf_dataquery', 'production');
  expect(await screen.findByText('ALFRED HOME')).toBeInTheDocument();
  expect(screen.queryByTestId('approve-production-read')).toBeNull();
});

test('an unknown kind says there is no fixture for it', async () => {
  appAt('/approve-fixture/git');
  expect(await screen.findByText(/No fixture for git/)).toBeInTheDocument();
  expect(screen.getByText(/\/approve-fixture\/sf_datawrite/)).toBeInTheDocument();
});

// dataop_write-j5w s6: the sf_datawrite fixture, one address per sample.
test('dev server: /approve-fixture/sf_datawrite opens the production batch, and nothing is fetched', async () => {
  appAt('/approve-fixture/sf_datawrite');
  const banner = await screen.findByTestId('approve-production-write');
  expect(banner).toHaveClass('bg-orange-400', 'text-black');
  expect(screen.getByTestId('approve-fixture-bar')).toHaveTextContent('nothing here reaches Supabase or the runner');
  expect(screen.getByTestId('approve-datawrite-sentence')).toHaveTextContent('This changes 26,571 live records of Demo_Installment__c in demo-prod.');
  expect(screen.getByTestId('approve-datawrite-write')).toHaveTextContent('new DemoLinkInstallmentsBatch(), runs SELECTION = selection.soql');
  expect(screen.getAllByTestId('approve-datawrite-stage').map((s) => s.getAttribute('data-step'))).toEqual(['gate', 'after', 'after-counts']);
  expect(screen.getByTestId('approve-datawrite-upload-title')).toHaveTextContent('dataop-exclude:DemoLinkInstallmentsBatch');
  // s6b: exclude.csv listed once, as the upload.
  expect(screen.queryByTestId('approve-datawrite-exclude')).toBeNull();
  expect(screen.getByTestId('approve-datawrite-files').textContent.match(/exclude\.csv/g)).toHaveLength(1);
  expect(screen.getByTestId('approve-datawrite-after')).toHaveTextContent(/before the live write and before any upload/);
  expect(screen.getByTestId('approve-datawrite-wait')).toHaveTextContent('steady for 2 minutes, for at most 30 minutes');
  expect(screen.getByText(/^PRODUCTION DATA WRITE demo_link_installments-x1y ON demo-prod: ABOUT TO CHANGE 26,571 LIVE RECORDS OF Demo_Installment__c BY BATCH DemoLinkInstallmentsBatch$/)).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(supabase.auth.getSession).not.toHaveBeenCalled();
});

test('dev server: ?sample=bulk opens the sandbox bulk update with the SANDBOX banner', async () => {
  appAt('/approve-fixture/sf_datawrite?sample=bulk');
  const banner = await screen.findByTestId('approve-sandbox-write');
  expect(banner).toHaveClass('bg-sky-700', 'text-white');
  expect(screen.queryByTestId('approve-production-write')).toBeNull();
  expect(screen.getByTestId('approve-datawrite-sentence')).toHaveTextContent('This changes 45 sandbox records of Demo_Installment__c in demo-sandbox.');
  expect(screen.getByTestId('approve-datawrite-write')).toHaveTextContent('Bulk update from update.csv');
  // s6b: a bulk write uploads nothing, and a sandbox write isn't "live".
  expect(screen.getByTestId('approve-datawrite-bulk-exclude')).toHaveTextContent('Records left out at the gate are removed from the CSV before the write.');
  expect(screen.getByTestId('approve-datawrite-files')).not.toHaveTextContent(/Files the run writes|ContentVersion|sb closeout/);
  expect(screen.getByTestId('approve-datawrite-after')).toHaveTextContent(/asks for Enter before the write; q stops it/);
  expect(screen.getByTestId('approve-datawrite-after')).not.toHaveTextContent(/live write/);
  expect(screen.getByText(/^SANDBOX DATA WRITE .* ABOUT TO CHANGE 45 RECORDS OF Demo_Installment__c BY BULK UPDATE$/)).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('dev server: ?sample=undo opens the production undo, its Id file and a broad snapshot listing 12 Ids', async () => {
  appAt('/approve-fixture/sf_datawrite?sample=undo');
  await screen.findByTestId('approve-production-write');
  expect(screen.getByTestId('approve-datawrite-sentence')).toHaveTextContent('This changes 12 live records of Demo_Installment__c in demo-prod.');
  expect(screen.getByTestId('approve-datawrite-write')).toHaveTextContent('Undo: reverse batch DemoLinkInstallmentsUndoBatch reading undo-ids.csv, 12 rows');
  expect(screen.getByTestId('approve-datawrite-upload-title')).toHaveTextContent('dataop-undo:DemoLinkInstallmentsUndoBatch');
  const ids = screen.getAllByTestId('approve-datawrite-ids');
  expect(ids).toHaveLength(2);
  for (const n of ids) expect(n).toHaveTextContent('This snapshot lists 12 record Ids.');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('the sf_datawrite select switches samples; Approve and Don\'t run answer locally', async () => {
  appAt('/approve-fixture/sf_datawrite');
  await screen.findByTestId('approve-production-write');
  fireEvent.change(screen.getByTestId('approve-fixture-datawrite'), { target: { value: 'bulk' } });
  expect(await screen.findByTestId('approve-sandbox-write')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^approve and run$/i }));
  expect(await screen.findByText('datawrite fixture-action')).toBeInTheDocument();
  fireEvent.change(screen.getByTestId('approve-fixture-datawrite'), { target: { value: 'undo' } });
  fireEvent.change(await screen.findByLabelText(/reason for not running/i), { target: { value: 'just looking' } });
  fireEvent.click(screen.getByRole('button', { name: /don't run/i }));
  expect(await screen.findByText('datawrite fixture-action cancelled: just looking')).toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('production: the sf_datawrite fixture route is absent too', async () => {
  appAt('/approve-fixture/sf_datawrite', 'production');
  expect(await screen.findByText('ALFRED HOME')).toBeInTheDocument();
  expect(screen.queryByTestId('approve-production-write')).toBeNull();
});
