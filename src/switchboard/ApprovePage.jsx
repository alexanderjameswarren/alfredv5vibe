import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase, supabaseUrl, supabaseAnonKey } from '../supabaseClient';

// Where a Switchboard approval link lands (spec §8.1). The runner decides everything;
// this page shows the SQL, runs the dry run by itself, then offers Approve. Only a real run puts
// its id on the page, as data-switchboard-run-id; the extension reads that and data-switchboard-project,
// posts the result to the chat and closes this tab. Where it can't, the line is here to copy.

const BUTTON = 'w-full sm:w-auto px-4 py-3 rounded-lg bg-primary text-white font-medium disabled:opacity-50';
const SECOND_BUTTON = 'w-full sm:w-auto px-4 py-3 rounded-lg border border-primary text-dark font-medium disabled:opacity-50';

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
        <h1 className="text-2xl font-bold text-dark mb-4">Alfred</h1>
        {children}
      </div>
    </div>
  );
}

function RunResult({ title, summary, conformance, runId }) {
  return (
    <div className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm" {...(runId ? { 'data-switchboard-run-id': runId } : {})}>
      <p className="font-medium text-dark mb-1">{title}</p>
      <p className="text-dark break-words">{summary}</p>
      {conformance && <p className="text-dark mt-2 break-words">{conformance}</p>}
      {runId && <p className="text-dark mt-2 font-mono break-all">Run {runId}</p>}
    </div>
  );
}

/** The line for the chat, for wherever the extension can't post it. Where it can, this tab closes first. */
function ResultLine({ runId }) {
  const [copied, setCopied] = useState(false);
  const line = `sql ${runId}`;
  return (
    <div className="mb-16">
      <p className="text-dark mb-2">Paste this into the Claude chat, then close this tab.</p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <code className="font-mono text-dark break-all">{line}</code>
        <button
          className={SECOND_BUTTON}
          onClick={() => navigator.clipboard.writeText(line).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
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

  if (ended) return <Shell><p className="text-dark">{ended}</p></Shell>;
  if (!preview) return <Shell><p className="text-muted">Loading…</p></Shell>;

  return (
    <Shell>
      <p className="font-bold text-dark mb-2 break-words">{preview.headline}</p>
      <p className="text-sm text-dark">Project</p>
      <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={preview.project_code}>{preview.project_code}</p>
      {preview.description && <p data-testid="approve-description" className="text-dark mb-4 break-words">{preview.description}</p>}
      <pre data-testid="approve-sql" className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark whitespace-pre-wrap break-words">
        {preview.sql}
      </pre>

      {note && <p className="mb-4 text-sm text-dark break-words">{note}</p>}

      {real ? (
        <>
          <RunResult
            title={real.ok ? 'Ran for real' : 'The real run failed'}
            summary={real.summary}
            conformance={real.conformance}
            runId={real.run_id}
          />
          <ResultLine runId={real.run_id} />
        </>
      ) : (
        <>
          {dry && <RunResult title={dry.ok ? 'Dry run, rolled back' : 'The dry run failed, rolled back'} summary={dry.summary} />}
          {busy && !dry && <p className="mb-4 text-dark">Running the dry run…</p>}
          <div className="flex flex-col sm:flex-row gap-3">
            {busy && !dry ? null : dry?.ok ? (
              <>
                <button className={BUTTON} disabled={busy} onClick={runReal}>Approve and run for real</button>
                <button className={SECOND_BUTTON} disabled={busy} onClick={runDry}>Run the dry run again</button>
              </>
            ) : (
              <button className={BUTTON} disabled={busy} onClick={runDry}>Dry run</button>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}
