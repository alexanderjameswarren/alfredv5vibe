import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import RunPage from './RunPage';
import { simSource } from './simulation';
import { UNDO_NO_SAMPLE, allowsProblems, allowsView } from './runContract';

// s28 (O2): the checked top-level allows, beside the diagnosis_allows sentences, drawn on the run page. And item c:
// the undo page says why it has no sample record.

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const GOOD = {
  mode: 'frozen',
  kinds: [{ kind: 'Gift edited by a person', limit: 2, reason: 'Edited gifts are skipped.' }, { kind: 'New gift', limit: 0, reason: 'None may appear.' }],
  integrations: { allowed: true, reason: 'The sync only reads.' },
  failure_tolerance: { rows: 1, reason: 'One locked row may fail.' },
};

/** A scenario with its request changed, through the same simulated source. */
function withRequest(name, over) {
  const base = simSource(name);
  return { ...base, load: async () => { const p = await base.load(); return { ...p, request: { ...p.request, ...over } }; } };
}

describe('allowsProblems and allowsView', () => {
  test('absent is fine, and draws nothing', () => {
    expect(allowsProblems(undefined)).toEqual([]);
    expect(allowsView(undefined)).toBeNull();
  });
  test('a whole allows is fine, and is drawn as it is', () => {
    expect(allowsProblems(GOOD)).toEqual([]);
    expect(allowsView(GOOD)).toBe(GOOD);
    expect(allowsProblems({ ...GOOD, kinds: [] })).toEqual([]);
  });
  test.each([
    ['not an object', [1], /Fix allows: \{mode/],
    ['null', null, /Fix allows: \{mode/],
    ['an unknown mode', { ...GOOD, mode: 'still' }, /Fix allows.mode: frozen or moving/],
    ['a missing mode', { ...GOOD, mode: undefined }, /Fix allows.mode/],
    ['kinds not a list', { ...GOOD, kinds: {} }, /Fix allows.kinds: a list/],
    ['a negative limit', { ...GOOD, kinds: [{ kind: 'k', limit: -1, reason: 'r' }] }, /Fix allows.kinds\[0\]/],
    ['a fractional limit', { ...GOOD, kinds: [{ kind: 'k', limit: 1.5, reason: 'r' }] }, /Fix allows.kinds\[0\]/],
    ['a kind with no reason', { ...GOOD, kinds: [{ kind: 'k', limit: 1 }] }, /Fix allows.kinds\[0\]/],
    ['a kind with an extra key', { ...GOOD, kinds: [{ kind: 'k', limit: 1, reason: 'r', note: 'x' }] }, /Fix allows.kinds\[0\]/],
    ['integrations allowed as text', { ...GOOD, integrations: { allowed: 'yes', reason: 'r' } }, /Fix allows.integrations/],
    ['integrations with no reason', { ...GOOD, integrations: { allowed: false } }, /Fix allows.integrations/],
    ['a tolerance in text', { ...GOOD, failure_tolerance: { rows: 'one', reason: 'r' } }, /Fix allows.failure_tolerance/],
    ['a tolerance with an extra key', { ...GOOD, failure_tolerance: { rows: 1, reason: 'r', percent: 2 } }, /Fix allows.failure_tolerance/],
    ['an extra key', { ...GOOD, details: {} }, /Fix allows: leave out details/],
  ])('refused: %s', (_, a, pattern) => {
    expect(allowsProblems(a).join(' ')).toMatch(pattern);
    expect(allowsView(a)).toBeNull();
  });
});

describe('the run page draws allows', () => {
  test('drawn beside the sentences: the mode, each kind, integrations and the tolerance', async () => {
    render(<RunPage source={simSource('dataop-allows')} />);
    const box = await screen.findByTestId('run-allows-structured');
    expect(box).toHaveAttribute('data-mode', 'moving');
    expect(screen.getByTestId('run-allows-mode')).toHaveTextContent('Mode: moving');
    expect(screen.getAllByTestId('run-allows-kind').map((k) => k.textContent))
      .toEqual(['Gift edited by a person: up to 2. Fundraisers edit gifts during the day; an edited gift is skipped.']);
    expect(screen.getByTestId('run-allows-integrations')).toHaveTextContent('Integrations: not allowed. The payment sync is paused for the run.');
    expect(screen.getByTestId('run-allows-tolerance')).toHaveTextContent('Failures tolerated: up to 0 rows. Every gift must be written, or the run stops.');
    // The sentences stay as they were.
    expect(screen.getByTestId('run-allows')).toHaveTextContent('Other gifts may change while it runs; only these 45 are written.');
  });

  test('frozen, an allowed integration and one row', async () => {
    render(<RunPage source={withRequest('dataop-update', { allows: GOOD })} />);
    expect(await screen.findByTestId('run-allows-mode')).toHaveTextContent('Mode: frozen');
    expect(screen.getAllByTestId('run-allows-kind')).toHaveLength(2);
    expect(screen.getByTestId('run-allows-integrations')).toHaveTextContent('Integrations: allowed. The sync only reads.');
    expect(screen.getByTestId('run-allows-tolerance')).toHaveTextContent('up to 1 row. One locked row may fail.');
  });

  test('absent: nothing drawn', async () => {
    render(<RunPage source={simSource('dataop-update')} />);
    await screen.findByTestId('run-problem');
    expect(screen.queryByTestId('run-allows-structured')).toBeNull();
  });

  test('malformed: nothing drawn, never half', async () => {
    render(<RunPage source={withRequest('dataop-update', { allows: { ...GOOD, mode: 'still' } })} />);
    await screen.findByTestId('run-problem');
    expect(screen.queryByTestId('run-allows-structured')).toBeNull();
  });
});

describe('item c: the undo page with no sample record', () => {
  test('says why: an undo has no pre-check', async () => {
    render(<RunPage source={withRequest('undo', {})} />);
    await screen.findByTestId('run-problem');
    // The simulated undo carries a sample; with none, the page explains.
    expect(screen.queryByTestId('run-sample-none')).toBeNull();
    const base = simSource('undo');
    const none = { ...base, load: async () => ({ ...(await base.load()), sample: null }) };
    render(<RunPage source={none} />);
    expect(await screen.findByTestId('run-sample-none')).toHaveTextContent(UNDO_NO_SAMPLE);
    expect(UNDO_NO_SAMPLE).toBe('No sample record here: an undo has no pre-check. The terminal shows a fresh sample before it counts.');
  });

  test('a closed undo (past its deadline) with no sample says nothing: it counts nothing', async () => {
    const base = simSource('undo-closed');
    render(<RunPage source={{ ...base, load: async () => ({ ...(await base.load()), sample: null }) }} />);
    await screen.findByTestId('run-undo-closed');
    expect(screen.queryByTestId('run-sample-none')).toBeNull();
  });

  test('a data operation with no sample shows neither', async () => {
    const base = simSource('dataop-update');
    render(<RunPage source={{ ...base, load: async () => ({ ...(await base.load()), sample: null }) }} />);
    await screen.findByTestId('run-problem');
    expect(screen.queryByTestId('run-sample-none')).toBeNull();
    expect(screen.queryByTestId('run-sample')).toBeNull();
  });
});
