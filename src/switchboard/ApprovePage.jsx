import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase, supabaseUrl, supabaseAnonKey } from '../supabaseClient';
import CopyButton from '../shared/CopyButton';

// Where a Switchboard approval link lands (spec §8.1). The runner decides everything;
// this page shows the SQL, runs the dry run by itself, then offers Approve and Don't run. Only a finished
// action (a real run, a test, or Don't run) puts its id on the page, as data-switchboard-run-id; the extension
// reads that and data-switchboard-project, posts the result to the chat and closes this tab. Where it can't,
// the line is here to copy.

// As on OAuthConsent (primary) and ItemAddToCollection (secondary).
const BUTTON = 'w-full sm:w-auto px-4 py-3 min-h-[44px] bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50';
const SECOND_BUTTON = 'w-full sm:w-auto px-4 py-3 min-h-[44px] rounded-lg border border-border text-primary hover:border-primary transition-colors disabled:opacity-50';

/** The plain sentence for a refusal that ends this link, or null if the page can carry on. */
export function linkEnded(status, error) {
  const e = String(error ?? '');
  if (status === 401) return "This account isn't allowed to approve this, or the sign-in has expired. Nothing ran.";
  if (/no such link/i.test(e)) return "This link doesn't exist. Nothing ran. Ask Claude for a new one.";
  if (/already been used/i.test(e)) return 'This link has already been used. It works once. Ask Claude for the result.';
  if (/has expired/i.test(e)) return 'This link has expired. Links last 30 minutes. Nothing ran. Ask Claude for a new one.';
  if (/does not match/i.test(e)) return 'The SQL does not match what this link approved. Nothing ran. Ask Claude to review it again.';
  return null;
}

async function callRunner(route, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${supabaseUrl}/functions/v1/switchboard-runner/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function Shell({ children }) {
  return (
    <div className="flex justify-center min-h-screen bg-primary-bg p-4">
      <div className="w-full max-w-3xl self-start p-4 sm:p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold text-dark mb-2 text-center">Alfred</h1>
        <p className="text-sm text-dark text-center mb-6">Approve</p>
        {children}
      </div>
    </div>
  );
}

/** One line per counted statement: its rows, and what was expected when that's a number. */
function countLine({ statement, action, count, expected }) {
  const rows = `${count} ${count === 1 ? 'row' : 'rows'}`;
  return `Statement ${statement}: ${action}: ${rows}${typeof expected === 'number' ? `, expected ${expected}` : ''}`;
}

function RunResult({ title, summary, conformance, runId, counts, marks }) {
  return (
    <div className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm" {...(runId ? { 'data-switchboard-run-id': runId } : {})} {...marks}>
      <p className="font-medium text-dark mb-1">{title}</p>
      <p className="text-dark break-words">{summary}</p>
      {counts?.length > 0 && (
        <ul className="text-dark mt-2 break-words">
          {counts.map((c) => <li key={c.statement} className={c.differs ? 'font-bold' : undefined}>{countLine(c)}</li>)}
        </ul>
      )}
      {conformance && <p className="text-dark mt-2 break-words">{conformance}</p>}
      {runId && <p className="text-dark mt-2 font-mono break-all">Run {runId}</p>}
    </div>
  );
}

/** Beside any error or mismatch: the ids and what went wrong, for pasting to Claude. */
function CopyDetails({ actionId, dryRunId, error, counts }) {
  const text = () => [
    actionId && `Action: ${actionId}`,
    dryRunId && `Dry run: ${dryRunId}`,
    error && `Problem: ${error}`,
    ...(counts ?? []).map(countLine),
  ].filter(Boolean).join('\n');
  return (
    <div className="mb-4">
      <CopyButton size="large" label="Copy details" getText={text} className={`${SECOND_BUTTON} inline-flex items-center justify-center gap-2`} />
    </div>
  );
}

/**
 * The line for the chat, for wherever the extension can't post it. Where it can, this tab closes first.
 * The extension fills the hidden status and shows Try again; it adds no markup or styling of its own.
 */
function ResultLine({ line }) {
  return (
    <div>
      <p className="text-dark mb-2">Paste this into the Claude chat, then close this tab.</p>
      <div className="flex items-center gap-2">
        <code className="font-mono text-dark break-all">{line}</code>
        <CopyButton getText={() => line} title="Copy this line for the chat" />
      </div>
      <div data-switchboard-status="" hidden className="mt-4">
        <p data-switchboard-status-text="" className="text-dark mb-3 break-words" />
        <button type="button" data-switchboard-retry="" className={SECOND_BUTTON}>Try again</button>
      </div>
    </div>
  );
}

export default function ApprovePage() {
  const { token } = useParams();
  const [signedIn, setSignedIn] = useState(null);
  const [preview, setPreview] = useState(null);
  const [ended, setEnded] = useState(null);
  const [note, setNote] = useState(null);
  const [dry, setDry] = useState(null);
  const [real, setReal] = useState(null);
  const [cancelled, setCancelled] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const dryStarted = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!live) return;
      setSignedIn(Boolean(session));
      if (!session) return;
      try {
        const { status, body } = await callRunner('preview', { token });
        if (!live) return;
        if (body.ok) setPreview(body);
        else setEnded(linkEnded(status, body.error) ?? String(body.error));
      } catch {
        if (live) setEnded("Couldn't reach the runner. Nothing ran. Reload to try again.");
      }
    })();
    return () => { live = false; };
  }, [token]);

  function refusal({ status, body }) {
    const over = linkEnded(status, body.error);
    if (over) setEnded(over);
    else setNote([body.error, ...(body.reasons ?? [])].filter(Boolean).join(' '));
  }

  async function runDry() {
    setBusy(true);
    setNote(null);
    setDry(null);
    try {
      const out = await callRunner('dry-run', { token });
      if (out.body.run_id) setDry(out.body);
      else refusal(out);
    } catch {
      setNote("Couldn't reach the runner. A dry run changes nothing, so it's safe to try again.");
    }
    setBusy(false);
  }

  useEffect(() => {
    if (!preview || dryStarted.current) return;
    dryStarted.current = true;
    runDry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  async function runReal() {
    setBusy(true);
    setNote(null);
    try {
      const out = await callRunner('approve', { token, fingerprint: preview.fingerprint });
      if (out.body.run_id) setReal(out.body);
      else refusal(out);
    } catch {
      setEnded('The connection was lost after Approve, so this may have run. Ask Claude to check before doing anything else.');
    }
    setBusy(false);
  }

  async function dontRun() {
    setBusy(true);
    setNote(null);
    try {
      const out = await callRunner('cancel', { token, reason });
      if (out.body.cancelled) setCancelled(out.body);
      else refusal(out);
    } catch {
      setNote("Couldn't reach the runner, and it may not have heard this. Nothing ran. Try again.");
    }
    setBusy(false);
  }

  const details = { actionId: preview?.action_id, dryRunId: dry?.run_id };

  if (signedIn === null) return <Shell><p className="text-muted">Loading…</p></Shell>;

  if (!signedIn) {
    return (
      <Shell>
        <p className="text-dark mb-4">Sign in to Alfred to see what this link would run. Nothing has run.</p>
        <button
          className={BUTTON}
          onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } })}
        >
          Sign in with Google
        </button>
      </Shell>
    );
  }

  if (ended) {
    return (
      <Shell>
        <p className="text-dark mb-4">{ended}</p>
        <CopyDetails {...details} error={ended} />
      </Shell>
    );
  }
  if (!preview) return <Shell><p className="text-muted">Loading…</p></Shell>;

  const mismatch = Boolean(dry?.mismatch);
  const dryTitle = dry?.test
    ? (dry.ok ? 'Test run, undone' : 'The test failed, undone')
    : mismatch ? 'Counts differ from what was expected, rolled back'
    : dry?.ok ? 'Dry run, rolled back' : 'The dry run failed, rolled back';
  const dryProblem = mismatch ? 'counts differ from what was expected' : dry?.summary;

  return (
    <Shell>
      <p className="font-bold text-dark mb-2 break-words">{preview.headline}</p>
      <p className="text-sm text-dark">Project</p>
      <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={preview.project_code}>{preview.project_code}</p>
      {preview.description && <p data-testid="approve-description" className="text-dark mb-4 break-words">{preview.description}</p>}
      <pre data-testid="approve-sql" className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark whitespace-pre-wrap break-words">
        {preview.sql}
      </pre>

      {note && (
        <>
          <p className="mb-4 text-sm text-dark break-words">{note}</p>
          <CopyDetails {...details} error={note} />
        </>
      )}

      {cancelled ? (
        <>
          <RunResult
            title="Not run"
            summary={cancelled.reason || 'No reason given.'}
            runId={cancelled.run_id}
            marks={{ 'data-switchboard-cancelled': '', 'data-switchboard-reason': cancelled.reason }}
          />
          <ResultLine line={`sql ${cancelled.run_id} cancelled${cancelled.reason ? `: ${cancelled.reason}` : ''}`} />
        </>
      ) : real ? (
        <>
          <RunResult
            title={real.ok ? 'Ran for real' : 'The real run failed'}
            summary={real.summary}
            conformance={real.conformance}
            runId={real.run_id}
            counts={real.counts}
          />
          {(!real.ok || real.mismatch) && (
            <CopyDetails {...details} error={real.mismatch ? 'the real run committed, and its counts differ from what was expected' : real.summary} counts={real.counts} />
          )}
          <ResultLine line={`sql ${real.run_id}`} />
        </>
      ) : dry?.test ? (
        <>
          <RunResult title={dryTitle} summary={dry.summary} runId={dry.run_id} counts={dry.counts} />
          {!dry.ok && <CopyDetails {...details} error={dry.summary} counts={dry.counts} />}
          <ResultLine line={`sql ${dry.run_id}`} />
        </>
      ) : (
        <>
          {dry && <RunResult title={dryTitle} summary={dry.summary} counts={dry.counts} />}
          {dry && !dry.ok && <CopyDetails {...details} error={dryProblem} counts={dry.counts} />}
          {busy && !dry && <p className="mb-4 text-dark">{preview.test ? 'Running the test…' : 'Running the dry run…'}</p>}
          {dry && (
            <div className="mb-4">
              <label htmlFor="dont-run-reason" className="block text-sm text-dark mb-1">Reason for not running (optional)</label>
              <input
                id="dont-run-reason"
                type="text"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 min-h-[44px] rounded-lg border border-border text-dark"
              />
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-3">
            {busy && !dry ? null : dry?.ok || mismatch ? (
              <>
                <button className={BUTTON} disabled={busy || mismatch} onClick={runReal}>Approve and run for real</button>
                <button className={SECOND_BUTTON} disabled={busy} onClick={runDry}>Run the dry run again</button>
              </>
            ) : (
              <button className={BUTTON} disabled={busy} onClick={runDry}>{preview.test ? 'Run the test' : 'Dry run'}</button>
            )}
            {dry && <button className={SECOND_BUTTON} disabled={busy} onClick={dontRun}>Don't run</button>}
          </div>
        </>
      )}
    </Shell>
  );
}
