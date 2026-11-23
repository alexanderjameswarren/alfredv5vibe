import { Fragment, useEffect, useRef, useState } from 'react';
import {
  BUTTON, DIFF_ADD, DIFF_DEL, DIFF_ROW, LINK_BUTTON, LOCKED_INPUT, LOCKED_TICK, NOTE_BOX, NOT_READY_BOX, PANEL, REASON_INPUT, ResultLine, RunShell,
  SECOND_BUTTON, isSimulation, localTime, shortHash,
} from './look';
import { REVIEW_TEXT_MAX, codeReviewProblems, reviewChangesLine, reviewQuestionLine, reviewReviewedLine } from './runContract';
import { desktopLine, notReadyReason } from './desktopCheck';
import { diffRows, hunks, noteAnchor } from './codeDiff';

// sb3_pages-h6v A6: the Salesforce code review page (spec 3.2 f). One scroll: the findings, then each file's inline
// diff drawn here from jsdiff's rows, with Claude's notes above the changes they explain. It reads through a source
// (the simulated one until B4), when the page opens and when Alex clicks; nothing runs on a timer.

const NO_ANSWER = { answer: 'no_answer', panel: false, helper: false };
export const TEXT_LABEL = 'Your question or the change needed (sent to the thread)';
export const SUPERSEDED = 'The code has changed since this review. A new review comes after the next rehearsal.';

/** One diff row: a marker column (+, -, space), the line numbers, the text. */
function Row({ row }) {
  const cls = row.type === 'add' ? DIFF_ADD : row.type === 'del' ? DIFF_DEL : '';
  const mark = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
  return (
    <div data-testid="review-row" data-type={row.type} data-new-line={row.newNo ?? ''} className={`flex ${cls}`}>
      <span aria-hidden="true" className="w-6 shrink-0 text-right pr-1 text-muted-foreground font-mono text-xs">{row.oldNo ?? ''}</span>
      <span aria-hidden="true" className="w-6 shrink-0 text-right pr-1 text-muted-foreground font-mono text-xs">{row.newNo ?? ''}</span>
      <span aria-hidden="true" className="w-4 shrink-0 font-mono text-xs">{mark}</span>
      {/* Read aloud: whether the line was added or removed, and its line number; colour and marker are visual only. */}
      {row.type !== 'same' && <span className="sr-only">{row.type === 'add' ? `added, line ${row.newNo}: ` : `removed, old line ${row.oldNo}: `}</span>}
      <span className={`${DIFF_ROW} pr-2`}>{row.text || ' '}</span>
    </div>
  );
}

/** Claude's note: pale orange, on the page only, never in the code. */
function Note({ note, inCode = true }) {
  return (
    // Inside a code box that scrolls sideways, a note stays in view at the left and wraps as prose.
    <div data-testid="review-note" data-file={note.file} data-start={note.start_line} className={`${NOTE_BOX} my-1 ${inCode ? 'sticky left-0 max-w-[100cqw] whitespace-normal' : ''}`}>
      <p className="m-0 font-medium">Claude's note, {note.problem_label}, {note.start_line === note.end_line ? `line ${note.start_line}` : `lines ${note.start_line}-${note.end_line}`}</p>
      <p className="m-0 break-words whitespace-pre-line">{note.text}</p>
    </div>
  );
}

/** Rows with each note set directly above the change it explains (noteAnchor: before any removed lines). */
function Rows({ rows, notes }) {
  const at = new Map();
  notes.forEach((n) => {
    const i = noteAnchor(rows, n);
    if (i >= 0) at.set(i, [...(at.get(i) ?? []), n]);
  });
  return rows.map((row, i) => (
    <Fragment key={`${row.type}-${row.oldNo}-${row.newNo}-${i}`}>
      {(at.get(i) ?? []).map((n, k) => <Note key={`${n.file}-${n.start_line}-${k}`} note={n} />)}
      <Row row={row} />
    </Fragment>
  ));
}

/** One file: header with its problem labels, then the whole new file, or the changes with context and a toggle. */
function FileDiff({ file, notes }) {
  const [whole, setWhole] = useState(false);
  const rows = diffRows(file);
  const mine = notes.filter((n) => n.file === file.path);
  const compact = file.status === 'modified' && !whole;
  return (
    <section data-testid="review-file" data-path={file.path} className={`${PANEL} min-w-0`}>
      <h3 className="font-mono text-sm font-bold break-all m-0">{file.path}</h3>
      <p data-testid="review-file-labels" className="m-0 mb-2 text-sm">
        {file.status === 'new' ? 'New file' : file.status === 'deleted' ? 'Deleted file' : 'Changed file'}
        {Array.isArray(file.problem_labels) && file.problem_labels.length ? ` · ${file.problem_labels.join(', ')}` : ''}
      </p>
      {/* A new file's notes sit at the very top, above line 1 (A7). */}
      {file.status === 'new' && mine.map((n, k) => <Note key={`${n.file}-${n.start_line}-${k}`} note={n} inCode={false} />)}
      {/* Only this box scrolls sideways when a line is longer than the window; code never wraps. */}
      {/* The box is a size container, so a note inside is at most the box's own width (100cqw). */}
      <div data-testid="review-code" className="bg-white rounded border border-border overflow-x-auto [container-type:inline-size]">
        <div className="w-max min-w-full">
          {compact
            ? hunks(rows).map((hk, i) => (
              <div key={i} data-testid="review-hunk">
                {hk.hiddenBefore > 0 && <p className="m-0 px-2 py-1 text-xs text-muted-foreground bg-primary-bg">{hk.hiddenBefore} unchanged {hk.hiddenBefore === 1 ? 'line' : 'lines'}</p>}
                <Rows rows={hk.rows} notes={mine} />
                {hk.hiddenAfter > 0 && <p className="m-0 px-2 py-1 text-xs text-muted-foreground bg-primary-bg">{hk.hiddenAfter} unchanged {hk.hiddenAfter === 1 ? 'line' : 'lines'}</p>}
              </div>
            ))
            : <Rows rows={rows} notes={file.status === 'new' ? [] : mine} />}
        </div>
      </div>
      {file.status === 'modified' && (
        <button type="button" data-testid="review-whole" aria-expanded={whole} className={`${LINK_BUTTON} mt-2`} onClick={() => setWhole((w) => !w)}>
          {whole ? 'Show only the changes' : 'Show the whole file'}
        </button>
      )}
    </section>
  );
}

export default function CodeReviewPage({ source }) {
  const sim = isSimulation(source);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [desktop, setDesktop] = useState(null);
  const [rechecked, setRechecked] = useState(false);
  const [acks, setAcks] = useState({});
  const [text, setText] = useState('');
  const [lines, setLines] = useState([]);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  // Read once when the page opens: the review, then the desktop. Never again by itself.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const page = await source.load();
        if (!live) return;
        setLoaded(page);
        // Acknowledgements kept from an earlier visit (or an earlier question) come with the review.
        setAcks(page.review?.acknowledged ?? {});
        const d = await source.checkDesktop().catch(() => NO_ANSWER);
        if (live) setDesktop(d);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, [source]);

  const inFlight = useRef(false);
  const once = (fn) => async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try { await fn(); } catch (e) { setNote(`${e instanceof Error ? e.message : String(e)} Nothing was sent.`); } finally { inFlight.current = false; setBusy(false); }
  };

  const cr = loaded?.review;
  const problems = cr ? codeReviewProblems(cr) : [];
  const superseded = Boolean(cr?.superseded_by);
  const forYou = cr?.findings?.for_you ?? [];
  const allAcked = forYou.every((f) => acks[f.id]);
  const ready = desktop?.answer === 'running';
  // "I reviewed this code" and the red bar: one value. Greyed (still offered) until every finding is acknowledged.
  const canReview = Boolean(cr) && !problems.length && !superseded && !done && ready;
  const notReady = Boolean(cr) && !problems.length && !superseded && !done && Boolean(desktop) && !ready;
  const hasText = text.trim().length > 0;
  const linkId = loaded?.link_id;

  const checkAgain = once(async () => {
    setDesktop(await source.checkDesktop().catch(() => NO_ANSWER));
    setRechecked(true);
  });
  // The ticks as they are now, for a click that waited on the desktop (the inputs are disabled meanwhile, too).
  const acksNow = useRef(acks);
  acksNow.current = acks;
  const doneRef = useRef(null);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const reviewed = once(async () => {
    // At the click (Q9): the desktop once more; not ready approves nothing.
    const d = await source.checkDesktop().catch(() => NO_ANSWER);
    setDesktop(d);
    setRechecked(true);
    const a = acksNow.current;
    if (d.answer !== 'running' || !forYou.every((f) => a[f.id])) return;
    const line = reviewReviewedLine(linkId);
    await source.reviewed(a);
    setLines((l) => [...l, line]);
    setDone('reviewed');
  });
  // The ticks and notes go with every answer, so they are kept on the review across questions and visits.
  const question = once(async () => {
    const t = text.trim();
    const line = reviewQuestionLine(linkId, t);
    await source.question(t, acksNow.current);
    // The review stays open on the same commit; the ticks are kept.
    setLines((l) => [...l, line]);
    setText('');
  });
  const changes = once(async () => {
    const t = text.trim();
    const line = reviewChangesLine(linkId, t);
    await source.changes(t, acksNow.current);
    setLines((l) => [...l, line]);
    setDone('changes');
  });

  if (error) return <RunShell source={source}><p data-testid="run-error" className="text-dark break-words">{error}</p></RunShell>;
  if (!cr) return <RunShell source={source}><p className="text-muted">Loading…</p></RunShell>;
  // A refused review shows why, and nothing else: no findings, no code, no buttons.
  if (problems.length) {
    return (
      <RunShell source={source}>
        <p data-testid="run-headline" data-settled="true" className="font-bold text-dark mb-2 break-words">{cr.headline}</p>
        <div data-testid="review-problems" role="alert" className={NOT_READY_BOX}>
          <p className="font-bold m-0 mb-1">This review can't be shown</p>
          <ul className="list-disc pl-6 m-0">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      </RunShell>
    );
  }

  const notes = Array.isArray(cr.notes) ? cr.notes : [];
  return (
    <RunShell source={source} approvable={canReview} wide>
      <p data-testid="run-headline" data-settled={desktop ? 'true' : 'false'} className="font-bold text-dark mb-2 break-words">{cr.headline}</p>
      <p className="text-sm text-dark">Project</p>
      <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={cr.project_code} data-switchboard-kind={sim ? 'simulation' : 'review'}>{cr.project_code}</p>
      <h2 className="text-xl font-bold text-dark mb-1">Code review</h2>
      <p data-testid="review-status" className="text-sm text-dark mb-4 break-words">
        {cr.repo}: commit <span className="font-mono font-bold">{shortHash(cr.commit)}</span>, passed the rehearsal {localTime(cr.rehearsed_at)}.
        {superseded && <> Newer commit <span className="font-mono font-bold">{shortHash(cr.superseded_by)}</span>.</>}
      </p>

      {superseded && (
        <div data-testid="review-superseded" className={PANEL}>
          <p className="font-bold m-0">{SUPERSEDED}</p>
        </div>
      )}

      <section data-testid="review-findings" className="mb-4 text-sm text-dark min-w-0">
        <h2 className="text-lg font-bold mb-2">Fixed by the CLI</h2>
        <ul className="list-disc pl-6 space-y-1 mb-3">
          {(cr.findings?.fixed_by_cli ?? []).map((f) => <li key={f.id} data-testid="review-fixed" className="break-words">{f.text}</li>)}
        </ul>
        <h2 className="text-lg font-bold mb-2">For you</h2>
        <ul className="space-y-3 m-0 p-0 list-none">
          {forYou.map((f) => (
            <li key={f.id} data-testid="review-for-you" data-id={f.id} className="break-words">
              <p className="m-0 mb-1">{f.text}{f.file ? <span className="block font-mono text-xs break-all">{f.file}{f.lines ? `, line ${f.lines}` : ''}</span> : null}</p>
              {/* Superseded: visibly locked (greyed, dashed, not-allowed), with the reason beside the tick (A7). */}
              <label data-locked={superseded ? 'true' : 'false'} className={`inline-flex items-center gap-2 min-h-[44px] ${superseded ? 'text-gray-500 cursor-not-allowed' : ''}`}>
                <input type="checkbox" data-testid="review-ack" aria-label={`Acknowledge: ${f.text}`} checked={Boolean(acks[f.id])} disabled={busy || superseded || Boolean(done)}
                  className={superseded ? LOCKED_TICK : 'disabled:opacity-50'}
                  onChange={(e) => setAcks((a) => { const next = { ...a }; if (e.target.checked) next[f.id] = { note: a[f.id]?.note ?? '' }; else delete next[f.id]; return next; })} />
                Acknowledge
                {superseded && <span data-testid="review-locked" className="text-xs">(locked: this review is superseded)</span>}
              </label>
              <input type="text" aria-label={`Note on: ${f.text}`} data-testid="review-ack-note" maxLength={200} placeholder="Note (optional)"
                className={`${REASON_INPUT} mt-1 ${superseded ? LOCKED_INPUT : 'disabled:opacity-60'}`} value={acks[f.id]?.note ?? ''} disabled={busy || !acks[f.id] || superseded || Boolean(done)}
                onChange={(e) => setAcks((a) => ({ ...a, [f.id]: { note: e.target.value } }))} />
            </li>
          ))}
        </ul>
      </section>

      {(cr.files ?? []).map((f) => <FileDiff key={f.path} file={f} notes={notes} />)}

      {!notReady && !superseded && (
        <p data-testid="run-desktop" data-answer={desktop?.answer ?? 'checking'} className="mb-4 text-sm text-dark break-words">
          {desktopLine(desktop, rechecked, { fix: ready || !desktop })}
        </p>
      )}
      {note && <p data-testid="run-note" role="alert" className="mb-4 text-dark break-words">{note}</p>}

      {lines.map((l, i) => <div key={i} className="mb-2"><ResultLine line={l} sim={sim} /></div>)}

      {!superseded && !done && (
        <>
          {notReady && (
            <section data-testid="run-desktop-not-ready" aria-labelledby="review-not-ready-heading" className={NOT_READY_BOX}>
              <h2 id="review-not-ready-heading" className="text-lg font-bold mb-1">Desktop not ready</h2>
              <p data-testid="run-desktop" role="status" data-answer={desktop.answer} className="m-0 mb-3 break-words">{notReadyReason(desktop, rechecked)}</p>
              <button data-testid="run-check-again" className={BUTTON} disabled={busy} onClick={checkAgain}>Check again</button>
            </section>
          )}
          <label htmlFor="review-text" className="block text-sm text-dark mb-1">{TEXT_LABEL}</label>
          <textarea id="review-text" data-testid="review-text" className={`${REASON_INPUT} mb-3`} rows={3} maxLength={REVIEW_TEXT_MAX}
            value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-col sm:flex-row gap-3 mb-3">
            <button data-testid="review-ask" className={SECOND_BUTTON} disabled={busy || !hasText} onClick={question}>Ask a question</button>
            <button data-testid="review-changes" className={SECOND_BUTTON} disabled={busy || !hasText} onClick={changes}>Not approved. Changes required.</button>
          </div>
          {canReview && (
            <>
              <button data-testid="review-reviewed" data-action className={BUTTON} disabled={busy || !allAcked} onClick={reviewed}>I reviewed this code</button>
              {!allAcked && <p data-testid="review-reviewed-why" className="text-sm text-dark mt-1">Acknowledge every "For you" finding first.</p>}
            </>
          )}
        </>
      )}
      {done && (
        <div data-testid="review-done" role="status" tabIndex={-1} ref={doneRef} className={PANEL}>
          <p className="font-medium m-0">{done === 'reviewed' ? 'Reviewed.' : 'Not approved. Changes required.'}{sim ? ' Simulated: nothing was sent.' : ''}</p>
        </div>
      )}
    </RunShell>
  );
}
