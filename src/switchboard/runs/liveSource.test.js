import {
  RunPagesError, approveCount, callRunPages, countMismatch, linkEndedReason, liveReviewSource, liveRunSource,
} from './liveSource';
import { SCENARIOS } from './simulation';

const TOKEN = 'a'.repeat(64);
const LINK = '11111111-2222-4333-8444-555555555555';
const READY = { answer: 'running', panel: true, helper: true };
const signedIn = () => Promise.resolve({ data: { session: { access_token: 'jwt-1' } } });

/** A fetch that answers each call from `replies` in turn and records what was sent. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r instanceof Error) throw r;
    return { status: r.status ?? 200, json: async () => { if (r.raw) throw new Error('not json'); return r.body; } };
  };
  fn.calls = calls;
  return fn;
}
const deps = (fetchImpl, extra = {}) => ({ fetchImpl, getSession: signedIn, askDesktop: async () => READY, ...extra });

function preview(over = {}) {
  const request = { ...SCENARIOS['dataop-update'].build(Date.now()).request, simulation: false, ...(over.request ?? {}) };
  return { ok: true, link_id: LINK, fingerprint: 'fp-1', link: { version: 1, current: true }, sample: null, run: null, ...over, request };
}

describe('callRunPages', () => {
  test("posts the route with the session's JWT and the anon key, and returns the reply", async () => {
    const f = fakeFetch({ body: { ok: true, x: 1 } });
    const out = await callRunPages('preview', { token: TOKEN }, deps(f));
    expect(out).toEqual({ ok: true, x: 1 });
    expect(f.calls[0].url).toMatch(/\/functions\/v1\/switchboard-run-pages\/preview$/);
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer jwt-1');
    expect(f.calls[0].init.headers.apikey).toBeTruthy();
    expect(f.calls[0].body).toEqual({ token: TOKEN });
  });

  test("the function's refusal comes back word for word, with its status", async () => {
    const message = 'switchboard_consume_run_link: the checks expired at 2026-11-22; run the pre-check and rehearsal again. Nothing was approved.';
    const f = fakeFetch({ status: 409, body: { ok: false, error: message, code: '55000' } });
    await expect(callRunPages('approve', {}, deps(f))).rejects.toMatchObject({ name: 'RunPagesError', message, status: 409 });
  });

  test('no session, no network or no JSON: a plain sentence, and nothing sent without a session', async () => {
    const f = fakeFetch({ body: { ok: true } });
    await expect(callRunPages('preview', {}, deps(f, { getSession: async () => ({ data: { session: null } }) })))
      .rejects.toThrow('Sign in to Alfred first. Nothing was sent.');
    expect(f.calls).toHaveLength(0);
    await expect(callRunPages('preview', {}, deps(fakeFetch(new Error('offline'))))).rejects.toThrow("Couldn't reach Alfred. Nothing was sent.");
    await expect(callRunPages('preview', {}, deps(fakeFetch({ status: 502, raw: true })))).rejects.toThrow('Alfred answered 502.');
    expect(new RunPagesError('x', 1)).toBeInstanceOf(Error);
  });
});

describe('the run source', () => {
  test("its kind is the database's: real only when simulation is false", () => {
    expect(liveRunSource(TOKEN, preview(), deps(fakeFetch({}))).kind).toBe('real');
    expect(liveRunSource(TOKEN, preview({ request: { simulation: true } }), deps(fakeFetch({}))).kind).toBe('sim');
    expect(liveRunSource(TOKEN, preview({ request: { simulation: undefined } }), deps(fakeFetch({}))).kind).toBe('sim');
  });

  test("the phases come from the evidence, never the chat's: no evidence, nothing passed", async () => {
    const p = preview({ request: { evidence: [], phases: [{ name: 'Pre-check and rehearsal', state: 'passed', at: '2026-11-24T00:00:00Z' }] } });
    const { request } = await liveRunSource(TOKEN, p, deps(fakeFetch({}))).load();
    expect(request.phases[0]).toEqual({ name: 'Pre-check and rehearsal', state: 'waiting' });
    expect(request.phases[1]).toEqual({ name: 'Data operation', state: 'not_started' });
  });

  test("approve sends the token, fingerprint, the newest desktop answer and the preview's total_count; the reply line is kept", async () => {
    const f = fakeFetch({ body: { ok: true, consumed: true, simulated: false, link_id: LINK, as_rerun: false, line: `run ${LINK}` } });
    // total_count differs from the request's counts (expected 45): the page sends the database's number.
    const s = liveRunSource(TOKEN, preview({ total_count: 47 }), deps(f));
    await s.checkDesktop();
    const out = await s.approve();
    expect(f.calls[0].url).toMatch(/\/approve$/);
    expect(f.calls[0].body).toEqual({ token: TOKEN, fingerprint: 'fp-1', desktop: READY, count: 47 });
    expect(out).toMatchObject({ sent: true, line: `run ${LINK}` });
  });

  test('rerun, resend and cancel: their routes, and the cancel note goes as typed', async () => {
    const f = fakeFetch({ body: { ok: true, link_id: LINK, reason: 'wait for Monday', line: `run ${LINK} cancelled: wait for Monday` } });
    const s = liveRunSource(TOKEN, preview(), deps(f));
    expect(await s.rerun()).toMatchObject({ sent: true, rerun: true });
    expect(await s.resend()).toMatchObject({ sent: true, resent: true });
    expect(await s.cancel('wait for Monday')).toMatchObject({ cancelled: true, reason: 'wait for Monday', line: `run ${LINK} cancelled: wait for Monday` });
    expect(f.calls.map((c) => c.url.split('/').pop())).toEqual(['rerun', 'resend', 'cancel']);
    expect(f.calls[2].body).toEqual({ token: TOKEN, reason: 'wait for Monday' });
    expect(f.calls[0].body).toEqual({ token: TOKEN, fingerprint: 'fp-1', desktop: null });
  });
});

test("a rerun is never the write: pending, the page waits; finished, the link offers what comes next", async () => {
  const rerun = { action_id: 'a2', status: 'consumed', consumed_at: new Date().toISOString(), picked_up_at: new Date().toISOString(), finished_at: null, not_started: false, rerun: true };
  const pending = await liveRunSource(TOKEN, preview({ run: rerun }), deps(fakeFetch({}))).load();
  expect(pending.run).toBeNull();
  expect(pending.request.rerun_pending).toBe(true);
  const done = await liveRunSource(TOKEN, preview({ run: { ...rerun, finished_at: new Date().toISOString() } }), deps(fakeFetch({}))).load();
  expect(done.run).toBeNull();
  expect(done.request.rerun_pending).toBeUndefined();
  const write = { ...rerun, rerun: false };
  expect((await liveRunSource(TOKEN, preview({ run: write }), deps(fakeFetch({}))).load()).run).toEqual(write);
});

describe('the review source', () => {
  test("the review carries its request's headline and code; reviewed sends the acks and the desktop", async () => {
    const f = fakeFetch({ body: { ok: true, link_id: LINK, status: 'reviewed', line: `review ${LINK} reviewed` } });
    const p = { ...preview(), review: { id: 'r1', commit: 'abc1234', findings: { fixed_by_cli: [], for_you: [] } } };
    const s = liveReviewSource(TOKEN, p, deps(f));
    const { review } = await s.load();
    expect(review).toMatchObject({ id: 'r1', headline: p.request.headline, project_code: p.request.project_code });
    await s.checkDesktop();
    expect(await s.reviewed({ F1: { note: '' } })).toMatchObject({ line: `review ${LINK} reviewed` });
    expect(f.calls[0].body).toEqual({ token: TOKEN, answer: 'reviewed', text: '', acks: { F1: { note: '' } }, desktop: READY });
    await s.question('  why?  ', {});
    await s.changes('fix it', {});
    expect(f.calls.slice(1).map((c) => [c.body.answer, c.body.text])).toEqual([['question', 'why?'], ['changes_required', 'fix it']]);
  });
});

test('linkEndedReason and approveCount', () => {
  expect(linkEndedReason({ link: { voided_at: '2026-11-24', void_reason: 'corrected' } })).toBe('This link was voided (corrected). Nothing was approved.');
  expect(linkEndedReason({ link: { current: false } })).toBe('The request was corrected since this link was issued. Nothing was approved.');
  expect(linkEndedReason({ link: { current: true } })).toBeNull();
  // The preview's total_count, exactly: never the request's counts.
  expect(approveCount({ total_count: 48, request: { page: 'dataop', counts: { expected: 45, total: 45 } } })).toBe(48);
  expect(approveCount({ total_count: 0 })).toBe(0);
  expect(approveCount({ total_count: null, request: { counts: { expected: 45 } } })).toBeNull();
  expect(approveCount({ request: { counts: { expected: 45 } } })).toBeNull();
});

test('countMismatch: a write page whose shown count is not total_count; never a page that writes nothing', () => {
  expect(countMismatch({ total_count: 45, request: { page: 'dataop', counts: { expected: 40, total: 45 } } })).toBeNull();
  expect(countMismatch({ total_count: 40, request: { page: 'undo', counts: { expected: 45, undo_up_to: 40 } } })).toBeNull();
  expect(countMismatch({ total_count: 45, request: { page: 'undo', counts: { expected: 45, total: 45, undo_up_to: 40 } } }))
    .toMatch(/^The count on this page \(40\) is not the request's count in the database \(45\)/);
  expect(countMismatch({ request: { page: 'dataop', counts: { expected: 45 } } })).toMatch(/\(none\)/);
  expect(countMismatch({ total_count: null, request: { page: 'precheck', counts: {} } })).toBeNull();
  expect(countMismatch({ total_count: 1, request: { page: 'correction', counts: { total: 2 } } })).toBeNull();
});

test('a mismatched write carries count_mismatch into the page', async () => {
  const { request } = await liveRunSource(TOKEN, preview({ total_count: 47 }), deps(fakeFetch({}))).load();
  expect(request.count_mismatch).toMatch(/\(45\).*\(47\)/);
  expect((await liveRunSource(TOKEN, preview({ total_count: 45 }), deps(fakeFetch({}))).load()).request.count_mismatch).toBeUndefined();
});
