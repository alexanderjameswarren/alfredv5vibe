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
    // A finish by link closes the worktree's VS Code window first (spec §10a; built by switchboard repo s13).
    lines.push(p.mode === 'finish'
      ? `Closes the ${projectCode} VS Code window, then finishes: runs gitpush finish for ${projectCode}.`
      : `Runs gitpush ${p.mode ?? '(no mode)'} for ${projectCode}.`);
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

/** s89e: production with level data, which the page and the result both mark PRODUCTION FULL DATA (spec §10). */
export function isProductionFullData(payload) {
  return payload?.production === true && payload?.level === 'data';
}

/** A Salesforce read in plain words, one line each (spec §10): org, production or sandbox, level, object, what it asks. */
export function sfReadLines(payload) {
  const p = payload ?? {};
  const lines = [
    `Reads ${p.production === true ? 'PRODUCTION' : 'sandbox'} org ${p.alias ?? '(no alias)'}, read only: GET requests, nothing written.`,
    `Level: ${p.level ?? '(none)'}.`,
  ];
  if (p.level === 'objects') lines.push("The org's object list.");
  // dataops_alfred-d4x: a metadata read of several objects, in one link.
  else if (Array.isArray(p.objects)) lines.push(`Objects (${p.objects.length}): ${p.objects.join(', ')}.`);
  else lines.push(`Object: ${p.object ?? '(none)'}.`);
  if (p.level === 'metadata') lines.push("The object's describe: its fields and types, no records.");
  if (p.count === true) lines.push('A count only: no rows.');
  else if (Array.isArray(p.fields)) {
    lines.push(`Fields: ${p.fields.join(', ')}.`);
    lines.push(`Limit: up to ${p.limit ?? '?'} rows.`);
  }
  if (p.level === 'ids' || p.level === 'data') {
    const filters = Array.isArray(p.filters) ? p.filters : [];
    if (!filters.length) lines.push('Filters: none.');
    filters.forEach((f, i) => lines.push(`Filter ${i + 1}: ${f?.field} ${f?.op} ${JSON.stringify(f?.value)}`));
  }
  lines.push("The helper first checks the org's Id and IsSandbox, and its access level, against orgs.json.");
  lines.push('The answer goes to Alfred for at most 10 minutes, for Claude to take once and summarise.');
  return lines;
}

// ---------------------------------------------------------------------------
// dataops_alfred-d4x A2: a production data run (kind sf_dataop). The payload is the contract in
// docs/technical-spec-dataops_alfred-d4x.md; the helper checks every shown value against the stamped plan before it
// writes, so the page shows what will run. Orange is the PRODUCTION warning (O7); red stays for problems.
// ---------------------------------------------------------------------------

/** The stamp's first 12 characters, as sb prints it. */
export const shortStamp = (stamp) => String(stamp ?? '').slice(0, 12);

/** An ISO time in the viewer's local time, or the text as given if it doesn't parse. */
export function localTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? String(iso ?? '') : new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

const KNOCK_ON = 'Knock-on check: ';
/** A row's label, with the knock-on prefix sb uses when the row is one and the label doesn't already carry it. */
export function rowLabel(row) {
  const label = String(row?.label ?? '');
  return row?.knock_on === true && !label.startsWith(KNOCK_ON.trim()) ? `${KNOCK_ON}${label}` : label;
}

const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '?');

function DataopRun({ payload }) {
  const p = payload ?? {};
  const n = p.expected;
  const write = p.write?.kind === 'batch' ? `Batch Apex class ${p.write?.class ?? '(no class)'}` : 'Bulk dataop';
  const rows = Array.isArray(p.rows) ? p.rows : [];
  return (
    <div data-testid="approve-dataop" className="mb-4">
      <p data-testid="approve-dataop-count" className="text-2xl font-bold text-dark mb-3 break-words">
        About to change {count(n)} live record{n === 1 ? '' : 's'}
      </p>
      <p data-testid="approve-dataop-problem" className="text-dark mb-4 break-words">{p.problem}</p>
      <dl className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        <dt className="font-medium">Org</dt><dd className="font-mono break-all">{p.alias}</dd>
        <dt className="font-medium">Object</dt><dd className="font-mono break-all">{p.object}</dd>
        <dt className="font-medium">Write</dt><dd data-testid="approve-dataop-write" className="break-words">{write}</dd>
        <dt className="font-medium">Stamp</dt>
        <dd data-testid="approve-dataop-stamp" className="min-w-0">
          <span className="font-mono font-bold">{shortStamp(p.stamp)}</span>
          <span className="block font-mono text-xs break-all">{p.stamp}</span>
        </dd>
        <dt className="font-medium">Preflight</dt><dd data-testid="approve-dataop-preflight">{localTime(p.preflight_at)}</dd>
        {p.rehearsal && (
          <>
            <dt className="font-medium">Sandbox</dt>
            <dd data-testid="approve-dataop-rehearsal" className="break-words">
              Rehearsed on <span className="font-mono">{p.rehearsal.sandbox}</span> at {localTime(p.rehearsal.at)}
            </dd>
          </>
        )}
        <dt className="font-medium">Plan</dt><dd className="font-mono text-xs break-all">{p.repo}\{p.plan}</dd>
      </dl>
      <div className="mb-2 overflow-x-auto">
        <table data-testid="approve-dataop-rows" className="w-full text-sm text-dark border-collapse">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 pr-3 font-medium">Check</th>
              <th className="py-2 px-2 font-medium text-right">Before</th>
              <th className="py-2 pl-2 font-medium text-right">Goal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-knock-on={r.knock_on === true ? '' : undefined}
                className={`border-b border-border ${r.before !== r.goal ? 'font-bold' : ''}`}>
                <td className="py-2 pr-3 break-words">{rowLabel(r)}</td>
                <td className="py-2 px-2 text-right tabular-nums">{count(r.before)}</td>
                <td className="py-2 pl-2 text-right tabular-nums">{count(r.goal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-dark mb-4">Bold rows are the fix. The others are safety checks and must not change.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// dataop_link-k7d A1: production exports or counts (kind sf_dataquery), docs/technical-spec-dataop_link-k7d.md part 6.
// Every query is shown whole, in payload order, as text: the helper checks each hash against the run folder before
// anything runs, so the page shows exactly what will run. Orange is the PRODUCTION warning, as for sf_dataop.
// ---------------------------------------------------------------------------

export const DATAQUERY_EXPORT_STEPS = ['manifest', 'before', 'undo'];

/** 'exports' or 'counts', from the first query's step (the database refuses a link that mixes them). */
export function dataqueryMode(payload) {
  const first = Array.isArray(payload?.queries) ? payload.queries[0] : null;
  return DATAQUERY_EXPORT_STEPS.includes(first?.step) ? 'exports' : 'counts';
}

/**
 * dataquery_fixes-v3n: 'sandbox' or 'production' from the payload's org_type, or null for a link from before it
 * (shown as production, the louder side, with "org type not recorded").
 */
export function dataqueryOrgType(payload) {
  const t = payload?.org_type;
  return t === 'sandbox' || t === 'production' ? t : null;
}

/** A sha256 as the page shows it first: its first 12 characters. */
export const shortHash = (h) => String(h ?? '').slice(0, 12);

function Hash({ value, testId }) {
  return (
    <details data-testid={testId} className="min-w-0">
      <summary className="cursor-pointer font-mono" title={value}>{shortHash(value)}…</summary>
      <span className="block font-mono text-xs break-all">{value}</span>
    </details>
  );
}

function DataqueryRun({ payload }) {
  const p = payload ?? {};
  const queries = Array.isArray(p.queries) ? p.queries : [];
  const mode = dataqueryMode(p);
  const n = queries.length;
  return (
    <div data-testid="approve-dataquery" data-dataquery-mode={mode} className="mb-4 min-w-0">
      <p data-testid="approve-dataquery-mode" className="text-2xl font-bold text-dark mb-3 break-words">
        {mode === 'exports'
          ? `Exports ${n} ${n === 1 ? 'query' : 'queries'} to files on your computer`
          : `Counts ${n} ${n === 1 ? 'query' : 'queries'}`}
      </p>
      <dl className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="font-medium">Org</dt><dd data-testid="approve-dataquery-alias" className="font-mono break-all">{p.alias}</dd>
        <dt className="font-medium">Repo</dt><dd data-testid="approve-dataquery-repo" className="font-mono text-xs break-all">{p.repo}</dd>
        <dt className="font-medium">Run folder</dt><dd data-testid="approve-dataquery-run" className="font-mono text-xs break-all">{p.run}</dd>
        <dt className="font-medium">Run tag</dt><dd data-testid="approve-dataquery-run-tag" className="font-mono break-all">{p.run_tag}</dd>
        {p.request_sha256 && (
          <>
            <dt className="font-medium">Request</dt>
            <dd className="min-w-0"><Hash value={p.request_sha256} testId="approve-dataquery-request" /></dd>
          </>
        )}
      </dl>
      <ol data-testid="approve-dataquery-queries" className="mb-4 space-y-4 list-none p-0">
        {queries.map((q, i) => (
          <li key={i} data-testid="approve-dataquery-query" data-step={q.step}
            className="min-w-0 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
              <span className="font-bold">{i + 1}.</span>
              <span data-testid="approve-dataquery-step" className="px-2 py-0.5 rounded bg-orange-100 text-black font-mono">{q.step}</span>
              <span data-testid="approve-dataquery-source" className="break-all">
                {q.file !== undefined ? <>File <span className="font-mono">{q.file}</span></> : <>Rule <span className="font-medium">{q.label}</span></>}
              </span>
            </div>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2"><span>SHA-256</span><Hash value={q.sha256} testId="approve-dataquery-sha" /></div>
            <pre data-testid="approve-dataquery-soql"
              className="m-0 p-3 bg-white rounded border border-border font-mono text-xs text-dark whitespace-pre-wrap break-words max-w-full">{q.soql}</pre>
          </li>
        ))}
      </ol>
      <p data-testid="approve-dataquery-returns" className="text-sm text-dark mb-4 break-words">
        Comes back to Alfred: one count per query ({mode === 'exports' ? 'the rows exported' : 'the COUNT()'}) and a pass or
        fail. No rows, Ids or field values reach Alfred; {mode === 'exports' ? 'the exported files stay' : 'everything else stays'} in
        the run folder on your computer.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// dataop_write-j5w A2: Data run v2's write link (kind sf_datawrite), docs/technical-spec-dataop_write-j5w.md part 4.
// Everything is shown in full and as text, nothing cut or folded away: the write, every query under its step, every
// hash, and the files the run writes to the org. Orange is PRODUCTION, sky blue SANDBOX, from org_type.
// ---------------------------------------------------------------------------

export const DATAWRITE_STEPS = [
  { step: 'gate', title: 'Gate', what: 'Fresh exports, compared on your computer before anything is written.' },
  { step: 'after', title: 'After', what: 'The exports after the write, for the per-record check (PASS or FAIL).' },
  { step: 'after-counts', title: 'After counts', what: 'The rule counts, reported and never judged.' },
];

/** 'sandbox' or 'production' (the database requires one); anything else is shown as production, the louder side. */
export const datawriteOrgType = (payload) => (payload?.org_type === 'sandbox' ? 'sandbox' : 'production');

/** Ids in a query, counted as the database counts them: quoted literals of exactly 15 or 18 letters and digits. */
export const datawriteIdCount = (soql) => (String(soql ?? '').match(/'[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?'/g) ?? []).length;

/** The fixed title a file gets in the org (s5): the batch can't know the action id, so it is named by class. */
export function datawriteUploadTitle(purpose, write) {
  const cls = write?.class;
  if (!cls) return null;
  return purpose === 'undo-ids' ? `dataop-undo:${cls}` : `dataop-exclude:${cls}`;
}

/** The one plain sentence at the top. */
export function datawriteSentence(payload) {
  const p = payload ?? {};
  const kind = datawriteOrgType(p) === 'sandbox' ? 'sandbox' : 'live';
  return `This changes ${count(p.expected)} ${kind} record${p.expected === 1 ? '' : 's'} of ${p.object} in ${p.alias}.`;
}

function FullHash({ value, testId }) {
  return (
    <span data-testid={testId} className="block min-w-0">
      <span className="font-mono font-bold">{shortHash(value)}</span>
      <span className="block font-mono text-xs break-all">{value}</span>
    </span>
  );
}

function DatawriteWrite({ write, expected }) {
  const w = write ?? {};
  if (w.kind === 'batch') {
    return (
      <dd data-testid="approve-datawrite-write" className="min-w-0 break-words">
        Batch Apex class <span className="font-mono font-bold">{w.class}</span>:{' '}
        <span className="font-mono">new {w.class}()</span>, runs SELECTION = selection.soql
      </dd>
    );
  }
  if (w.kind === 'bulk') {
    return (
      <dd data-testid="approve-datawrite-write" className="min-w-0 break-words">
        Bulk <span className="font-mono font-bold">{w.operation}</span> from <span className="font-mono">{w.csv}</span>
        <FullHash value={w.csv_sha256} testId="approve-datawrite-csv-sha" />
      </dd>
    );
  }
  if (w.kind === 'undo') {
    return (
      <dd data-testid="approve-datawrite-write" className="min-w-0 break-words">
        Undo: reverse batch <span className="font-mono font-bold">{w.class}</span> reading{' '}
        <span className="font-mono">{w.ids_file}</span>, <span data-testid="approve-datawrite-ids-rows">{count(expected)} rows</span>
        <FullHash value={w.ids_sha256} testId="approve-datawrite-ids-sha" />
      </dd>
    );
  }
  return <dd data-testid="approve-datawrite-write" className="min-w-0 break-words">Unknown write: {String(w.kind)}</dd>;
}

function DatawriteRun({ payload }) {
  const p = payload ?? {};
  const queries = Array.isArray(p.queries) ? p.queries : [];
  const uploads = Array.isArray(p.uploads) ? p.uploads : [];
  const w = p.write ?? {};
  const hasBatch = w.kind === 'batch' || w.kind === 'undo';
  let n = 0;
  return (
    <div data-testid="approve-datawrite" data-write-kind={w.kind} className="mb-4 min-w-0">
      <p data-testid="approve-datawrite-sentence" className="text-2xl font-bold text-dark mb-3 break-words">{datawriteSentence(p)}</p>
      {p.problem && <p data-testid="approve-datawrite-problem" className="text-dark mb-4 break-words">{p.problem}</p>}
      <dl className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="font-medium">Org</dt><dd data-testid="approve-datawrite-alias" className="font-mono break-all">{p.alias}</dd>
        <dt className="font-medium">Object</dt><dd data-testid="approve-datawrite-object" className="font-mono break-all">{p.object}</dd>
        <dt className="font-medium">Write</dt><DatawriteWrite write={w} expected={p.expected} />
        <dt className="font-medium">Repo</dt><dd data-testid="approve-datawrite-repo" className="font-mono text-xs break-all">{p.repo}</dd>
        <dt className="font-medium">Run folder</dt><dd data-testid="approve-datawrite-run" className="font-mono text-xs break-all">{p.run}</dd>
        <dt className="font-medium">Run tag</dt><dd data-testid="approve-datawrite-run-tag" className="font-mono break-all">{p.run_tag}</dd>
        <dt className="font-medium">request.json</dt><dd className="min-w-0"><FullHash value={p.request_sha256} testId="approve-datawrite-request" /></dd>
        <dt className="font-medium">selection.soql</dt><dd className="min-w-0"><FullHash value={p.selection_sha256} testId="approve-datawrite-selection" /></dd>
      </dl>

      {DATAWRITE_STEPS.map(({ step, title, what }) => {
        const inStep = queries.filter((q) => q?.step === step);
        if (!inStep.length) return null;
        return (
          <section key={step} data-testid="approve-datawrite-stage" data-step={step} className="mb-4 min-w-0">
            <h2 className="text-lg font-bold text-dark mb-1">{title}</h2>
            <p className="text-sm text-dark mb-2 break-words">{what}</p>
            <ol className="space-y-4 list-none p-0 m-0">
              {inStep.map((q) => {
                n += 1;
                const ids = datawriteIdCount(q.soql);
                return (
                  <li key={n} data-testid="approve-datawrite-query" data-step={q.step}
                    className="min-w-0 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
                      <span className="font-bold">{n}.</span>
                      <span data-testid="approve-datawrite-source" className="break-all">
                        {q.file !== undefined ? <>File <span className="font-mono">{q.file}</span></> : <span className="font-medium">{q.label}</span>}
                      </span>
                    </div>
                    {ids > 0 && (
                      <p data-testid="approve-datawrite-ids" className="mb-2 font-bold break-words">
                        This snapshot lists {count(ids)} record Id{ids === 1 ? '' : 's'}.
                      </p>
                    )}
                    {q.wait && (
                      <p data-testid="approve-datawrite-wait" className="mb-2 break-words">
                        Waits until the count is steady for {q.wait.stable_minutes} minute{q.wait.stable_minutes === 1 ? '' : 's'},
                        for at most {q.wait.limit_minutes} minute{q.wait.limit_minutes === 1 ? '' : 's'}.
                      </p>
                    )}
                    <div className="mb-2"><span>SHA-256</span><FullHash value={q.sha256} testId="approve-datawrite-sha" /></div>
                    <pre data-testid="approve-datawrite-soql"
                      className="m-0 p-3 bg-white rounded border border-border font-mono text-xs text-dark whitespace-pre-wrap break-words max-w-full">{q.soql}</pre>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}

      {w.kind === 'bulk' ? (
        // s6b: a bulk write uploads nothing; left-out records come out of the CSV on Alex's PC.
        <section data-testid="approve-datawrite-files" className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark min-w-0">
          <h2 className="text-lg font-bold mb-2">Records left out at the gate</h2>
          <p data-testid="approve-datawrite-bulk-exclude" className="m-0 break-words">
            Records left out at the gate are removed from the CSV before the write.
          </p>
        </section>
      ) : (
      <section data-testid="approve-datawrite-files" className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark min-w-0">
        <h2 className="text-lg font-bold mb-2">Files the run writes to {datawriteOrgType(p) === 'sandbox' ? 'the sandbox' : 'production'}</h2>
        <ul className="list-disc pl-6 space-y-2 m-0">
          {uploads.map((u, i) => {
            const title = datawriteUploadTitle(u.purpose, w);
            return (
              <li key={i} data-testid="approve-datawrite-upload" data-purpose={u.purpose} className="min-w-0 break-words">
                Uploads <span className="font-mono">{u.file}</span> ({count(u.rows)} rows), titled{' '}
                <span data-testid="approve-datawrite-upload-title" className="font-mono font-bold break-all">{title ?? `${u.purpose} (no class to name it)`}</span>
                <FullHash value={u.sha256} testId="approve-datawrite-upload-sha" />
              </li>
            );
          })}
          {/* s6b: once only. An exclude upload already in the payload is listed above. */}
          {w.kind !== 'undo' && !uploads.some((u) => u?.purpose === 'exclude') && (
            <li data-testid="approve-datawrite-exclude" className="break-words">
              exclude.csv, if you leave records out at the gate
              {datawriteUploadTitle('exclude', w) && (
                <>, titled <span data-testid="approve-datawrite-exclude-title" className="font-mono font-bold break-all">{datawriteUploadTitle('exclude', w)}</span></>
              )}
            </li>
          )}
          {hasBatch && (
            <li data-testid="approve-datawrite-failures" className="break-words">
              Creates the failure file, a ContentVersion titled with the batch&apos;s job Id
            </li>
          )}
        </ul>
        <p data-testid="approve-datawrite-leftover" className="mt-2 mb-0 break-words">
          A file left over from a run that wasn&apos;t closed out makes the helper refuse to start; <span className="font-mono">sb closeout</span> clears it.
        </p>
      </section>
      )}

      <section data-testid="approve-datawrite-after" className="mb-4 text-sm text-dark min-w-0">
        <h2 className="text-lg font-bold mb-2">After you approve</h2>
        <ul className="list-disc pl-6 space-y-1 m-0 break-words">
          <li>The desktop helper must pick the run up within 15 minutes, or it fails unrun.</li>
          <li>It runs the gate first.</li>
          <li>
            Its window asks for Enter before the {datawriteOrgType(p) === 'sandbox' ? 'write' : 'live write'}
            {w.kind === 'bulk' ? '' : ' and before any upload'}; q stops it with nothing changed.
          </li>
          <li>The run is limited to 4 hours.</li>
          <li>Only counts and PASS or FAIL come back to Alfred. No rows, Ids, names, emails or amounts.</li>
        </ul>
      </section>
    </div>
  );
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
 * s86ag (Alex, 2026-11-10): the red bar means "this page waits for your Approve click"; no bar means it runs by itself
 * and closes. Decided from the page's own behaviour, not stakes: only a sql test (preview.test) runs on open, and
 * every other loaded preview waits for Approve. Never green, and never from the url.
 */
export function runsByItself(preview) {
  return !!preview && (!preview.kind || preview.kind === 'sql') && preview.test === true;
}
export function needsApprovalHeader(preview) {
  return !!preview && !runsByItself(preview);
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
        {/* s90d: a sql test runs and closes by itself, so nothing on it is approved. */}
        {runsByItself(preview) ? <div className="mb-6" /> : <p data-testid="approve-heading" className="text-sm text-dark text-center mb-6">Approve</p>}
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

const realSession = () => supabase.auth.getSession();

/**
 * `runner` and `session` exist only for the dev fixture (ApproveFixture.jsx, dataops_alfred-d4x s6b), which passes
 * local fakes. In use both are left out, so the page calls the real runner with the real session.
 */
export default function ApprovePage({ runner = callRunner, session = realSession } = {}) {
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
      const { data: { session: current } } = await session();
      if (!live) return;
      setSignedIn(Boolean(current));
      if (!current) return;
      try {
        const { status, body } = await runner('preview', { token });
        if (!live) return;
        if (body.ok) setPreview(body);
        else setEnded(linkEnded(status, body.error) ?? String(body.error));
      } catch {
        if (live) setEnded("Couldn't reach the runner. Nothing ran. Reload to try again.");
      }
    })();
    return () => { live = false; };
  }, [token, runner, session]);

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
      const out = await runner('dry-run', { token });
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
  const isSfRead = preview?.kind === 'sf_read';
  const isDataop = preview?.kind === 'sf_dataop';
  const isDataquery = preview?.kind === 'sf_dataquery';
  const isDatawrite = preview?.kind === 'sf_datawrite';
  const isGit = preview?.kind === 'git' || isSb || isSf || isSfRead || isDataop || isDataquery || isDatawrite;

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
      const out = await runner('approve', { token, fingerprint: preview.fingerprint });
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
      const out = await runner('cancel', { token, reason });
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
    // An sf_read's line is sf <id>, like a check's; a production data run's is dataop <id> (the helper's LINE_WORD).
    const word = isSb ? 'sb' : isSf || isSfRead ? 'sf' : isDataop ? 'dataop' : isDataquery ? 'dataquery' : isDatawrite ? 'datawrite' : 'git';
    const lines = isDataop || isDataquery || isDatawrite ? [] : isSb ? sbLines(preview.payload) : isSf ? sfLines(preview.payload)
      : isSfRead ? sfReadLines(preview.payload) : gitLines(preview.payload, preview.project_code);
    return (
      <Shell preview={preview}>
        {approving && <span hidden data-switchboard-running={preview.kind} />}
        {isDataop && (
          <div data-testid="approve-production" role="alert"
            className="mb-4 w-full bg-orange-400 text-black text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg">
            Production, live client data
          </div>
        )}
        {/* dataquery_fixes-v3n: orange PRODUCTION, or a sky-blue SANDBOX that never says production; no org_type is production. */}
        {isDataquery && dataqueryOrgType(preview.payload) === 'sandbox' && (
          <div data-testid="approve-sandbox-read" role="alert"
            className="mb-4 w-full bg-sky-700 text-white text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg">
            Sandbox, read only
            <span data-testid="approve-sandbox-read-mode" className="block text-lg sm:text-xl normal-case tracking-normal mt-1">
              {dataqueryMode(preview.payload) === 'exports' ? 'Bulk exports' : 'Counts'}
            </span>
          </div>
        )}
        {isDataquery && dataqueryOrgType(preview.payload) !== 'sandbox' && (
          <div data-testid="approve-production-read" role="alert"
            className="mb-4 w-full bg-orange-400 text-black text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg">
            Production, read only
            <span data-testid="approve-production-read-mode" className="block text-lg sm:text-xl normal-case tracking-normal mt-1">
              {dataqueryMode(preview.payload) === 'exports' ? 'Bulk exports' : 'Counts'}
            </span>
            {dataqueryOrgType(preview.payload) === null && (
              <span data-testid="approve-org-type-missing" className="block text-base sm:text-lg normal-case tracking-normal mt-1">
                Org type not recorded
              </span>
            )}
          </div>
        )}
        {/* dataop_write-j5w: orange PRODUCTION or sky-blue SANDBOX, from org_type. */}
        {isDatawrite && datawriteOrgType(preview.payload) === 'sandbox' && (
          <div data-testid="approve-sandbox-write" role="alert"
            className="mb-4 w-full bg-sky-700 text-white text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg">
            Sandbox, changes records
          </div>
        )}
        {isDatawrite && datawriteOrgType(preview.payload) === 'production' && (
          <div data-testid="approve-production-write" role="alert"
            className="mb-4 w-full bg-orange-400 text-black text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg">
            Production, changes live records
          </div>
        )}
        {isSfRead && isProductionFullData(preview.payload) && (
          <div data-testid="approve-production-full-data" role="alert"
            className="mb-4 w-full bg-red-700 text-white text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg">
            Production full data
          </div>
        )}
        <p className="font-bold text-dark mb-2 break-words">{preview.headline}</p>
        {preview.kind === 'git' && typeof preview.payload?.then?.send === 'string' && (
          <p data-testid="approve-chain" className="text-dark mb-2 break-words">
            Then sends the prompt <span className="font-mono break-all">{preview.payload.then.send}</span> when you tap the tile.
          </p>
        )}
        {/* w3k s9: a Salesforce repo's Finish with no production deploy recorded; approving is Alex's word that none went out. */}
        {preview.kind === 'git' && preview.payload?.command === 'gitpush' && preview.payload?.mode === 'finish'
          && preview.payload?.no_prod_deploy === true && (
          <p data-testid="approve-no-prod-deploy" role="alert"
            className="mb-2 p-3 bg-red-700 text-white font-bold text-lg rounded-lg break-words">
            Approving confirms nothing from {preview.project_code} went to production.
          </p>
        )}
        <p className="text-sm text-dark">Project</p>
        <p className="font-mono text-dark mb-4 break-all" data-switchboard-project={preview.project_code} data-switchboard-kind={preview.kind}>{preview.project_code}</p>
        {isDataop ? <DataopRun payload={preview.payload} /> : isDataquery ? <DataqueryRun payload={preview.payload} />
          : isDatawrite ? <DatawriteRun payload={preview.payload} /> : (
          <ul data-testid={`approve-${isSfRead ? 'sf-read' : word}`} className="mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark break-words list-disc pl-8">
            {lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
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
              summary={isDataop
                ? 'It must pick it up within 15 minutes, or it fails unrun. It checks the stamp and the sandbox pass first, and pauses for your Enter before it writes. The result comes back to the chat when it finishes.'
                : isDataquery
                ? 'It must pick it up within 15 minutes, or it fails unrun. It checks every query\'s hash against the run folder first. Only the counts and a pass or fail come back to the chat.'
                : isDatawrite
                ? `It must pick it up within 15 minutes, or it fails unrun. It runs the gate first, and its window asks for your Enter before the write${preview.payload?.write?.kind === 'bulk' ? '' : ' and before any upload'}; q stops it with nothing changed. Only counts and PASS or FAIL come back to the chat.`
                : 'It runs in a terminal window on your computer. The result comes back to the chat when it finishes.'}
              runId={id} />
            <ResultLine line={`${word} ${id}`} />
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-dark">
              {isDataop
                ? 'A production data run has no dry run here: its sandbox rehearsal was the dry run. Approve runs this once, on your computer, against the live org.'
                : isDataquery
                ? 'A production read has no dry run. Approve runs these queries once, on your computer, against the live org. Nothing here writes.'
                : isDatawrite
                ? `A data write has no dry run here: its sandbox rehearsal was the dry run. Approve starts this once, on your computer, against ${datawriteOrgType(preview.payload) === 'sandbox' ? 'the sandbox' : 'the live org'}.`
                : `${isSb ? 'An sb setup' : isSf ? 'An sf check' : isSfRead ? 'An sf read' : 'Git'} has no dry run. Approve runs this once, on your computer.`}
            </p>
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
