import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import CodeReviewPage, { SUPERSEDED, TEXT_LABEL } from './CodeReviewPage';
import { reviewScenarioNames, reviewSimSource } from './simulation';

jest.mock('../../supabaseClient', () => ({ supabaseUrl: 'https://db.example', supabaseAnonKey: 'anon', supabase: { auth: {} } }));

const open = async (name, opts) => {
  const source = reviewSimSource(name, opts);
  const view = render(<CodeReviewPage source={source} />);
  await waitFor(() => expect(screen.getByTestId('run-headline')).toHaveAttribute('data-settled', 'true'));
  return { source, ...view };
};
/** The red bar and "I reviewed this code": together or not at all. */
const together = () => expect(Boolean(screen.queryByTestId('run-approval-required'))).toBe(Boolean(screen.queryByTestId('review-reviewed')));
const ackAll = () => screen.getAllByTestId('review-ack').forEach((box) => { if (!box.checked) fireEvent.click(box); });

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => expect(global.fetch).not.toHaveBeenCalled());

describe('the code review page, on sample data', () => {
  test('findings at the top: Fixed by the CLI, then For you with a tick and a note each', async () => {
    await open('review-code-fix');
    const findings = screen.getByTestId('review-findings');
    expect(within(findings).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Fixed by the CLI', 'For you']);
    expect(screen.getAllByTestId('review-fixed')).toHaveLength(1);
    expect(screen.getAllByTestId('review-for-you')).toHaveLength(2);
    expect(screen.getAllByTestId('review-ack')).toHaveLength(2);
    expect(screen.getAllByTestId('review-ack-note')).toHaveLength(2);
    // eslint-disable-next-line no-bitwise
    expect(findings.compareDocumentPosition(screen.getAllByTestId('review-file')[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('new files are shown whole, every line added, with a one-line note each', async () => {
    await open('review-logic-rerun');
    const files = screen.getAllByTestId('review-file');
    expect(files).toHaveLength(2);
    files.forEach((f) => {
      expect(within(f).getByTestId('review-file-labels')).toHaveTextContent('New file · P1a');
      expect(within(f).getAllByTestId('review-row').every((r) => r.dataset.type === 'add')).toBe(true);
      expect(within(f).queryByTestId('review-whole')).toBeNull();
      expect(within(f).getAllByTestId('review-note')).toHaveLength(1);
    });
  });

  test('a changed file: changes with context, its labels, notes directly above the change, and Show the whole file', async () => {
    await open('review-code-fix');
    const file = screen.getByTestId('review-file');
    expect(within(file).getByTestId('review-file-labels')).toHaveTextContent('Changed file · P1a, P3');
    const compact = within(file).getAllByTestId('review-row').length;
    expect(within(file).getAllByTestId('review-hunk').length).toBeGreaterThan(0);
    // Each note sits directly above the change it explains: the row before it is unchanged, the row after it is the
    // first row of the change (its removed line, here), never between the removed and the added lines.
    within(file).getAllByTestId('review-note').forEach((n) => {
      expect(n.previousElementSibling?.dataset.type ?? 'same').toBe('same');
      expect(['del', 'add']).toContain(n.nextElementSibling.dataset.type);
    });
    fireEvent.click(within(file).getByTestId('review-whole'));
    expect(within(file).getAllByTestId('review-row').length).toBeGreaterThan(compact);
    // The whole file keeps the changes marked.
    expect(within(file).getAllByTestId('review-row').some((r) => r.dataset.type === 'add')).toBe(true);
    expect(within(file).getByTestId('review-whole')).toHaveTextContent('Show only the changes');
  });

  test('the status line names the commit and when it passed the rehearsal', async () => {
    await open('review-code-fix');
    expect(screen.getByTestId('review-status')).toHaveTextContent(/commit 4f9c2ab.*, passed the rehearsal /);
  });

  test('I reviewed this code is greyed until every For you finding is acknowledged; the red bar goes with it', async () => {
    const { source } = await open('review-code-fix');
    together();
    expect(screen.getByTestId('review-reviewed')).toBeDisabled();
    expect(screen.getByTestId('review-reviewed-why')).toBeInTheDocument();
    ackAll();
    expect(screen.getByTestId('review-reviewed')).toBeEnabled();
    const spy = jest.spyOn(source, 'reviewed');
    await act(async () => { fireEvent.click(screen.getByTestId('review-reviewed')); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('run-result-line')).toHaveTextContent('SIMULATION review sim-review-code-fix reviewed');
    expect(screen.queryByTestId('review-reviewed')).toBeNull();
    together();
  });

  test('all acknowledged already: I reviewed this code is ready, and the notes are kept', async () => {
    await open('review-all-acknowledged');
    expect(screen.getByTestId('review-reviewed')).toBeEnabled();
    expect(screen.getAllByTestId('review-ack-note')[0]).toHaveValue('Checked with the client: inactive campaigns never take gifts.');
  });

  test('the text box is required for both buttons; a question keeps the review open, on the same commit, ticks kept', async () => {
    const { source } = await open('review-code-fix');
    expect(screen.getByLabelText(TEXT_LABEL)).toBeInTheDocument();
    expect(screen.getByTestId('review-ask')).toBeDisabled();
    expect(screen.getByTestId('review-changes')).toBeDisabled();
    fireEvent.click(screen.getAllByTestId('review-ack')[0]);
    fireEvent.change(screen.getByLabelText(TEXT_LABEL), { target: { value: 'Why skip inactive campaigns?' } });
    const ask = jest.spyOn(source, 'question');
    await act(async () => { fireEvent.click(screen.getByTestId('review-ask')); });
    // The ticks go with the question, so they are kept on the review.
    expect(ask).toHaveBeenCalledWith('Why skip inactive campaigns?', { y1: { note: '' } });
    expect(screen.getByTestId('run-result-line')).toHaveTextContent('SIMULATION review sim-review-code-fix question: Why skip inactive campaigns?');
    expect(screen.getAllByTestId('review-ack')[0]).toBeChecked();
    expect(screen.getByTestId('review-reviewed')).toBeInTheDocument();
    expect(screen.getByTestId('review-status')).toHaveTextContent('4f9c2ab');
  });

  test('changes required: the line carries the first 200 characters, the full text goes to the review', async () => {
    const { source } = await open('review-code-fix');
    const long = `Keep inactive campaigns. ${'x'.repeat(400)}`;
    fireEvent.change(screen.getByLabelText(TEXT_LABEL), { target: { value: long } });
    const spy = jest.spyOn(source, 'changes');
    await act(async () => { fireEvent.click(screen.getByTestId('review-changes')); });
    expect(spy).toHaveBeenCalledWith(long, {});
    const line = screen.getByTestId('run-result-line').querySelector('code').textContent;
    expect(line.startsWith('SIMULATION review sim-review-code-fix changes required: Keep inactive campaigns.')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('SIMULATION review sim-review-code-fix changes required: '.length + 200);
    expect(screen.getByTestId('review-done')).toHaveTextContent('Not approved. Changes required.');
    expect(screen.queryByRole('button', { name: /I reviewed/ })).toBeNull();
    together();
  });

  test('superseded: the page says so and shows no buttons', async () => {
    await open('review-superseded');
    expect(screen.getByTestId('review-superseded')).toHaveTextContent(SUPERSEDED);
    expect(screen.queryAllByRole('button').filter((b) => b.dataset.testid !== 'review-whole')).toEqual([]);
    expect(screen.getAllByTestId('review-ack').every((b) => b.disabled)).toBe(true);
    together();
  });

  test('desktop not ready: no I reviewed and no red bar; the not-ready section; the question box still works', async () => {
    await open('review-all-acknowledged', { desktop: ['not_running'] });
    together();
    expect(screen.queryByTestId('review-reviewed')).toBeNull();
    expect(screen.getByTestId('run-desktop-not-ready')).toBeInTheDocument();
    expect(screen.getByLabelText(TEXT_LABEL)).toBeEnabled();
  });

  test('the desktop is asked again at the click; not ready, nothing is sent', async () => {
    const { source } = await open('review-all-acknowledged', { desktop: ['running', 'helper_down'] });
    const spy = jest.spyOn(source, 'reviewed');
    await act(async () => { fireEvent.click(screen.getByTestId('review-reviewed')); });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-desktop-not-ready')).toBeInTheDocument();
    together();
  });

  test('the ticks are locked while the click waits on the desktop, so what is sent is what was acknowledged', async () => {
    const { source } = await open('review-all-acknowledged');
    let answer;
    jest.spyOn(source, 'checkDesktop').mockImplementation(() => new Promise((res) => { answer = res; }));
    const spy = jest.spyOn(source, 'reviewed');
    await act(async () => { fireEvent.click(screen.getByTestId('review-reviewed')); });
    expect(screen.getAllByTestId('review-ack').every((b) => b.disabled)).toBe(true);
    await act(async () => { answer({ answer: 'running', panel: true, helper: true }); });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ y1: expect.any(Object), y2: expect.any(Object) }));
    expect(screen.getByTestId('review-done')).toHaveFocus();
  });

  test('a refused review shows why and nothing else: no findings, no code, no buttons, no red bar', async () => {
    const source = reviewSimSource('review-code-fix');
    const load = source.load;
    source.load = async () => {
      const page = await load();
      return { ...page, review: { ...page.review, notes: [{ ...page.review.notes[0], start_line: 1, end_line: 1 }] } };
    };
    render(<CodeReviewPage source={source} />);
    expect(await screen.findByTestId('review-problems')).toHaveTextContent("aren't changed lines");
    expect(screen.queryByTestId('review-findings')).toBeNull();
    expect(screen.queryByTestId('review-file')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    together();
  });

  test('each tick is named for its finding', async () => {
    await open('review-code-fix');
    expect(screen.getByRole('checkbox', { name: /^Acknowledge: Inactive campaigns are now skipped/ })).toBeInTheDocument();
  });

  test.each(reviewScenarioNames())('%s: a simulation never carries a run-id mark or the extension status block', async (name) => {
    const { container } = await open(name);
    expect(container.querySelector('[data-switchboard-run-id]')).toBeNull();
    expect(container.querySelector('[data-switchboard-kind]')).toHaveAttribute('data-switchboard-kind', 'simulation');
    expect(screen.getByTestId('run-simulation')).toBeInTheDocument();
  });
});

describe('A7 fixes on the code review page', () => {
  test('the full window width, keeping the side margins; the run pages keep max-w-3xl', async () => {
    await open('review-code-fix');
    expect(screen.getByTestId('run-card').className).not.toMatch(/max-w-3xl/);
  });

  test("code never wraps; only the file's code box scrolls sideways", async () => {
    await open('review-code-fix');
    const box = screen.getAllByTestId('review-code')[0];
    expect(box.className).toMatch(/overflow-x-auto/);
    // eslint-disable-next-line testing-library/no-node-access
    const code = box.querySelector('[data-testid="review-row"] span:last-child');
    expect(code.className).toMatch(/whitespace-pre(?!-)/);
    expect(code.className).not.toMatch(/break-all|whitespace-pre-wrap/);
  });

  test("a new file's note sits at the very top, above line 1, outside the code", async () => {
    await open('review-logic-rerun');
    screen.getAllByTestId('review-file').forEach((f) => {
      const note = within(f).getByTestId('review-note');
      // eslint-disable-next-line no-bitwise
      expect(note.compareDocumentPosition(within(f).getByTestId('review-code')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(within(f).getByTestId('review-code')).queryByTestId('review-note')).toBeNull();
    });
  });

  test.each([0, 1])("new file %i of review-logic-rerun: the note is at the very top, before line 1, whatever line it names", async (n) => {
    await open('review-logic-rerun');
    const file = screen.getAllByTestId('review-file')[n];
    const note = within(file).getByTestId('review-note');
    const rows = within(file).getAllByTestId('review-row');
    expect(rows[0]).toHaveAttribute('data-new-line', '1');
    // Before line 1 and every other row; nothing of the code comes before it.
    // eslint-disable-next-line no-bitwise
    rows.forEach((row) => expect(note.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    // eslint-disable-next-line testing-library/no-node-access
    expect(note.parentElement).toBe(file);
  });

  test('a note label reads "line 2" for one line and "lines 9-11" for a range', async () => {
    const view = await open('review-logic-rerun');
    expect(screen.getAllByTestId('review-note')[1]).toHaveTextContent("Claude's note, P1a, line 2");
    view.unmount();
    await open('review-code-fix');
    expect(screen.getAllByTestId('review-note')[0]).toHaveTextContent("Claude's note, P3, lines 9-11");
  });

  test('superseded: the ticks and note boxes are visibly locked', async () => {
    await open('review-superseded');
    screen.getAllByTestId('review-ack').forEach((b) => {
      expect(b).toBeDisabled();
      expect(b.className).toMatch(/border-dashed/);
      expect(b.className).toMatch(/cursor-not-allowed/);
    });
    screen.getAllByTestId('review-ack-note').forEach((b) => expect(b.className).toMatch(/(^| )border-dashed/));
    expect(screen.getAllByTestId('review-locked')[0]).toHaveTextContent('locked: this review is superseded');
  });

  test("an open review's disabled note boxes only dim: the locked look is for a superseded review", async () => {
    await open('review-code-fix');
    screen.getAllByTestId('review-ack-note').forEach((b) => {
      expect(b).toBeDisabled();
      expect(b.className).not.toMatch(/border-dashed/);
    });
    expect(screen.queryByTestId('review-locked')).toBeNull();
  });

  test('a refused review is drawn at the run pages\' width', async () => {
    const source = reviewSimSource('review-code-fix');
    const load = source.load;
    source.load = async () => {
      const page = await load();
      return { ...page, review: { ...page.review, notes: [{ ...page.review.notes[0], start_line: 1, end_line: 1 }] } };
    };
    render(<CodeReviewPage source={source} />);
    await screen.findByTestId('review-problems');
    expect(screen.getByTestId('run-card').className).toMatch(/max-w-3xl/);
  });
});
