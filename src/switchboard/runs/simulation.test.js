import { createElement as h } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { requestProblems } from './runContract';
import { DESKTOP_ANSWERS, SCENARIOS, scenarioNames, simSource } from './simulation';
import { ANSWERS, simulatedState } from './desktopCheck';
import RunSimulation from './RunSimulation';

/** The page's one action button (Approve, the rerun or the resend), as RunPage.test.jsx finds it. */
// The action's label changes with the page, so it is found by its data-action mark rather than by role and name.
// eslint-disable-next-line testing-library/no-node-access
const hasAction = () => Boolean(document.querySelector('[data-action]'));

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

/**
 * s6b: every scenario renders whole through the dev route, as the browser opens it, with the desktop ready and not
 * ready. Any render error, or any error React logs, fails the test, so a page that can't render is caught here.
 */
describe('every scenario renders through /run-sim/:scenario', () => {
  let errors;
  beforeEach(() => {
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn();
  });
  afterEach(() => {
    const logged = errors.mock.calls.length;
    const fetched = global.fetch.mock.calls.length;
    errors.mockRestore();
    delete global.fetch;
    expect(logged).toBe(0);
    expect(fetched).toBe(0);
  });
  const at = (path) => render(h(MemoryRouter, { initialEntries: [path] },
    h(Routes, null, h(Route, { path: '/run-sim/:scenario', element: h(RunSimulation) }))));

  test.each(scenarioNames().flatMap((name) => [[name, ''], [name, '?desktop=not_running']]))('%s%s', async (name, query) => {
    at(`/run-sim/${name}${query}`);
    // Settled on every page: the request and the desktop's first answer are both in.
    await waitFor(() => expect(screen.getByTestId('run-headline')).toHaveAttribute('data-settled', 'true'));
    expect(screen.getByTestId('run-simulation')).toBeInTheDocument();
    expect(screen.getByTestId('run-problem')).toBeInTheDocument();
    expect(screen.getByTestId('run-will')).toBeInTheDocument();
    // The action and the red bar together, or neither; with the desktop not ready, never an action.
    expect(Boolean(screen.queryByTestId('run-approval-required'))).toBe(hasAction());
    expect(Boolean(query) && hasAction()).toBe(false);
  });

  test('an unknown scenario shows the list', async () => {
    at('/run-sim/list');
    expect(await screen.findByTestId('run-sim-list')).toBeInTheDocument();
  });
});

describe('simulation', () => {
  test.each(scenarioNames())('%s is a whole request, marked as a simulation, from a sim source', async (name) => {
    const s = simSource(name, { now: Date.parse('2026-11-23T12:00:00Z') });
    expect(s.kind).toBe('sim');
    const page = await s.load();
    expect(requestProblems(page.request)).toEqual([]);
    expect(page.request.simulation).toBe(true);
    // The real source refuses it.
    expect(requestProblems(page.request, { real: true })[0]).toMatch(/simulation/);
    expect(page.link_id).toMatch(/^sim-[a-z0-9-]{1,40}$/);
    expect(typeof SCENARIOS[name].title).toBe('string');
  });

  test('an unknown scenario has no source', () => expect(simSource('nope')).toBeNull());

  test('desktop answers come in order, one per ask, the last repeating', async () => {
    const s = simSource('dataop-update', { desktop: ['no_extension', 'running'] });
    expect((await s.checkDesktop()).answer).toBe('no_extension');
    expect((await s.checkDesktop()).answer).toBe('running');
    expect((await s.checkDesktop()).answer).toBe('running');
    expect((await simSource('dataop-update').checkDesktop())).toEqual({ answer: 'running', panel: true, helper: true });
  });

  test('nothing leaves the browser', async () => {
    global.fetch = jest.fn();
    const s = simSource('dataop-update');
    await s.load();
    await s.checkDesktop();
    await s.approve();
    await s.cancel('x');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('every made-up answer has the same shape as a real one', async () => {
    for (const answer of DESKTOP_ANSWERS) {
      expect(await simSource('dataop-update', { desktop: [answer] }).checkDesktop()).toEqual(simulatedState(answer));
    }
    expect(DESKTOP_ANSWERS).toEqual(ANSWERS);
  });
});
