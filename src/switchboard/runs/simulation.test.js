import { requestProblems } from './runContract';
import { SCENARIOS, scenarioNames, simSource } from './simulation';

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
});
