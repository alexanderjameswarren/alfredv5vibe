import { Fragment, useEffect, useState } from 'react';
import {
  BUTTON, OrgBanners, OrgPill, PANEL, ReasonInput, ResultLine, RunShell, SECOND_BUTTON, isSimulation, localTime, shortHash,
} from './look';
import {
  PHASE_HEADERS, STOPS_AT_FIRST_FAILURE, afterApproveLines, approveLabel, bannerLines, checksExpired, clientOrgLine,
  countSentence, groupedSteps, phaseWord, rehearsalOrg, runCancelledLine, runLine, targetOrg, undoLine, validUntil, whatChanges,
} from './runContract';

// sb3_pages-h6v A2: the Switchboard 3 run page (docs/technical-spec-sb3_pages-h6v.md part 3), parts 1-16 in the agreed
// order, for the pre-check and rehearsal page and the data operation page. It reads through a source: the simulated
// one (simulation.js) until B4 adds the real one. Status is read when the page opens and when Alex clicks; nothing
// runs on a timer. A3 adds the desktop states; A5 the expired, not started and check states.

/** The desktop line for one answer. A3 adds "Check again" and the full states; until then, the words only. */
export function desktopLine(d, rechecked) {
  if (!d) return 'Checking the desktop…';
  const when = rechecked ? '(checked just now)' : '(checked when this page opened)';
  switch (d.answer) {
    case 'running': return `Desktop ready: Switchboard panel and helper running ${when}`;
    case 'no_extension': return `No Alfred extension in this browser ${when}. Approve from Chrome on your desktop.`;
    case 'no_answer': return `The Alfred extension didn't answer ${when}. Reload it on your desktop.`;
    default: {
      const down = [d.panel ? null : 'the Switchboard panel', d.helper ? null : 'the helper'].filter(Boolean).join(' and ');
      return `Desktop not ready: ${down || 'Switchboard'} not running ${when}. Start Switchboard on your desktop.`;
    }
  }
}

/** Part 7: the problem box. */
function ProblemBox({ r }) {
  const t = targetOrg(r);
  const sel = r.selected_by ?? {};
  const c = r.counts ?? {};
  return (
    <dl data-testid="run-problem" className={`${PANEL} grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2`}>
      <dt className="font-medium">Problem</dt>
      <dd className="min-w-0 break-words"><span data-testid="run-problem-label" className="font-bold mr-2">{r.problem?.label}</span>{r.problem?.sentence}</dd>
      <dt className="font-medium">What changes</dt><dd data-testid="run-what-changes" className="min-w-0 break-words">{whatChanges(r)}</dd>
      <dt className="font-medium">Selected by</dt>
      <dd data-testid="run-selected-by" className="min-w-0 break-words">
        {sel.sandbox_text ? <>Production: {sel.text}<span className="block">Sandbox: {sel.sandbox_text}</span></> : sel.text}
        {sel.not_rehearsed && <span data-testid="run-not-rehearsed" className="block font-bold">Not rehearsed: {sel.not_rehearsed}</span>}
      </dd>
      <dt className="font-medium">Org</dt>
      <dd data-testid="run-org" className="min-w-0 font-mono break-all">
        {t?.alias}{rehearsalOrg(r) && <span className="block">{rehearsalOrg(r).alias} (sandbox rehearsal)</span>}
      </dd>
      <dt className="font-medium">Count</dt>
      <dd data-testid="run-count" className="min-w-0">{typeof (c.total ?? c.expected) === 'number' ? (c.total ?? c.expected).toLocaleString('en-US') : '?'}</dd>
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
function StatusLine({ r }) {
  const until = validUntil(r.evidence);
  return (
    <div data-testid="run-status" className="mb-4 text-sm text-dark break-words">
      {(r.phases ?? []).map((p) => (
        <p key={p.name} data-testid="run-phase" data-state={p.state} className="m-0">
          {p.name}: <span className="font-medium">{phaseWord(p.state)}</span>{p.at ? `, ${localTime(p.at)}` : ''}
        </p>
      ))}
      <p data-testid="run-valid-until" className="m-0">
        {until ? `Checks valid until ${localTime(until)}.` : 'No checks have passed yet, so nothing expires.'}
      </p>
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
  if (r.page === 'precheck' || !sample?.records?.length) return null;
  return (
    <section data-testid="run-sample" className={PANEL}>
      <h2 className="text-lg font-bold mb-2">Sample record</h2>
      {sample.records.map((rec) => (
        <div key={rec.id_label} className="mb-2 overflow-x-auto">
          <p className="font-medium m-0 mb-1">{rec.id_label}</p>
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

/** Part 12: "This run will:", grouped, a pill on every step. */
function RunWill({ r }) {
  return (
    <section data-testid="run-will" className="mb-4 text-sm text-dark min-w-0">
      <h2 className="text-lg font-bold mb-2">This run will:</h2>
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

export default function RunPage({ source }) {
  const sim = isSimulation(source);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [desktop, setDesktop] = useState(null);
  const [rechecked, setRechecked] = useState(false);
  const [expiredAtClick, setExpiredAtClick] = useState(false);
  const [busy, setBusy] = useState(false);
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
        const d = await source.checkDesktop();
        if (live) setDesktop(d);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, [source]);

  const r = loaded?.request;
  const ready = desktop?.answer === 'running';
  const expired = expiredAtClick || (r ? checksExpired(r.evidence) : false);
  // One value decides both the Approve button and the red bar.
  const canApprove = Boolean(r) && ready && !expired && !sent && !cancelled;

  async function approve() {
    setBusy(true);
    setNote(null);
    try {
      // At the click: the checks against now, then (Q9) the desktop once more. Either failing approves nothing.
      if (checksExpired(r.evidence)) {
        setExpiredAtClick(true);
      } else {
        const d = await source.checkDesktop();
        setDesktop(d);
        setRechecked(true);
        if (d?.answer === 'running') setSent(await source.approve());
      }
    } catch (e) {
      setNote(`${e instanceof Error ? e.message : String(e)} Nothing was approved.`);
    }
    setBusy(false);
  }

  async function dontRun() {
    setBusy(true);
    setNote(null);
    try {
      setCancelled(await source.cancel(reason));
    } catch (e) {
      setNote(`${e instanceof Error ? e.message : String(e)} Nothing ran; try again.`);
    }
    setBusy(false);
  }

  if (error) return <RunShell source={source}><p data-testid="run-error" className="text-dark break-words">{error}</p></RunShell>;
  if (!r) return <RunShell source={source}><p className="text-muted">Loading…</p></RunShell>;

  const banners = bannerLines(r);
  const sentence = countSentence(r);
  const undo = undoLine(r);
  const linkId = loaded.link_id;

  return (
    <RunShell source={source} approvable={canApprove}>
      <OrgBanners production={banners.production} sandbox={banners.sandbox} />
      <p data-testid="run-headline" className="font-bold text-dark mb-2 break-words">{r.headline}</p>
      <p className="text-sm text-dark">Project</p>
      <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={r.project_code} data-switchboard-kind={sim ? 'simulation' : 'run'}>{r.project_code}</p>
      <h2 data-testid="run-phase-header" className="text-xl font-bold text-dark mb-1">{PHASE_HEADERS[r.page]}</h2>
      <p data-testid="run-client-org" className="text-dark mb-4 break-words">{clientOrgLine(r)}</p>
      {sentence && <p data-testid="run-count-sentence" className="text-2xl font-bold text-dark mb-3 break-words">{sentence}</p>}
      <ProblemBox r={r} />
      <StatusLine r={r} />
      <ChangedBlock changed={r.changed} />
      <SampleRecord r={r} sample={loaded.sample} />
      {undo && <p data-testid="run-undo" className="mb-4 text-dark font-medium break-words">{undo}</p>}
      <RunWill r={r} />

      <p data-testid="run-desktop" className="mb-4 text-sm text-dark break-words">
        {desktopLine(desktop, rechecked)}
      </p>
      {expired && (
        <p data-testid="run-expired" className="mb-4 text-dark break-words">
          The checks have expired: they last 24 hours from the oldest one. Nothing can be approved on this page.
        </p>
      )}

      <section data-testid="run-after" className="mb-4 text-sm text-dark min-w-0">
        <h2 className="text-lg font-bold mb-2">After you approve</h2>
        <ul className="list-disc pl-6 space-y-1 m-0 break-words">{afterApproveLines(r).map((l) => <li key={l}>{l}</li>)}</ul>
      </section>

      <Details details={r.details} runTag={r.run_tag} />
      {note && <p data-testid="run-note" role="alert" className="mb-4 text-dark break-words">{note}</p>}

      {cancelled ? (
        <div data-testid="run-cancelled" className={PANEL}>
          <p className="font-medium m-0 mb-1">Not run</p>
          <p className="m-0 mb-3 break-words">{cancelled.reason || 'No reason given.'}</p>
          <ResultLine line={runCancelledLine(linkId, cancelled.reason)} sim={sim} />
        </div>
      ) : sent ? (
        <div data-testid="run-sent" className={PANEL}>
          <p className="font-medium m-0 mb-1">{sim ? 'Simulated: sent to the desktop helper' : 'Sent to the desktop helper'}</p>
          <p className="m-0 mb-3 break-words">{sim ? 'Nothing was sent: this is a simulation, and no org was touched.' : 'It must pick the run up within 15 minutes.'}</p>
          <ResultLine line={runLine(linkId)} sim={sim} />
        </div>
      ) : (
        <>
          <ReasonInput value={reason} onChange={setReason} disabled={busy} />
          <div className="flex flex-col sm:flex-row gap-3">
            {canApprove && <button data-testid="run-approve" className={BUTTON} disabled={busy} onClick={approve}>{approveLabel(r)}</button>}
            <button data-testid="run-dont" className={SECOND_BUTTON} disabled={busy} onClick={dontRun}>Don't run</button>
          </div>
        </>
      )}
    </RunShell>
  );
}
