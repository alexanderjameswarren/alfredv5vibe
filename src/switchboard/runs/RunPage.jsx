import { Fragment, useEffect, useRef, useState } from 'react';
import {
  BUTTON, NOT_READY_BOX, OrgBanners, OrgPill, PANEL, ReasonInput, ResultLine, RunShell, SECOND_BUTTON, isSimulation, localTime, refusalNote,
  shortHash,
} from './look';
import {
  PHASE_HEADERS, RERUN_LABEL, STOPS_AT_FIRST_FAILURE, afterApproveLines, approveLabel, bannerLines, checkWord, clientOrgLine,
  countDetail, countSentence, daysLeftLine, groupedSteps, knockOnLines, notStarted, pageExpired, phaseWord, rehearsalOrg,
  rerunRequest, selectedByText, runCancelledLine, runLine, runRerunsLine, runResentLine, sampleRoleLabel, stillValid, targetOrg, undoClosedReason,
  undoHasDeadline, undoLine, undoScopeLine, validUntil, whatChanges,
} from './runContract';
import { desktopLine, notReadyReason } from './desktopCheck';

const NO_ANSWER = { answer: 'no_answer', panel: false, helper: false };

// sb3_pages-h6v A2: the Switchboard 3 run page (docs/technical-spec-sb3_pages-h6v.md part 3), parts 1-16 in the agreed
// order, for the pre-check and rehearsal page and the data operation page. It reads through a source: the simulated
// one (simulation.js) until B4 adds the real one. Status is read when the page opens and when Alex clicks; nothing
// runs on a timer. A3 added the desktop states (desktopCheck.js); A5 adds the expired, not started and check states.

export { desktopLine };

/** Part 7: the problem box. */
function ProblemBox({ r, closed }) {
  const t = targetOrg(r);
  const sel = r.selected_by ?? {};
  const knockOn = knockOnLines(r);
  const daysLeft = daysLeftLine(r);
  const undoScope = undoScopeLine(r);
  return (
    <dl data-testid="run-problem" className={`${PANEL} grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2`}>
      <dt className="font-medium">Problem</dt>
      <dd className="min-w-0 break-words"><span data-testid="run-problem-label" className="font-bold mr-2">{r.problem?.label}</span>{r.problem?.sentence}</dd>
      <dt className="font-medium">What changes</dt><dd data-testid="run-what-changes" className="min-w-0 break-words">{whatChanges(r)}</dd>
      <dt className="font-medium">Selected by</dt>
      <dd data-testid="run-selected-by" className="min-w-0 break-words">
        {sel.sandbox_text ? <>Production: {sel.text}<span className="block">Sandbox: {sel.sandbox_text}</span></> : selectedByText(r)}
        {sel.not_rehearsed && <span data-testid="run-not-rehearsed" className="block font-bold">Not rehearsed: {sel.not_rehearsed}</span>}
      </dd>
      <dt className="font-medium">Org</dt>
      <dd data-testid="run-org" className="min-w-0 font-mono break-all">
        {t?.alias}{rehearsalOrg(r) && <span className="block">{rehearsalOrg(r).alias} (sandbox rehearsal)</span>}
      </dd>
      <dt className="font-medium">Count</dt>
      <dd data-testid="run-count" className="min-w-0 break-words">{countDetail(r)}</dd>
      {knockOn.length > 0 && (
        <>
          <dt className="font-medium">Knock-on</dt>
          <dd data-testid="run-knock-on" className="min-w-0 break-words">{knockOn.map((k) => <span key={k} className="block">{k}</span>)}</dd>
        </>
      )}
      {daysLeft && (
        <>
          <dt className="font-medium">Recycle bin</dt>
          <dd data-testid="run-days-left" className="min-w-0 break-words">{daysLeft}</dd>
        </>
      )}
      {undoScope && (
        <>
          <dt className="font-medium">Undoes</dt>
          <dd data-testid="run-undo-scope" className="min-w-0 break-words">
            {undoScope}
            {/* Only a delete's undo has a deadline; an update's restores from the backup on the PC. */}
            {undoHasDeadline(r) && r.undo_of?.deadline && !closed && <span className="block">Undo possible until {localTime(r.undo_of.deadline)}.</span>}
          </dd>
        </>
      )}
      {r.page === 'check' && r.interrupted && (
        <>
          <dt className="font-medium">Interrupted</dt>
          <dd data-testid="run-interrupted" className="min-w-0 break-words">
            Run {r.interrupted.run_tag}{r.interrupted.at ? `, ${localTime(r.interrupted.at)}` : ''}{r.interrupted.where ? `: ${r.interrupted.where}` : ''}
          </dd>
        </>
      )}
      <dt className="font-medium">Side effects</dt><dd data-testid="run-side-effects" className="min-w-0 break-words">{r.side_effects}</dd>
      {Array.isArray(r.diagnosis_allows) && r.diagnosis_allows.length > 0 && (
        <>
          <dt className="font-medium">Diagnosis allows</dt>
          <dd data-testid="run-allows" className="min-w-0 break-words">{r.diagnosis_allows.map((a) => <span key={a} className="block">{a}</span>)}</dd>
        </>
      )}
    </dl>
  );
}

/** Part 8: the status line. */
function StatusLine({ r, run, closed }) {
  const until = validUntil(r.evidence);
  // A used link (A7): the phase being run reads running or finished, from the stored run, not "waiting".
  // A run that finished with a failure_reason stopped; it didn't finish.
  const live = run?.finished_at
    ? { word: run.failure_reason ? 'stopped' : 'finished', at: run.finished_at }
    : run?.picked_up_at ? { word: 'running', at: run.picked_up_at, lead: 'picked up ' } : null;
  return (
    <div data-testid="run-status" className="mb-4 text-sm text-dark break-words">
      {(r.phases ?? []).map((p) => {
        // A closed undo: "Undo: not offered…" replaces the Undo phase, never sits below it (s8b).
        if (closed && p.name === 'Undo') {
          return <p key={p.name} data-testid="run-undo-not-offered" className="m-0 font-medium">Undo: not offered, the deadline has passed.</p>;
        }
        const shown = live && p.state === 'waiting' ? live : null;
        return (
          <p key={p.name} data-testid="run-phase" data-state={p.state} data-live={shown ? shown.word : undefined} className="m-0">
            {p.name}: <span className="font-medium">{shown ? shown.word : phaseWord(p.state)}</span>{p.rerun ? ' (run again)' : ''}
            {shown ? `, ${shown.lead ?? ''}${localTime(shown.at)}` : p.at ? `, ${localTime(p.at)}` : ''}
          </p>
        );
      })}
      {/* An undo has no 24-hour expiry, only its own deadline (Alex, s6); a check reads only, so nothing expires. */}
      {r.page !== 'undo' && r.page !== 'check' && (
        <p data-testid="run-valid-until" className="m-0">
          {until ? `Checks valid until ${localTime(until)}.` : 'No checks have passed yet, so nothing expires.'}
        </p>
      )}
      <p data-testid="run-version" className="m-0">
        Request version {r.version ?? 1}{r.corrected_at ? `, corrected ${localTime(r.corrected_at)}` : ''}.
      </p>
      {r.kept?.sandbox_test_data && <p data-testid="run-kept-sandbox" className="m-0">Kept in the sandbox: {r.kept.sandbox_test_data}</p>}
      {r.kept?.temp_code_in_production && <p data-testid="run-kept-code" className="m-0">Temporary code in production: {r.kept.temp_code_in_production}</p>}
    </div>
  );
}

/** Part 9: "Changed since you last approved", only after a correction. */
function ChangedBlock({ changed }) {
  if (!changed) return null;
  return (
    <section data-testid="run-changed" className={PANEL}>
      <h2 className="text-lg font-bold mb-2">Changed since you last approved</h2>
      <table className="w-full border-collapse mb-2">
        <thead><tr className="text-left border-b border-border"><th className="pr-3 py-1 font-medium">What</th><th className="pr-3 py-1 font-medium">Was</th><th className="py-1 font-medium">Now</th></tr></thead>
        <tbody>
          {(changed.items ?? []).map((it) => (
            <tr key={it.what} className="border-b border-border align-top"><td className="pr-3 py-1">{it.what}</td><td className="pr-3 py-1 break-words">{it.old}</td><td className="py-1 font-bold break-words">{it.new}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 break-words">Why: {changed.reason}</p>
    </section>
  );
}

/** Part 10: the sample record, now and after. Not on the pre-check, which reads it. */
function SampleRecord({ r, sample }) {
  if (['precheck', 'correction', 'check'].includes(r.page) || !sample?.records?.length) return null;
  return (
    <section data-testid="run-sample" className={PANEL}>
      <h2 className="text-lg font-bold mb-2">Sample record</h2>
      {sample.records.map((rec) => (
        <div key={rec.id_label} data-testid="run-sample-record" data-role={rec.role} className="mb-2 overflow-x-auto">
          <p className="font-medium m-0 mb-1">
            {sampleRoleLabel(rec.role) && <span data-testid="run-sample-role" className="font-bold mr-2">{sampleRoleLabel(rec.role)}:</span>}
            {rec.id_label}
          </p>
          {typeof rec.child_count === 'number' && <p data-testid="run-sample-children" className="m-0 mb-1">{rec.child_count} child {rec.child_count === 1 ? 'record' : 'records'} deleted with it.</p>}
          {rec.deleted_by && (
            <p data-testid="run-sample-deleted" className="m-0 mb-1 break-words">
              Deleted by {rec.deleted_by}{rec.deleted_at ? `, ${localTime(rec.deleted_at)}` : ''}
              {typeof rec.days_left === 'number' ? `; ${rec.days_left} ${rec.days_left === 1 ? 'day' : 'days'} left in the recycle bin` : ''}.
            </p>
          )}
          <table className="w-full border-collapse">
            <thead><tr className="text-left border-b border-border"><th className="pr-3 py-1 font-medium">Field</th><th className="pr-3 py-1 font-medium">Now</th><th className="py-1 font-medium">After</th></tr></thead>
            <tbody>
              {(rec.fields ?? []).map((f) => (
                <tr key={f.name} className={`border-b border-border ${f.now !== f.after ? 'font-bold' : ''}`}>
                  <td className="pr-3 py-1 font-mono break-all">{f.name}</td><td className="pr-3 py-1 break-words">{f.now}</td><td className="py-1 break-words">{f.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

/** Screen d: "Still valid, not run again", each check with its time. */
function StillValid({ r }) {
  const list = stillValid(r);
  if (!list.length) return null;
  return (
    <section data-testid="run-still-valid" className="mb-4 text-sm text-dark min-w-0">
      <h2 className="text-lg font-bold mb-2">Still valid, not run again</h2>
      <ul className="list-disc pl-6 space-y-1 m-0">
        {list.map((c) => <li key={c.check} data-testid="run-still-valid-check" className="break-words">{checkWord(c.check)}, passed {localTime(c.passed_at)}</li>)}
      </ul>
    </section>
  );
}

/** Part 12: "This run will:", grouped, a pill on every step. */
function RunWill({ r, title = 'This run will:', testId = 'run-will' }) {
  return (
    <section data-testid={testId} className="mb-4 text-sm text-dark min-w-0">
      <h2 className="text-lg font-bold mb-2">{title}</h2>
      {groupedSteps(r).map(({ group, steps }) => (
        <div key={group} data-testid="run-group" className="mb-3">
          <h3 className="font-bold mb-1">{group}</h3>
          <ol className="list-decimal pl-6 space-y-1 m-0">
            {steps.map((s, i) => (
              <li key={`${s.code}-${i}`} data-testid="run-step" data-code={s.code} className="break-words">
                <OrgPill org={s.org} /> {s.text}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <p data-testid="run-stops" className="m-0 font-medium">{STOPS_AT_FIRST_FAILURE}</p>
    </section>
  );
}

/** Part 15: details, closed by default. */
function Details({ details, runTag }) {
  const d = details ?? {};
  return (
    <details data-testid="run-details" className={PANEL}>
      <summary className="cursor-pointer font-medium">Details</summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="font-medium">Run tag</dt><dd className="font-mono break-all">{runTag}</dd>
        <dt className="font-medium">Run folder</dt><dd className="font-mono text-xs break-all">{d.run_folder}</dd>
        {(d.hashes ?? []).map((x) => (
          <Fragment key={x.name}>
            <dt className="font-mono text-xs">{x.name}</dt>
            <dd className="min-w-0"><span className="font-mono font-bold">{shortHash(x.sha256)}</span><span className="block font-mono text-xs break-all">{x.sha256}</span></dd>
          </Fragment>
        ))}
      </dl>
      {(d.queries ?? []).map((q) => (
        <div key={q.label} className="mt-2">
          <p className="font-medium m-0 mb-1">{q.label}</p>
          <pre data-testid="run-query" className="m-0 p-3 bg-white rounded border border-border font-mono text-xs whitespace-pre-wrap break-words">{q.soql}</pre>
        </div>
      ))}
      {Array.isArray(d.added_ids) && d.added_ids.length > 0 && (
        <p className="mt-2 break-words">Added Ids: <span className="font-mono">{d.added_ids.join(', ')}</span></p>
      )}
    </details>
  );
}

/** B4: the function's own line when its reply has one (a simulation's carries "SIMULATION "), else the page's. */
const lineOf = (reply, fallback) => (typeof reply?.line === 'string' && reply.line ? reply.line : fallback);

export default function RunPage({ source }) {
  const sim = isSimulation(source);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [desktop, setDesktop] = useState(null);
  const [rechecked, setRechecked] = useState(false);
  const [expiredAtClick, setExpiredAtClick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(null);
  const [cancelled, setCancelled] = useState(null);

  // Read once when the page opens: the request, then the desktop. Never again by itself.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const page = await source.load();
        if (!live) return;
        setLoaded(page);
        // A check that throws counts as no answer, so the page still offers "Check again".
        const d = await source.checkDesktop().catch(() => NO_ANSWER);
        if (live) setDesktop(d);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, [source]);

  const r = loaded?.request;
  const ready = desktop?.answer === 'running';
  // The undo page has no 24-hour expiry, only its own deadline (pageExpired).
  const expired = expiredAtClick || (r ? pageExpired(r) : false);
  // An undo page after its deadline: the reason, and no buttons at all. Read at render (page open or a click).
  const closed = r ? undoClosedReason(r) : null;
  // The stored run, read at page load: approved and never picked up, or approved and still waiting for pickup.
  const stored = loaded?.run ?? null;
  // A rerun asked for after a run that never started supersedes it (Alex, s6b): the page then follows the rerun.
  const superseded = notStarted(stored) && Date.parse(r?.rerun_at ?? '') > Date.parse(stored?.consumed_at ?? '');
  const run = superseded ? null : stored;
  const unpicked = notStarted(run);
  const waiting = Boolean(run?.consumed_at) && !unpicked && !run?.picked_up_at;
  // Picked up or finished: the link is used, so the page only reports.
  const used = Boolean(run?.consumed_at) && Boolean(run?.picked_up_at || run?.finished_at);
  // A rerun asked for and not yet passed: the evidence is still old, but a second rerun is refused (part 5).
  // B4: the real source marks a rerun (a correction's Approve too) approved and not yet finished as rerun_pending.
  const rerunWaiting = (Boolean(r?.rerun_at) && expired && !run?.consumed_at) || r?.rerun_pending === true;
  // The one action this page offers: Approve; once the checks expired, the rerun (its own approval); after a run
  // that never started, the resend.
  const offered = closed || waiting || used || rerunWaiting ? null : expired ? 'rerun' : unpicked ? 'resend' : 'approve';
  // s16: the real source marks a write whose shown count isn't the database's; that page offers no Approve.
  const countRefused = offered === 'approve' && typeof r?.count_mismatch === 'string' ? r.count_mismatch : null;
  const mode = countRefused ? null : offered;
  const quiet = waiting || used || rerunWaiting;
  // One value decides both the action button and the red bar.
  const canApprove = Boolean(r) && Boolean(mode) && ready && !sent && !cancelled;
  // The "Desktop not ready" section with Check again: the desktop answered "not ready" and the page offers an action.
  const notReady = Boolean(r) && Boolean(mode) && Boolean(desktop) && !ready && !sent && !cancelled;

  // Focus after a click: to Check again when the section appears, to Approve when a check succeeds.
  const approveRef = useRef(null);
  const checkAgainRef = useRef(null);
  const [focusTo, setFocusTo] = useState(null);
  useEffect(() => {
    const el = focusTo === 'approve' ? approveRef.current : focusTo === 'check' ? checkAgainRef.current : null;
    if (el && !el.disabled) { el.focus(); setFocusTo(null); }
  }, [focusTo, canApprove, notReady, busy]);

  // One click at a time: the ref blocks a second click before the disabled buttons have re-rendered.
  const inFlight = useRef(false);
  const once = (fn) => async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try { await fn(); } finally { inFlight.current = false; setBusy(false); }
  };
  // One ask of the desktop; a check that throws counts as no answer.
  const ask = () => source.checkDesktop().catch(() => NO_ANSWER);

  const approve = once(async () => {
    try {
      // At the click: the checks against now, then (Q9) the desktop once more. Either failing approves nothing.
      // An undo past its deadline re-renders closed, with no buttons; the click approves nothing.
      if (undoClosedReason(r)) return;
      // Checks that expire while the page is open: the click approves nothing, and the page offers the rerun.
      if (mode !== 'rerun' && pageExpired(r)) {
        setExpiredAtClick(true);
        return;
      }
      const d = await ask();
      setDesktop(d);
      setRechecked(true);
      if (d?.answer !== 'running') { setFocusTo('check'); return; }
      if (mode === 'rerun') setSent(await source.rerun());
      else if (mode === 'resend') setSent(await source.resend());
      else setSent(await source.approve());
    } catch (e) {
      setNote(refusalNote(e, 'Nothing was approved.'));
    }
  });

  // "Check again": one more ask, only on the click.
  const checkAgain = once(async () => {
    setChecking(true);
    try {
      const d = await ask();
      setDesktop(d);
      setRechecked(true);
      setFocusTo(d?.answer === 'running' ? 'approve' : 'check');
    } finally {
      setChecking(false);
    }
  });

  const dontRun = once(async () => {
    try {
      setCancelled(await source.cancel(reason));
    } catch (e) {
      setNote(refusalNote(e, 'Nothing ran; try again.'));
    }
  });

  if (error) return <RunShell source={source}><p data-testid="run-error" className="text-dark break-words">{error}</p></RunShell>;
  if (!r) return <RunShell source={source}><p className="text-muted">Loading…</p></RunShell>;

  // A closed undo changes nothing: its banner says so, and the count sentence, "After you approve" and the desktop go.
  // In rerun mode the action is the pre-check and rehearsal: its banners, not the write's.
  const banners = closed ? { ...bannerLines(r), production: 'Nothing changes: no undo is offered.' } : bannerLines(mode === 'rerun' ? rerunRequest(r) : r);
  const sentence = closed ? null : countSentence(r);
  // A closed undo says "Undo: not offered" in its status line; a second "Undo:" line would only repeat it.
  const undo = closed ? null : undoLine(r);
  const linkId = loaded.link_id;

  return (
    <RunShell source={source} approvable={canApprove}>
      <OrgBanners production={banners.production} sandbox={banners.sandbox} />
      {/* data-settled: the request and the desktop's first answer are both in, so the page is drawn whole. */}
      <p data-testid="run-headline" data-settled={desktop ? 'true' : 'false'} className="font-bold text-dark mb-2 break-words">{r.headline}</p>
      <p className="text-sm text-dark">Project</p>
      <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={r.project_code} data-switchboard-kind={sim ? 'simulation' : 'run'}>{r.project_code}</p>
      <h2 data-testid="run-phase-header" className="text-xl font-bold text-dark mb-1">{PHASE_HEADERS[r.page]}</h2>
      <p data-testid="run-client-org" className="text-dark mb-4 break-words">{clientOrgLine(r)}</p>
      {sentence && <p data-testid="run-count-sentence" className="text-2xl font-bold text-dark mb-3 break-words">{sentence}</p>}
      <ProblemBox r={r} closed={closed} />
      <StatusLine r={r} run={used ? run : null} closed={closed} />
      <ChangedBlock changed={r.changed} />
      <SampleRecord r={r} sample={loaded.sample} />
      {undo && <p data-testid="run-undo" className="mb-4 text-dark font-medium break-words">{undo}</p>}
      {/* A closed undo will run nothing, so "This run will:" is left out (A7). */}
      {!closed && <RunWill r={r} />}
      <StillValid r={r} />

      {!notReady && !closed && !quiet && (
        <p data-testid="run-desktop" data-answer={desktop?.answer ?? 'checking'} className="mb-4 text-sm text-dark break-words min-w-0">
          {/* Expired, sent or not run: no fix to offer, since nothing can be approved here. */}
          {desktopLine(desktop, rechecked, { fix: ready || !desktop })}
        </p>
      )}
      {countRefused && !sent && !cancelled && (
        <p data-testid="run-count-mismatch" role="alert" className="mb-4 text-dark break-words">{countRefused}</p>
      )}
      {expired && !closed && !quiet && !sent && !cancelled && !unpicked && (
        <p data-testid="run-expired" className="mb-4 text-dark break-words">
          The checks have expired: they last 24 hours from the oldest one. The data operation can't be approved until the
          pre-check and rehearsal run again; once they pass, this page offers it.
        </p>
      )}
      {unpicked && !closed && (
        <div data-testid="run-not-started" className={PANEL}>
          <p className="font-bold m-0 mb-1">Not started. Nothing ran.</p>
          <p className="m-0 break-words">
            Approved {localTime(run.consumed_at)}, and the desktop helper didn't pick it up within 15 minutes.{' '}
            {expired
              // Alex (s6b): a run that never started leaves its link unused for the rerun, so this is no dead end.
              ? <span data-testid="run-not-started-rerun">The checks have since expired, so it can't be resent. This link counts as unused because the run never started: run the pre-check and rehearsal again below, and once they pass this page offers the data operation.</span>
              : 'Try again resends the same run, unchanged, with no new link from the chat.'}
          </p>
        </div>
      )}
      {waiting && (
        <div data-testid="run-waiting" className={PANEL}>
          <p className="font-medium m-0 mb-1">Approved {localTime(run.consumed_at)}</p>
          <p className="m-0 break-words">Waiting for the desktop helper to pick it up, within 15 minutes of approval.</p>
        </div>
      )}
      {used && (
        <div data-testid="run-used" className={PANEL}>
          <p className="font-medium m-0 mb-1">{run.finished_at ? `${run.failure_reason ? 'Stopped' : 'Finished'} ${localTime(run.finished_at)}` : `Picked up ${localTime(run.picked_up_at)}, running`}</p>
          <p className="m-0 break-words">Approved {localTime(run.consumed_at)}. This link is used; the results come back to Alfred.</p>
        </div>
      )}
      {rerunWaiting && (
        <div data-testid="run-rerun-waiting" className={PANEL}>
          <p className="font-medium m-0 mb-1">Pre-check and rehearsal asked for again, {localTime(r.rerun_at)}</p>
          <p className="m-0 break-words">Once they pass, this page offers the data operation. A second rerun isn't offered while this one is waiting or running.</p>
        </div>
      )}

      {!closed && !quiet && (
        <section data-testid="run-after" className="mb-4 text-sm text-dark min-w-0">
          <h2 className="text-lg font-bold mb-2">After you approve</h2>
          {/* In rerun mode the action on offer is the pre-check, so these lines describe it. */}
          <ul className="list-disc pl-6 space-y-1 m-0 break-words">{afterApproveLines(mode === 'rerun' ? rerunRequest(r) : r).map((l) => <li key={l}>{l}</li>)}</ul>
        </section>
      )}

      <Details details={r.details} runTag={r.run_tag} />
      {note && <p data-testid="run-note" role="alert" className="mb-4 text-dark break-words">{note}</p>}

      {cancelled ? (
        <div data-testid="run-cancelled" className={PANEL}>
          <p className="font-medium m-0 mb-1">Not run</p>
          <p className="m-0 mb-3 break-words">{cancelled.reason || 'No reason given.'}</p>
          <ResultLine line={lineOf(cancelled, runCancelledLine(linkId, cancelled.reason))} sim={sim} />
        </div>
      ) : closed ? (
        // After the undo deadline: why, and no buttons.
        <div data-testid="run-undo-closed" className={PANEL}>
          <p className="font-medium m-0 mb-1">Undo no longer possible</p>
          <p className="m-0 break-words">{closed}</p>
        </div>
      ) : quiet ? null : sent ? (
        <div data-testid="run-sent" data-mode={mode} className={PANEL}>
          <p className="font-medium m-0 mb-1">
            {sim ? 'Simulated: ' : ''}{sent.rerun ? 'The pre-check and rehearsal were sent to the desktop helper' : sent.as_rerun ? 'The checks to run again were sent to the desktop helper' : sent.resent ? 'Resent to the desktop helper' : 'Sent to the desktop helper'}
          </p>
          <p className="m-0 mb-3 break-words">
            {sim ? 'Nothing was sent: this is a simulation, and no org was touched. ' : 'It must pick the run up within 15 minutes. '}
            {sent.rerun || sent.as_rerun ? 'Once they pass, this same page offers the data operation.' : ''}
          </p>
          {/* as_rerun on an Approve: the database recorded a correction's Approve as its reruns (251), not the write.
              The expired-checks rerun (mode rerun) also replies as_rerun, and keeps the bare line. */}
          <ResultLine line={lineOf(sent, sent.resent ? runResentLine(linkId) : mode === 'approve' && sent.as_rerun && !sent.rerun ? runRerunsLine(linkId) : runLine(linkId))} sim={sim} />
        </div>
      ) : (
        <>
          {notReady && (
            // Not ready, for any reason: this section stands in place of Approve, above Don't run.
            <section data-testid="run-desktop-not-ready" aria-labelledby="run-desktop-not-ready-heading" className={NOT_READY_BOX}>
              <h2 id="run-desktop-not-ready-heading" className="text-lg font-bold mb-1">Desktop not ready</h2>
              <p data-testid="run-desktop" role="status" data-answer={checking ? 'checking' : desktop.answer} className="m-0 mb-3 break-words">
                {checking ? 'Checking the desktop…' : notReadyReason(desktop, rechecked)}
              </p>
              <button ref={checkAgainRef} data-testid="run-check-again" className={BUTTON} disabled={busy} onClick={checkAgain}>Check again</button>
            </section>
          )}
          <ReasonInput value={reason} onChange={setReason} disabled={busy} />
          <div className="flex flex-col sm:flex-row gap-3">
            {canApprove && (
              <button ref={approveRef} data-testid={`run-${mode}`} data-action className={BUTTON} disabled={busy} onClick={approve}>
                {mode === 'rerun' ? RERUN_LABEL : mode === 'resend' ? 'Try again: resend this run' : approveLabel(r)}
              </button>
            )}
            <button data-testid="run-dont" className={SECOND_BUTTON} disabled={busy} onClick={dontRun}>Don't run</button>
          </div>
          {/* The rerun is itself the approval: its steps in full, beneath it. */}
          {mode === 'rerun' && <div className="mt-4"><RunWill r={rerunRequest(r)} title={`"${RERUN_LABEL}" will:`} testId="run-rerun-will" /></div>}
        </>
      )}
    </RunShell>
  );
}
