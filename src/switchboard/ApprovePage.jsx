import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { supabase, supabaseUrl, supabaseAnonKey } from '../supabaseClient';
import CopyButton from '../shared/CopyButton';

// Where a Switchboard approval link lands (spec §8.1). The runner decides everything;
// this page shows the SQL, runs the dry run by itself, then offers Approve and Don't run. Only a finished
// action (a real run, a test, or Don't run) puts its id on the page, as data-switchboard-run-id; the extension
// reads that and data-switchboard-project, posts the result to the chat and closes this tab. Where it can't,
// the line is here to copy. data-switchboard-running, with the link's kind, is there only while a run is under
// way (approved, or a test, which runs on open), so the panel can say so.
// A git action (preview.kind 'git', spec §11.3) has no dry run: the page says what will run, Approve hands it to the
// desktop helper, and the action id is the run mark, since the helper opens its run only when it picks the action up.
// An sb setup (kind 'sb_setup', §11.5) is shown the same way, with its answers and the files the click writes,
// and so is a sandbox check (kind 'sf_check', §11.4, s86pa), whose lines are "sf <id>".

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

/** What a git action will do, in plain words, one line each (spec §11.3). */
export function gitLines(payload, projectCode) {
  const p = payload ?? {};
  const lines = [];
  if (p.command === 'gitpush') {
    lines.push(`Runs gitpush ${p.mode ?? '(no mode)'} for ${projectCode}.`);
    if (p.mode === 'checkpoint') {
      lines.push(p.all ? 'Commits every uncommitted path, merges it into main and pushes.'
        : `Commits these paths, merges them into main and pushes: ${(p.paths ?? []).join(', ')}.`);
      lines.push(p.db === 'keep' ? 'Keeps the database claims.' : 'Releases the database claims.');
    } else if (p.mode === 'finish') {
      lines.push(p.finish === 'project-done'
        ? 'Finishes the whole project: merges into main, pushes, removes the worktree and moves the spec and progress to docs/history/.'
        : 'Finishes this phase only: merges into main, pushes and removes the worktree. The docs stay in docs/.');
    } else if (p.mode === 'push') {
      lines.push('Commits main and pushes it.');
    }
  } else if (p.command === 'gitcom') {
    lines.push(`Runs gitcom for ${projectCode}: commits its claimed files.`);
    if (p.include_unclaimed === 'all') lines.push('Also commits every unclaimed change.');
  } else if (p.command === 'gitsync') {
    lines.push(`Runs gitsync for ${projectCode}: merges main into its worktree.`);
  } else if (p.command === 'gitnewtree') {
    lines.push(`Runs gitnewtree for ${projectCode}: creates its worktree from origin/main.`);
    lines.push(p.repo ? `In the repo ${p.repo}.` : 'In the repo its project code already names.');
    lines.push(p.install === false ? 'Skips npm install.' : 'Runs npm install.');
  } else {
    lines.push(`Runs ${p.command ?? 'an unknown command'} for ${projectCode}.`);
  }
  if (p.message) lines.push(`Commit message: ${p.message}`);
  if (p.command === 'gitpush' && p.include_unclaimed === 'all') lines.push('Also commits every unclaimed change.');
  return lines;
}

const onOff = (b) => (b ? 'yes' : 'no');

/** An sb setup's answers in plain words, one line each (spec §11.5). */
export function sbLines(payload) {
  const p = payload ?? {};
  const lines = [`Runs sb ${p.command ?? '(no command)'} for client ${p.client ?? '(none)'}.`];
  if (p.repo) lines.push(`Clones ${p.repo} into the client's folder.`);
  if (p.adopt) lines.push(`Adopts the existing checkout ${p.adopt} as it is.`);
  if (p.from_sandbox) lines.push(`Retrieves the code from sandbox ${p.from_sandbox} into ${p.folder ?? '(no folder)'}, which must be empty.`);
  if (p.project) lines.push(`Project: ${p.project}`);
  if (p.name) lines.push(`Panel name: ${p.name}`);
  if (p.sandboxes !== undefined) lines.push(`Sandboxes that may run: ${p.sandboxes === 'all' ? 'all' : (p.sandboxes ?? []).join(', ')}`);
  if (p.integration_ok !== undefined) lines.push(`Client allows an integration user: ${onOff(p.integration_ok)}`);
  for (const o of p.orgs ?? []) {
    const parts = [`type ${o.type}`, `level ${o.level}`, o.login && `login ${o.login}`,
      o.cli_deploy !== undefined && `CLI may deploy: ${onOff(o.cli_deploy)}`, o.shared !== undefined && `shared: ${onOff(o.shared)}`];
    lines.push(`Org ${o.alias}: ${parts.filter(Boolean).join(', ')}.`);
  }
  lines.push('Client data may reach Claude: no. That flag is set only in the terminal.');
  return lines;
}

/** A sandbox check in plain words, one line each (spec §11.4, by link since s86pa). */
export function sfLines(payload) {
  const p = payload ?? {};
  return [
    `Runs sf ${p.check ?? '(no check)'}${p.metadata_type ? ` ${p.metadata_type}` : ''} on sandbox ${p.alias ?? '(no alias)'}, read only.`,
    'The helper first proves it is a sandbox listed in orgs.json; production is refused.',
    'Nothing is written.',
  ];
}

/** The config files the click writes. */
export function sbFiles(payload) {
  if (payload?.command === 'org add') return ['orgs.json'];
  return ['repos.json', 'orgs.json', ...(payload?.project ? ['projects.json'] : []), "the repo's .git/info/exclude"];
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

/**
 * s86ac (Alex, 2026-11-10): red or nothing, never green. A loaded preview gets the red header unless its stakes is
 * exactly none, so an older link or runner with no stakes is still marked. Stakes comes from the preview, never the url.
 */
export function needsApprovalHeader(preview) {
  return !!preview && preview.stakes !== 'none';
}

function Shell({ children, preview }) {
  return (
    <div className="min-h-screen bg-primary-bg">
      {needsApprovalHeader(preview) && (
        <div data-testid="approve-stakes-change" role="alert"
          className="w-full bg-red-700 text-white text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-6 px-4">
          Approval required
        </div>
      )}
      <div className="flex justify-center p-4">
      <div className="w-full max-w-3xl self-start p-4 sm:p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold text-dark mb-2 text-center">Alfred</h1>
        <p className="text-sm text-dark text-center mb-6">Approve</p>
        {children}
      </div>
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
  const linkKind = new URLSearchParams(useLocation().search).get('kind');
  const kind = ['sql', 'git', 'deploy'].includes(linkKind) ? linkKind : 'sql';
  const [approving, setApproving] = useState(false);
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

  // Git has no dry run: the page shows what will run and offers Approve straight away. The runner's kind decides;
  // the address's kind is for display only.
  const isSb = preview?.kind === 'sb_setup';
  const isSf = preview?.kind === 'sf_check';
  const isGit = preview?.kind === 'git' || isSb || isSf;

  useEffect(() => {
    if (!preview || dryStarted.current || isGit) return;
    dryStarted.current = true;
    runDry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  async function runReal() {
    setBusy(true);
    setApproving(true);
    setNote(null);
    try {
      const out = await callRunner('approve', { token, fingerprint: preview.fingerprint });
      if (out.body.run_id || (isGit && out.body.sent)) setReal(out.body);
      else refusal(out);
    } catch {
      setEnded('The connection was lost after Approve, so this may have run. Ask Claude to check before doing anything else.');
    }
    setApproving(false);
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

  if (isGit) {
    // The action id is the chat's handle: the helper's run row only exists once it picks the action up.
    const id = preview.action_id;
    const word = isSb ? 'sb' : isSf ? 'sf' : 'git';
    return (
      <Shell preview={preview}>
        {approving && <span hidden data-switchboard-running={preview.kind} />}
        <p className="font-bold text-dark mb-2 break-words">{preview.headline}</p>
        <p className="text-sm text-dark">Project</p>
        <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={preview.project_code} data-switchboard-kind={preview.kind}>{preview.project_code}</p>
        <ul data-testid={`approve-${word}`} className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark break-words list-disc pl-8">
          {(isSb ? sbLines(preview.payload) : isSf ? sfLines(preview.payload) : gitLines(preview.payload, preview.project_code)).map((l) => <li key={l}>{l}</li>)}
        </ul>
        {isSb && !real && !cancelled && (
          <div data-testid="approve-sb-writes" className="mb-4 text-sm text-dark break-words">
            {preview.payload?.from_sandbox && (
              <p data-testid="approve-sb-folder" className="mb-1">
                Writes the code into <span className="font-mono break-all">{preview.payload.folder ?? '(no folder)'}</span>. The folder must be empty.
              </p>
            )}
            <p className="mb-1">Approving writes: {sbFiles(preview.payload).join(', ')}.</p>
            <p>A Salesforce login may open in the browser on your desktop; log in there. Approving is your yes to each write.</p>
          </div>
        )}

        {note && (
          <>
            <p className="mb-4 text-sm text-dark break-words">{note}</p>
            <CopyDetails actionId={id} error={note} />
          </>
        )}

        {cancelled ? (
          <>
            <RunResult title="Not run" summary={cancelled.reason || 'No reason given.'} runId={id}
              marks={{ 'data-switchboard-cancelled': '', 'data-switchboard-reason': cancelled.reason }} />
            <ResultLine line={`${word} ${id} cancelled${cancelled.reason ? `: ${cancelled.reason}` : ''}`} />
          </>
        ) : real ? (
          <>
            <RunResult title="Sent to the desktop helper"
              summary="It runs in a terminal window on your computer. The result comes back to the chat when it finishes."
              runId={id} />
            <ResultLine line={`${word} ${id}`} />
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-dark">{isSb ? 'An sb setup' : isSf ? 'An sf check' : 'Git'} has no dry run. Approve runs this once, on your computer.</p>
            <div className="mb-4">
              <label htmlFor="dont-run-reason" className="block text-sm text-dark mb-1">Reason for not running (optional)</label>
              <input id="dont-run-reason" type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 min-h-[44px] rounded-lg border border-border text-dark" />
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <button className={BUTTON} disabled={busy} onClick={runReal}>Approve and run</button>
              <button className={SECOND_BUTTON} disabled={busy} onClick={dontRun}>Don't run</button>
            </div>
          </>
        )}
      </Shell>
    );
  }

  const mismatch = Boolean(dry?.mismatch);
  const dryTitle = dry?.test
    ? (dry.ok ? 'Test run, undone' : 'The test failed, undone')
    : mismatch ? 'Counts differ from what was expected, rolled back'
    : dry?.ok ? 'Dry run, rolled back' : 'The dry run failed, rolled back';
  const dryProblem = mismatch ? 'counts differ from what was expected' : dry?.summary;
  const running = approving || (preview.test && busy && !dry);

  return (
    <Shell preview={preview}>
      {running && <span hidden data-switchboard-running={kind} />}
      <p className="font-bold text-dark mb-2 break-words">{preview.headline}</p>
      <p className="text-sm text-dark">Project</p>
      <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={preview.project_code} data-switchboard-kind={kind}>{preview.project_code}</p>
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
