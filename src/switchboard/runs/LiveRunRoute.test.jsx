import { Suspense, lazy } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReviewRoute, RunRoute } from './LiveRunRoute';
import { RunErrorBoundary } from './look';
import { REVIEW_SCENARIOS, SCENARIOS } from './simulation';

const TOKEN = 'b'.repeat(64);
const LINK = '11111111-2222-4333-8444-555555555555';
const READY = { answer: 'running', panel: true, helper: true };
const HOUR = 60 * 60 * 1000;

/** A fetch answering by route ("preview", "approve", ...), recording each call. */
function fakeFetch(byRoute) {
  const calls = [];
  const fn = async (url, init) => {
    const route = url.split('/').pop();
    calls.push({ route, body: JSON.parse(init.body) });
    const r = byRoute[route] ?? { status: 404, body: { ok: false, error: 'not found.' } };
    return { status: r.status ?? 200, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const runPreview = (over = {}) => {
  const request = { ...SCENARIOS['dataop-update'].build(Date.now()).request, simulation: false, ...(over.request ?? {}) };
  // total_count 45: the scenario's counts.total, so the count shown is the count sent.
  return { ok: true, link_id: LINK, fingerprint: 'fp-1', total_count: 45, link: { version: 1, current: true }, sample: null, run: null, ...over, request };
};

function open(path, fetchImpl, extra = {}) {
  const deps = { fetchImpl, getSession: async () => ({ data: { session: { access_token: 'jwt' } } }), askDesktop: async () => READY, signIn: jest.fn(), ...extra };
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/run/:token" element={<RunRoute deps={deps} />} />
        <Route path="/review/:token" element={<ReviewRoute deps={deps} />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, deps };
}

describe('the live run route', () => {
  test('signed out: sign in, and nothing is asked of the function', async () => {
    const f = fakeFetch({});
    const { deps } = open(`/run/${TOKEN}`, f, { getSession: async () => ({ data: { session: null } }) });
    fireEvent.click(await screen.findByTestId('run-signin-button'));
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
    expect(screen.queryByTestId('run-simulation')).toBeNull();
  });

  test("an unknown token shows the database's own words", async () => {
    open(`/run/${TOKEN}`, fakeFetch({ preview: { status: 404, body: { ok: false, error: 'switchboard_run_preview: no such link.', code: 'P0002' } } }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent(/^switchboard_run_preview: no such link\.$/);
  });

  test('a voided or outdated link says so, and offers nothing', async () => {
    const voided = runPreview({ link: { version: 1, current: true, voided_at: '2026-11-24T10:00:00Z', void_reason: 'cancelled: wait' } });
    const { unmount } = open(`/run/${TOKEN}`, fakeFetch({ preview: { body: voided } }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent('This link was voided (cancelled: wait). Nothing was approved.');
    expect(screen.queryByTestId('run-approve')).toBeNull();
    unmount();
    open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview({ link: { version: 1, current: false } }) } }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent('The request was corrected since this link was issued. Nothing was approved.');
  });

  test("a real run: no strip, the extension's marks, its line without a prefix, posted through the status block", async () => {
    // The preview's total_count is what Approve sends.
    const f = fakeFetch({ preview: { body: runPreview({ total_count: 45 }) }, approve: { body: { ok: true, consumed: true, simulated: false, link_id: LINK, as_rerun: false, line: `run ${LINK}` } } });
    const { container } = open(`/run/${TOKEN}`, f);
    fireEvent.click(await screen.findByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(screen.queryByTestId('run-simulation')).toBeNull();
    expect(container.querySelector('[data-switchboard-project]')).toHaveAttribute('data-switchboard-kind', 'run');
    expect(screen.getByTestId('run-result-line').querySelector('code')).toHaveTextContent(new RegExp(`^run ${LINK}$`));
    expect(container.querySelector('[data-switchboard-status]')).not.toBeNull();
    expect(f.calls.find((c) => c.route === 'approve').body).toEqual({ token: TOKEN, fingerprint: 'fp-1', desktop: READY, count: 45 });
  });

  test("the count shown isn't the database's: no Approve and no red bar, the reason, nothing sent", async () => {
    const f = fakeFetch({ preview: { body: runPreview({ total_count: 47 }) } });
    open(`/run/${TOKEN}`, f);
    expect(await screen.findByTestId('run-count-mismatch')).toHaveTextContent(
      "The count on this page (45) is not the request's count in the database (47), so this page can't be approved.");
    expect(screen.queryByTestId('run-approve')).toBeNull();
    expect(screen.queryByTestId('run-approval-required')).toBeNull();
    expect(f.calls.map((c) => c.route)).toEqual(['preview']);
  });

  test('a simulated run: accepted, the strip shown, its line SIMULATION-prefixed and never posted', async () => {
    const f = fakeFetch({
      preview: { body: runPreview({ request: { simulation: true } }) },
      approve: { body: { ok: true, consumed: true, simulated: true, link_id: LINK, as_rerun: false, line: `SIMULATION run ${LINK}` } },
    });
    const { container } = open(`/run/${TOKEN}`, f);
    fireEvent.click(await screen.findByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(screen.getByTestId('run-simulation')).toBeInTheDocument();
    expect(container.querySelector('[data-switchboard-project]')).toHaveAttribute('data-switchboard-kind', 'simulation');
    expect(screen.getByTestId('run-result-line').querySelector('code')).toHaveTextContent(new RegExp(`^SIMULATION run ${LINK}$`));
    expect(container.querySelector('[data-switchboard-status]')).toBeNull();
  });

  test("a correction's reruns: the function's run <id> reruns line", async () => {
    const correction = SCENARIOS['correction-field'].build(Date.now()).request;
    const f = fakeFetch({
      preview: { body: runPreview({ request: { ...correction, simulation: false } }) },
      approve: { body: { ok: true, consumed: true, simulated: false, link_id: LINK, as_rerun: true, line: `run ${LINK} reruns` } },
    });
    open(`/run/${TOKEN}`, f);
    fireEvent.click(await screen.findByTestId('run-approve'));
    await screen.findByTestId('run-sent');
    expect(screen.getByTestId('run-result-line').querySelector('code')).toHaveTextContent(new RegExp(`^run ${LINK} reruns$`));
  });

  test("a refusal at Approve is shown word for word, with nothing added", async () => {
    const message = 'switchboard_consume_run_link: action 9 is live for demo; one at a time per project. Nothing was approved.';
    open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview() }, approve: { status: 409, body: { ok: false, error: message, code: '55000' } } }));
    fireEvent.click(await screen.findByTestId('run-approve'));
    expect(await screen.findByTestId('run-note')).toHaveTextContent(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  test("Don't run: the cancel line with its note, from the function", async () => {
    const f = fakeFetch({ preview: { body: runPreview() }, cancel: { body: { ok: true, link_id: LINK, reason: 'wait for Monday', line: `run ${LINK} cancelled: wait for Monday` } } });
    open(`/run/${TOKEN}`, f);
    await screen.findByTestId('run-approve');
    fireEvent.change(screen.getByLabelText('Reason for not running (optional)'), { target: { value: 'wait for Monday' } });
    fireEvent.click(screen.getByTestId('run-dont'));
    await screen.findByTestId('run-cancelled');
    expect(screen.getByTestId('run-result-line').querySelector('code')).toHaveTextContent(`run ${LINK} cancelled: wait for Monday`);
  });

  test("the status is the evidence's: the chat's 'passed' phase and still-valid list are not shown", async () => {
    const correction = SCENARIOS['correction-field'].build(Date.now()).request;
    const now = Date.now();
    const evidence = [{ check: 'count', org: 'production', passed_at: new Date(now - 2 * HOUR).toISOString() },
      { check: 'login', org: 'production', passed_at: new Date(now - 2 * HOUR).toISOString(), voided: true }];
    const request = { ...correction, simulation: false, evidence,
      phases: [{ name: 'Pre-check and rehearsal', state: 'passed', at: new Date(now).toISOString() }],
      changed: { ...correction.changed, still_valid: [{ check: 'backup', passed_at: new Date(now).toISOString() }] } };
    open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview({ request }) } }));
    await screen.findByTestId('run-approve');
    expect(screen.getAllByTestId('run-phase').map((p) => p.dataset.state)).toEqual(['waiting', 'not_started']);
    expect(screen.getAllByTestId('run-still-valid-check').map((e) => e.textContent.split(',')[0])).toEqual(['Count']);
  });

  test("a correction whose reruns are running: the page waits, with no Approve; a simulation's ended link keeps the strip", async () => {
    const correction = SCENARIOS['correction-field'].build(Date.now()).request;
    const now = new Date().toISOString();
    const run = { action_id: 'a2', status: 'consumed', consumed_at: now, picked_up_at: now, finished_at: null, not_started: false, rerun: true };
    const { unmount } = open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview({ request: { ...correction, simulation: false, rerun_at: now }, run }) } }));
    expect(await screen.findByTestId('run-rerun-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('run-approve')).toBeNull();
    unmount();
    open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview({ request: { simulation: true }, link: { version: 1, current: false } }) } }));
    await screen.findByTestId('run-error');
    expect(screen.getByTestId('run-simulation')).toBeInTheDocument();
  });

  test("s17: the outcome shows once the link's write ran, and never on an unused link", async () => {
    const outcome = { changed: 45, rows: [{ label: 'Gifts with no campaign', before: 45, goal: 0, after: 0 }] };
    const now = new Date().toISOString();
    const run = { action_id: 'a1', status: 'succeeded', consumed_at: now, picked_up_at: now, finished_at: now, not_started: false, rerun: false };
    const { unmount } = open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview({ outcome, run }) } }));
    expect(await screen.findByTestId('run-outcome-changed')).toHaveTextContent('Changed: 45 records');
    unmount();
    open(`/run/${TOKEN}`, fakeFetch({ preview: { body: runPreview({ outcome }) } }));
    await screen.findByTestId('run-approve');
    expect(screen.queryByTestId('run-outcome')).toBeNull();
  });

  test('a review link on /run/ is sent to /review/, in words', async () => {
    open(`/run/${TOKEN}`, fakeFetch({ preview: { body: { ...runPreview(), review: { id: 'r1' } } } }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent('This is a code review link: open it as /review/ instead.');
  });
});

describe('the error boundary', () => {
  // React logs a caught error to the console; keep the test output plain.
  let spy;
  beforeEach(() => { spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => spy.mockRestore());
  const expectFailed = async (onReload) => {
    expect(await screen.findByTestId('run-load-failed')).toHaveTextContent(/^This page couldn't load\. Nothing has run\.$/);
    expect(screen.queryByTestId('run-simulation')).toBeNull();
    fireEvent.click(screen.getByTestId('run-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
  };

  test('a child that fails to render: the plain message and Reload, never a blank page', async () => {
    const Broken = () => { throw new Error('boom'); };
    const onReload = jest.fn();
    render(<RunErrorBoundary onReload={onReload}><Broken /></RunErrorBoundary>);
    await expectFailed(onReload);
  });

  test('a lazy page that fails to load: the same message', async () => {
    const Missing = lazy(() => Promise.reject(new Error('Loading chunk 7 failed.')));
    const onReload = jest.fn();
    render(<RunErrorBoundary onReload={onReload}><Suspense fallback={null}><Missing /></Suspense></RunErrorBoundary>);
    await expectFailed(onReload);
  });

  test('the route: a page that throws while rendering shows the boundary', async () => {
    const onReload = jest.fn();
    // A request of the wrong shape makes the page throw.
    const deps = { fetchImpl: fakeFetch({ preview: { body: { ...runPreview(), request: { simulation: false, phases: 7, steps: 7 } } } }),
      getSession: async () => ({ data: { session: { access_token: 'jwt' } } }), askDesktop: async () => READY };
    render(<MemoryRouter initialEntries={[`/run/${TOKEN}`]}><Routes><Route path="/run/:token" element={<RunRoute deps={deps} onReload={onReload} />} /></Routes></MemoryRouter>);
    await expectFailed(onReload);
  });
});

describe('the live review route', () => {
  const review = () => {
    const r = REVIEW_SCENARIOS['review-all-acknowledged'].build(Date.now());
    const { headline, project_code, ...rest } = r;
    return { ...rest, id: 'r1', status: 'open' };
  };

  test("the review, with its request's headline and code; I reviewed this code posts the function's line", async () => {
    const f = fakeFetch({
      preview: { body: { ...runPreview(), review: review() } },
      review: { body: { ok: true, link_id: LINK, status: 'reviewed', simulated: false, line: `review ${LINK} reviewed` } },
    });
    const { container } = open(`/review/${TOKEN}`, f);
    const button = await screen.findByTestId('review-reviewed');
    expect(container.querySelector('[data-switchboard-project]')).toHaveAttribute('data-switchboard-kind', 'review');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByTestId('review-done');
    expect(screen.getByTestId('run-result-line').querySelector('code')).toHaveTextContent(new RegExp(`^review ${LINK} reviewed$`));
    expect(f.calls.find((c) => c.route === 'review').body).toMatchObject({ token: TOKEN, answer: 'reviewed', desktop: READY });
  });

  test('a review already answered shows its answer, with nothing to click', async () => {
    open(`/review/${TOKEN}`, fakeFetch({ preview: { body: { ...runPreview(), review: { ...review(), status: 'reviewed' } } } }));
    expect(await screen.findByTestId('review-done')).toHaveTextContent('Reviewed.');
    expect(screen.queryByTestId('review-reviewed')).toBeNull();
  });

  test('a run link on /review/ says so', async () => {
    open(`/review/${TOKEN}`, fakeFetch({ preview: { body: runPreview() } }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent('This is a run page link, not a code review link: open it as /run/ instead.');
  });
});
