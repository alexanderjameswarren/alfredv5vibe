// sb3_pages-h6v A1: the contract the Switchboard 3 run pages read (docs/technical-spec-sb3_pages-h6v.md part 4).
// A PROPOSAL until the design thread reconciles it with the data runs thread. Pure functions only: no React, no
// network, so the simulation, the pages and later the queue tool's checks can share the same rules.

// The extension lets the mcp Edge Function (Deno) and node load this file too: one copy of the rules (sb3 B3).
import { noteOnChange } from './codeDiff.js';

export const PAGES = ['precheck', 'dataop', 'undo', 'correction', 'check'];
export const OPERATIONS = ['update', 'insert', 'upsert', 'delete', 'undelete', 'multi'];
export const ORG_TYPES = ['production', 'sandbox'];
export const PHASE_STATES = ['passed', 'waiting', 'not_started', 'interrupted'];
export const UNDO_LEVELS = ['standard', 'backup_only', 'none'];
export const CHECK_VALID_MS = 24 * 60 * 60 * 1000;
/** Today's chat lines cap a reason at 200 characters (the extension's POST_LINE); so do these. */
export const LINE_TEXT_MAX = 200;
/** The code review text box; the full text is kept on the review, the chat line carries the first 200. */
export const REVIEW_TEXT_MAX = 1000;

/** The agreed group headers, in order, per page. */
export const GROUPS = {
  precheck: ['Production pre-check', 'Sandbox rehearsal'],
  correction: ['Production pre-check', 'Sandbox rehearsal'],
  dataop: ['Before the write', 'Write', 'After the write'],
  undo: ['Before the write', 'Write', 'After the write'],
  check: ['What happened'],
};
export const STOPS_AT_FIRST_FAILURE = 'The run stops at the first step that fails.';

/**
 * Which checks each kind of correction runs again (the doc's table). 'new_request' means the edit is refused: it
 * needs a new request through diagnosis. An empty list means nothing runs, so the edit has no page of its own and the
 * next page carries the "Changed since you last approved" block.
 */
export const EDIT_RERUNS = {
  wording: [],
  allows: [],
  value: ['rehearsal'],
  file: ['rehearsal'],
  // Alex (s7, s8b): a different field means a different backup, and so a new sample record, too.
  field: ['rehearsal', 'login', 'backup', 'sample'],
  records: ['count', 'backup', 'sample'],
  records_filter: ['count', 'backup', 'sample', 'rehearsal'],
  sandbox_filter: ['rehearsal'],
  code: ['rehearsal', 'code_review'],
  object: 'new_request',
  operation: 'new_request',
};

/**
 * The step codes behind each check name in EDIT_RERUNS; evidence uses the same check names. The code review has no
 * step on a run page: it is its own page.
 */
export const CHECK_STEPS = {
  count: ['count_listed', 'count_filter'],
  backup: ['save_backup'],
  sample: ['save_backup'],
  login: ['login_can_change'],
  rehearsal: ['create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'],
  code_review: [],
};
/** The steps a correction runs again, as codes, for its "This run will:". */
export const rerunSteps = (editKind) => {
  const reruns = EDIT_RERUNS[editKind];
  return Array.isArray(reruns) ? [...new Set(reruns.flatMap((c) => CHECK_STEPS[c] ?? []))] : [];
};

const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');
const plural = (v, one, many = `${one}s`) => (v === 1 ? one : many);
const recs = (v) => `${n(v)} ${plural(v, 'record')}`;
/** "A, B and C". */
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** A step's or operation's object as people say it, plural ("Accounts"); the API name when there is none. */
const pluralLabel = (o) => o?.label_plural ?? o?.object ?? '?';
// upsert_undo: an upsert's undo deletes what it created and puts the updated records back.
const LOGIN_VERBS = { update: 'update', insert: 'create', upsert: 'create and update', delete: 'delete', undelete: 'restore', upsert_undo: 'delete and update' };
/** "Before the write", the first step: what must still be true depends on the operation, with the request's counts. */
function firstBeforeWrite(r) {
  const c = r?.counts ?? {};
  switch (r?.operation?.kind) {
    case 'insert':
    case 'multi': return 'Confirm none of the rows already exists.';
    case 'upsert': return `Confirm the ${recs(c.update)} to update still ${plural(c.update, 'matches', 'match')} the backup, and the ${n(c.create)} to create still ${plural(c.create, "doesn't", "don't")} exist.`;
    case 'undelete': return `Confirm the ${recs(c.expected)} ${plural(c.expected, 'is', 'are')} still in the recycle bin.`;
    default: return 'Confirm the records still match the backup.';
  }
}

/**
 * "Before the write": the login check names the field an update changes, what the other kinds do, and in a run
 * across several objects each object, grouped by what is done to it ("create Accounts, Contacts and Opportunities").
 */
/** What an undo does, by the run's operation: it puts an update back, restores a delete, deletes what was created. */
const UNDO_KINDS = { update: 'update', delete: 'undelete', undelete: 'delete', insert: 'delete', upsert: 'upsert_undo' };
function loginCanWrite(op) {
  if (op?.kind === 'multi') {
    const byVerb = new Map();
    (Array.isArray(op.steps) ? op.steps : []).forEach((s) => {
      const verb = LOGIN_VERBS[s?.kind] ?? 'update';
      const list = byVerb.get(verb) ?? [];
      if (!list.includes(pluralLabel(s))) list.push(pluralLabel(s));
      byVerb.set(verb, list);
    });
    return `Confirm the login can still ${[...byVerb].map(([verb, objs]) => `${verb} ${andList(objs)}`).join(', and ') || 'write'}.`;
  }
  return op?.field && (op.kind ?? 'update') === 'update'
    ? `Confirm the login can still update the ${op.field} field.`
    : `Confirm the login can still ${LOGIN_VERBS[op?.kind] ?? 'update'} ${op?.object_label ?? op?.object ?? 'these'} records.`;
}

/**
 * Every step code, the group and org it belongs to, and its fixed statement. The request sends codes; the tool and
 * the page turn them into these sentences, so no step text is ever typed. Each is a statement, never a question.
 */
export const STEPS = {
  // Pre-check page, production reads.
  count_listed: { group: 'Production pre-check', org: 'production', text: (s, r) => `Count how many of the ${recs(r.counts?.expected)} listed still exist.` },
  count_filter: { group: 'Production pre-check', org: 'production', text: (s, r) => `Count what the filter matches now, against diagnosis's expected ${n(r.counts?.expected)}.` },
  login_can_change: { group: 'Production pre-check', org: 'production', text: (s, r) => `Check the login doing the update may change ${r.operation?.field ?? 'the field'}.` },
  list_automation: { group: 'Production pre-check', org: 'production', text: () => 'List the triggers and flows that fire on save.' },
  save_backup: { group: 'Production pre-check', org: 'production', text: () => "Save the records' current values to your PC as the backup, and send one sample record to Alfred." },
  // Pre-check page, sandbox rehearsal.
  create_test: { group: 'Sandbox rehearsal', org: 'sandbox', text: (s, r) => (isFilter(r) ? "Create 3 TEST records that match the filter and 1 that doesn't." : 'Create 3 TEST records like the sample.') },
  rehearse_operation: { group: 'Sandbox rehearsal', org: 'sandbox', text: (s, r) => (isFilter(r) ? "Run the same operation and confirm each of the 3 changed and the 1 didn't." : 'Run the same operation and confirm each one changed.') },
  rehearse_undo: { group: 'Sandbox rehearsal', org: 'sandbox', text: () => 'Run the standard undo and confirm each one is back.' },
  delete_test: { group: 'Sandbox rehearsal', org: 'sandbox', text: () => 'Delete the TEST records.' },
  // Data operation and undo pages.
  still_match_backup: { group: 'Before the write', org: 'production', text: (s, r) => firstBeforeWrite(r) },
  login_can_write: { group: 'Before the write', org: 'production', text: (s, r) => (r?.page === 'undo'
    // The undo does the opposite of the run: a delete's undo restores (A7).
    ? loginCanWrite({ ...r.operation, kind: UNDO_KINDS[r.operation?.kind] ?? r.operation?.kind })
    : loginCanWrite(r.operation)) },
  automation_unchanged: { group: 'Before the write', org: 'production', text: (s, r) => (r?.page === 'undo'
    // Agreed with the hub (s6b).
    ? 'Confirm the triggers and flows are the same as when the run was recorded. If they differ, the undo stops with nothing changed.'
    : 'Confirm the triggers and flows are unchanged.') },
  skip_edited: { group: 'Before the write', org: 'production', text: () => 'Skip any record edited since the run, and list who changed it and when.' },
  type_count: { group: 'Write', org: 'production', text: (s, r) => (r.page === 'undo'
    ? 'You type the exact count left after skips in the terminal; anything else stops with nothing changed.'
    : `You type the count, ${n(r.counts?.total ?? r.counts?.expected)}, in the terminal; anything else stops with nothing changed.`) },
  write: { group: 'Write', org: 'production', text: (s, r) => writeStatement(r) },
  write_step: { group: 'Write', org: 'production', text: (s, r) => {
    // The last write step has no next step to stop before.
    const last = (r?.steps ?? []).filter((x) => x?.code === 'write_step').at(-1) === s;
    return `${s.pause_before ? 'Pause before this. ' : ''}${pluralLabel(s)}: ${LOGIN_VERBS[s.kind] ?? s.kind ?? '?'} ${recs(s.count)}.${last ? '' : ' A failed row stops the run before the next step.'}`;
  } },
  read_back: { group: 'After the write', org: 'production', text: () => 'Read each record back and confirm the goal, and that nothing else changed.' },
  save_results: { group: 'After the write', org: 'production', text: () => "Save the run's results to your PC and to Alfred." },
  // Check what happened page, read only.
  job_state: { group: 'What happened', org: 'production', text: () => "Read Salesforce's job state." },
  compare_records: { group: 'What happened', org: 'production', text: () => 'Compare each record with the backup and with the goal.' },
  find_temp_code: { group: 'What happened', org: 'production', text: () => 'Look for temporary code left in production.' },
};

const isFilter = (r) => r?.selected_by?.kind === 'filter';

/** The Write group's statement for the operation. */
function writeStatement(r) {
  const o = r.operation ?? {};
  const c = r.counts ?? {};
  if (r.page === 'undo') {
    return o.kind === 'delete'
      ? `Restore up to ${recs(c.undo_up_to ?? c.expected)} from the recycle bin.`
      : `Put back up to ${recs(c.undo_up_to ?? c.expected)} from the backup.`;
  }
  switch (o.kind) {
    case 'update': return `Update the ${recs(c.expected)}.`;
    case 'insert': return `Create ${recs(c.expected)} from ${o.file ?? 'the file of rows'} on your PC.`;
    case 'upsert': return `Update ${n(c.update)} and create ${recs(c.create)}, matched by ${o.external_id ?? 'the external Id'}.`;
    case 'delete': return `Delete the ${recs(c.expected)} to the recycle bin.`;
    case 'undelete': return `Restore the ${recs(c.expected)} from the recycle bin.`;
    default: return 'Write the records.';
  }
}

/** "What changes", built from the request's operation, never typed. */
export function whatChanges(r) {
  const o = r?.operation ?? {};
  const c = r?.counts ?? {};
  const obj = o.object ?? '?';
  // The undo page changes the records back, whatever the original operation did.
  if (r?.page === 'undo') {
    return o.kind === 'delete'
      ? `Restores up to ${recs(c.undo_up_to ?? c.expected)} of ${obj} from the recycle bin, undoing run ${r.undo_of?.run_tag ?? '?'}.`
      : `Puts back up to ${recs(c.undo_up_to ?? c.expected)} of ${obj} from the backup of run ${r.undo_of?.run_tag ?? '?'}.`;
  }
  if (r?.page === 'check') return 'Nothing: this page only reads.';
  switch (o.kind) {
    case 'update': return `Sets ${o.field ?? '?'} to ${JSON.stringify(o.value ?? null)} on ${recs(c.expected)} of ${obj}.`;
    case 'insert': return `Creates ${recs(c.expected)} of ${obj} from ${o.file ?? '?'}.`;
    case 'upsert': return `Updates ${n(c.update)} and creates ${recs(c.create)} of ${obj}, matched by ${o.external_id ?? '?'}.`;
    case 'delete': return `Deletes ${recs(c.expected)} of ${obj} to the recycle bin.`;
    case 'undelete': return `Restores ${recs(c.expected)} of ${obj} from the recycle bin.`;
    case 'multi': {
      const steps = Array.isArray(o.steps) ? o.steps : [];
      return `Runs ${steps.length} ${plural(steps.length, 'step')} across ${andList([...new Set(steps.map(pluralLabel))]) || '?'}: ${recs(c.total)} in all.`;
    }
    default: return '?';
  }
}

/** The target and rehearsal orgs. */
export const targetOrg = (r) => (r?.orgs ?? []).find((o) => o.role === 'target') ?? null;
export const rehearsalOrg = (r) => (r?.orgs ?? []).find((o) => o.role === 'rehearsal') ?? null;
// A correction touches only the orgs its rerun steps run on (a sandbox filter edit never reads production).
const touches = (r, type) => (r?.page === 'correction'
  ? (r.steps ?? []).some((s) => STEPS[s?.code]?.org === type)
  : (r?.orgs ?? []).some((o) => o.org_type === type));

/** The large count sentence: only on pages that write (data operation, undo). Null elsewhere. */
export function countSentence(r) {
  if (!r || !['dataop', 'undo'].includes(r.page)) return null;
  const t = targetOrg(r);
  const live = t?.org_type === 'sandbox' ? 'sandbox' : 'live';
  const c = r.counts ?? {};
  const total = r.page === 'undo' ? c.undo_up_to ?? c.expected : c.total ?? c.expected;
  // object_label: the object's name as people say it ("Gift"); the API name when there is none. Several objects: each.
  const obj = r.operation?.kind === 'multi'
    ? andList([...new Set((r.operation.steps ?? []).map(pluralLabel))])
    : r.operation?.object_label ?? r.operation?.object ?? '?';
  return `This changes ${r.page === 'undo' ? 'up to ' : ''}${n(total)} ${live} ${plural(total, 'record')} of ${obj} in ${t?.alias ?? '?'}.`;
}

/** The banners' second lines: { production, sandbox }, each a sentence or null when the page doesn't touch it. */
export function bannerLines(r) {
  const t = targetOrg(r);
  const writes = ['dataop', 'undo'].includes(r?.page);
  const c = r?.counts ?? {};
  const total = r?.page === 'undo' ? c.undo_up_to ?? c.expected : c.total ?? c.expected;
  return {
    production: touches(r, 'production')
      ? (writes && t?.org_type === 'production' ? `This changes ${r.page === 'undo' ? 'up to ' : ''}${recs(total).replace('record', 'live record')}.` : 'Read only, nothing changes.')
      : null,
    sandbox: touches(r, 'sandbox')
      ? (writes && t?.org_type === 'sandbox' ? `This changes ${r.page === 'undo' ? 'up to ' : ''}${recs(total)}.` : 'TEST records are created, changed and deleted. Nothing else changes.')
      : null,
  };
}

/** The Approve button's label. */
export function approveLabel(r) {
  if (r?.page === 'undo') return 'Approve this UNDO on PRODUCTION';
  if (r?.page === 'check') return 'Check what happened on PRODUCTION';
  const p = touches(r, 'production');
  const s = touches(r, 'sandbox');
  if (p && s) return 'Approve this run on PRODUCTION and SANDBOX';
  return s ? 'Approve this run on SANDBOX' : 'Approve this run on PRODUCTION';
}

export const MULTI_UNDO = "Undo: backup only. The Ids of everything created are saved on your PC. Undoing across several objects isn't in this version.";
const UNDO_WORDS ={ standard: 'standard', backup_only: 'backup only', none: 'none' };
/**
 * The undo line: level, mechanics and deadline only. An undo page has no undo, and says a further change is a new
 * request through diagnosis.
 */
export function undoLine(r) {
  if (r?.page === 'undo') return 'Undo: none. An undo has no undo. A further change is a new request through diagnosis.';
  if (r?.page === 'check') return null;
  // Across several objects the undo is always backup only, whatever the request says.
  if (r?.operation?.kind === 'multi') return MULTI_UNDO;
  const u = r?.undo;
  if (!u || !UNDO_LEVELS.includes(u.level)) return null;
  const parts = [`Undo: ${UNDO_WORDS[u.level]}.`];
  if (typeof u.mechanics === 'string' && u.mechanics.trim()) parts.push(u.mechanics.trim());
  if (typeof u.deadline === 'string' && u.deadline.trim()) parts.push(`Until ${u.deadline.trim()}.`);
  return parts.join(' ');
}

/** "Client · org (type)" under the phase header: the target first, then the rehearsal sandbox. */
export function clientOrgLine(r) {
  const orgs = [targetOrg(r), rehearsalOrg(r)].filter(Boolean).map((o) => `${o.alias} (${o.org_type})`);
  return [r?.client, ...orgs].filter(Boolean).join(' · ');
}

const PHASE_WORDS = { passed: 'passed', waiting: 'waiting', not_started: 'not started', interrupted: 'interrupted' };
export const phaseWord = (state) => PHASE_WORDS[state] ?? 'not started';

/** "After you approve", one statement per line. The 15-minute pickup is plumbing's; the page only says it. */
export function afterApproveLines(r) {
  const lines = ['The desktop helper must pick the run up within 15 minutes; if it doesn\'t, the page says "Not started. Nothing ran." and offers "Try again: resend this run".'];
  if (r?.page === 'precheck' || r?.page === 'correction') {
    // A correction reruns only some checks: say only what its steps do.
    const codes = new Set((r.steps ?? []).map((s) => s?.code));
    const prod = [...codes].some((c) => STEPS[c]?.org === 'production');
    const sandbox = [...codes].some((c) => STEPS[c]?.org === 'sandbox');
    lines.push(prod && sandbox
      ? 'A terminal window on your desktop runs the production pre-check first, read only, then the sandbox rehearsal.'
      : prod ? 'A terminal window on your desktop runs the production checks, read only.' : 'A terminal window on your desktop runs the sandbox rehearsal.');
    lines.push('Nothing in production changes.');
    lines.push(codes.has('save_backup')
      ? 'Back to Alfred: the counts, pass or fail for each step, and one sample record, held for at most 24 hours. The backup stays on your PC.'
      : 'Back to Alfred: pass or fail for each step.');
  } else if (r?.page === 'dataop' || r?.page === 'undo') {
    lines.push(r.page === 'undo'
      ? 'A terminal window on your desktop runs the checks before the write, lists any records skipped, then asks you to type the exact count left. Anything else stops it with nothing changed.'
      : `A terminal window on your desktop runs the checks before the write, then asks you to type the count, ${n(r.counts?.total ?? r.counts?.expected)}. Anything else stops it with nothing changed.`);
    lines.push('Back to Alfred: the counts and pass or fail for each step. The run\'s results are saved on your PC and in Alfred.');
  } else if (r?.page === 'check') {
    lines.push('A terminal window on your desktop reads, and changes nothing.');
    lines.push('Back to Alfred: the job state and three counts: records at the goal, at the backup, and neither.');
  }
  return lines;
}

/** The Problem box's Count: the total, with an upsert's split or a multi-object run's steps. */
export function countDetail(r) {
  const c = r?.counts ?? {};
  const total = r?.page === 'undo' ? c.undo_up_to ?? c.expected : c.total ?? c.expected;
  if (r?.page === 'undo') return `Up to ${n(total)}`;
  if (r?.operation?.kind === 'upsert') return `${n(total)}: ${n(c.update)} to update, ${n(c.create)} to create`;
  if (r?.operation?.kind === 'multi') {
    return `${n(total)} in all: ${(r.operation.steps ?? []).map((s) => `${n(s.count)} ${pluralLabel(s)}`).join(', ')}`;
  }
  return n(total);
}

/** A delete's knock-on counts, read by the pre-check: children deleted with it, links blanked, links blocking. */
export function knockOnLines(r) {
  if (r?.operation?.kind !== 'delete') return [];
  const c = r.counts ?? {};
  return [
    typeof c.children === 'number' && `${recs(c.children)} deleted with ${plural(c.expected, 'its parent', 'their parents')}`,
    typeof c.links_blanked === 'number' && `${n(c.links_blanked)} ${plural(c.links_blanked, 'link')} on other records blanked`,
    typeof c.links_blocking === 'number' && `${n(c.links_blocking)} ${plural(c.links_blocking, 'link')} blocking the delete`,
  ].filter(Boolean);
}

/** An undelete: the days left before Salesforce empties the recycle bin. */
export function daysLeftLine(r) {
  const d = r?.operation?.days_left;
  if (r?.operation?.kind !== 'undelete' || typeof d !== 'number') return null;
  return `${n(d)} ${plural(d, 'day')} left before Salesforce empties the recycle bin.`;
}

/** "Selected by": diagnosis's words, except a stopped run's undo, which selects only what that run changed (built). */
export function selectedByText(r) {
  if (r?.page === 'undo' && r.undo_of?.stopped) return `The ${recs(r.undo_of.changed ?? r.counts?.undo_up_to)} the stopped run changed.`;
  return r?.selected_by?.text ?? '';
}

/** The undo page: which run it undoes, and after a stopped run, only what that run changed. */
export function undoScopeLine(r) {
  if (r?.page !== 'undo') return null;
  const u = r.undo_of ?? {};
  const c = r.counts ?? {};
  const skips = 'Records edited since the run are skipped and listed with who changed them and when.';
  if (u.stopped) {
    return `Run ${u.run_tag ?? '?'} stopped before it finished, so this undo covers only the ${recs(u.changed ?? c.undo_up_to)} it changed. ${skips}`;
  }
  return `Undoes run ${u.run_tag ?? '?'}: up to ${recs(c.undo_up_to ?? c.expected)}. ${skips}`;
}

/**
 * Only an undo of a delete has a deadline (the recycle bin's 15 days); an update's undo restores from the backup on the
 * PC and never closes. An undo has no 24-hour expiry of its own (Alex, s6).
 */
export const undoHasDeadline = (r) => r?.page === 'undo' && r.operation?.kind === 'delete';

/** The undo page after its deadline: why no undo is offered, or null while it can still run. */
export function undoClosedReason(r, now = Date.now()) {
  if (!undoHasDeadline(r)) return null;
  // No readable deadline counts as passed: a delete's undo is never offered without one.
  const t = Date.parse(r.undo_of?.deadline ?? '');
  if (!Number.isNaN(t) && t > now) return null;
  return `No undo is offered: ${r.undo_of?.deadline_reason ?? 'its deadline has passed'}. A further change is a new request through diagnosis.`;
}

/** The 24-hour expiry, for every page but the undo page, which has none. */
export const pageExpired = (r, now = Date.now()) => r?.page !== 'undo' && checksExpired(r?.evidence, now);

/** The helper must pick an approved run up within this; plumbing's pickup refuses anything older. */
export const PICKUP_MS = 15 * 60 * 1000;
/**
 * "Not started. Nothing ran.": plumbing marks failure_reason 'expired_not_picked_up' (spec 4.5); until it does, the
 * page works it out at load from the stored times: consumed, never picked up, approved over 15 minutes ago.
 */
export function notStarted(run, now = Date.now()) {
  if (!run) return false;
  if (run.failure_reason === 'expired_not_picked_up') return true;
  const t = Date.parse(run.consumed_at ?? '');
  return !Number.isNaN(t) && !run.picked_up_at && !run.finished_at && now - t > PICKUP_MS;
}

/** The pre-check and rehearsal that "Run the pre-check and rehearsal again" runs, listed in full beneath it. */
export function rerunRequest(r) {
  const count = r?.selected_by?.kind === 'filter' ? 'count_filter' : 'count_listed';
  const codes = [count, 'login_can_change', 'list_automation', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo', 'delete_test'];
  return { ...r, page: 'precheck', steps: codes.map((code) => ({ code })) };
}
export const RERUN_LABEL = 'Run the pre-check and rehearsal again';

/** The correction page's "Still valid, not run again": [{ check, passed_at }]. */
export const stillValid = (r) => (r?.page === 'correction' && Array.isArray(r.changed?.still_valid) ? r.changed.still_valid : []);
const CHECK_WORDS = { count: 'Count', login: 'Login check', automation: 'Triggers and flows', backup: 'Backup', sample: 'Sample record', rehearsal: 'Sandbox rehearsal' };
export const checkWord = (check) => CHECK_WORDS[check] ?? check;

const SAMPLE_ROLES = { update: 'To update', create: 'To create' };
/** An upsert's two samples are labelled; a single record isn't. */
export const sampleRoleLabel = (role) => SAMPLE_ROLES[role] ?? null;

/** The phase header. */
export const PHASE_HEADERS = {
  precheck: 'Pre-check and rehearsal prior to data operation',
  dataop: 'Data operation',
  undo: 'Undo of a data operation',
  correction: 'Corrected request: checks to run again',
  check: 'Check what happened after an interrupted run',
};

/**
 * 24 hours from the oldest evidence still in use (not voided), as an ISO string; null when there is none (a pre-check
 * link has no expiry). The database computes this for real links; the page and the simulation use the same rule.
 */
export function validUntil(evidence) {
  const times = (Array.isArray(evidence) ? evidence : [])
    .filter((e) => !e?.voided && typeof e?.passed_at === 'string')
    .map((e) => Date.parse(e.passed_at))
    .filter((t) => !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times) + CHECK_VALID_MS).toISOString() : null;
}
export const checksExpired = (evidence, now = Date.now()) => {
  const v = validUntil(evidence);
  return v !== null && Date.parse(v) <= now;
};

/** "This run will:" as [{ group, steps: [{ code, org, text }] }], in the agreed group order; unknown codes are dropped. */
export function groupedSteps(r) {
  const groups = GROUPS[r?.page] ?? [];
  const steps = (Array.isArray(r?.steps) ? r.steps : []).map((s) => {
    const def = STEPS[s?.code];
    // The org comes from the step code alone, so a rehearsal step can never show a Production pill.
    return def ? { code: s.code, group: def.group, org: def.org, text: def.text(s, r) } : null;
  }).filter(Boolean);
  return groups.map((group) => ({ group, steps: steps.filter((s) => s.group === group) })).filter((g) => g.steps.length);
}

// ---------------------------------------------------------------------------
// validation: a request is refused before any link, with what to add
// ---------------------------------------------------------------------------

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const NO_LINK = 'No link was issued.';

/**
 * Every problem with a request, each one sentence saying what to add or fix. Empty when it can be shown.
 * opts.real: the request came from the real source, so a simulation mark is refused.
 */
export function requestProblems(r, opts = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [`The request is missing. ${NO_LINK}`];
  const out = [];
  if (opts.real && r.simulation) out.push(`This request is marked as a simulation, so it can't reach a real page. ${NO_LINK}`);
  if (!PAGES.includes(r.page)) out.push(`Add page: one of ${PAGES.join(', ')}.`);
  if (!text(r.project_code)) out.push('Add project_code.');
  if (!text(r.problem?.label) || !text(r.problem?.sentence)) {
    out.push(`Add the problem: its label (P1, P1a) and the problem in diagnosis's words, then queue again. ${NO_LINK}`);
  }
  if (!text(r.side_effects)) {
    out.push(`Add side_effects: the side effects in diagnosis's words, then queue again. ${NO_LINK}`);
  }
  const orgs = Array.isArray(r.orgs) ? r.orgs : [];
  if (!orgs.length) out.push('Add orgs: the target org, and the rehearsal sandbox where there is one.');
  orgs.forEach((o, i) => {
    if (!text(o?.alias) || !ORG_TYPES.includes(o?.org_type) || !['target', 'rehearsal'].includes(o?.role)) {
      out.push(`Fix orgs[${i}]: it needs alias, org_type production or sandbox, and role target or rehearsal.`);
    }
  });
  if (!targetOrg(r) && orgs.length) out.push('Add the target org (role target).');
  if (r.page !== 'check' && !OPERATIONS.includes(r.operation?.kind)) out.push(`Add operation.kind: one of ${OPERATIONS.join(', ')}.`);
  if (r.page !== 'check' && !text(r.operation?.object) && r.operation?.kind !== 'multi') out.push('Add operation.object.');
  if (r.operation?.kind === 'update' && !text(r.operation?.field)) out.push('Add operation.field: the field the update changes.');
  if (r.operation?.kind === 'insert' && !text(r.operation?.file)) out.push('Add operation.file: the file of rows on the PC.');
  if (r.operation?.kind === 'upsert' && !text(r.operation?.external_id)) out.push('Add operation.external_id.');
  if (r.operation?.kind === 'multi' && !(Array.isArray(r.operation?.steps) && r.operation.steps.length)) out.push('Add operation.steps: each object, its operation and count.');
  if (r.page !== 'check' && !['ids', 'filter'].includes(r.selected_by?.kind)) out.push('Add selected_by: kind ids or filter, and its text.');
  if (r.diagnosis_allows !== undefined && !(Array.isArray(r.diagnosis_allows) && r.diagnosis_allows.every(text))) {
    out.push("Fix diagnosis_allows: a list of sentences in diagnosis's words, or leave it out.");
  }
  if (r.page === 'precheck' && r.sample) out.push('Leave the sample out of a pre-check: the pre-check reads it.');
  if (r.page === 'check' && !text(r.interrupted?.run_tag)) out.push('Add interrupted: the run_tag of the interrupted run, when, and where it stopped.');
  if (r.page === 'check' && r.sample) out.push('Leave the sample out of a check: it only reads.');
  if (r.page === 'undo' && !text(r.undo_of?.run_tag)) out.push('Add undo_of: the run_tag of the run this undoes, and whether it stopped.');
  if (undoHasDeadline(r) && (Number.isNaN(Date.parse(r.undo_of?.deadline ?? '')) || !text(r.undo_of?.deadline_reason))) {
    out.push("Add undo_of.deadline and deadline_reason: a delete's undo ends when the records leave the recycle bin.");
  }
  // The database sets the version (4.1); when both are sent, they must agree.
  if (r.page === 'correction' && typeof r.version === 'number' && typeof r.changed?.from_version === 'number' && r.version !== r.changed.from_version + 1) {
    out.push('Fix version: a correction is one version up from changed.from_version.');
  }
  if (r.page === 'undo' && !undoHasDeadline(r) && (r.undo_of?.deadline !== undefined || r.undo_of?.deadline_reason !== undefined)) {
    out.push("Leave undo_of.deadline out: only a delete's undo has a deadline; this one restores from the backup on the PC.");
  }
  const c = r.counts ?? {};
  if (r.operation?.kind === 'upsert' && r.page !== 'undo' && (c.update ?? 0) + (c.create ?? 0) !== (c.total ?? c.expected)) {
    out.push('Fix counts: an upsert\'s update and create must add up to the total you type.');
  }
  if (r.operation?.kind === 'multi' && Array.isArray(r.operation?.steps) && r.operation.steps.reduce((a, s) => a + (s?.count ?? 0), 0) !== (c.total ?? c.expected)) {
    out.push("Fix counts: the steps' counts must add up to the total you type.");
  }
  if (r.page === 'dataop' && r.operation?.kind === 'delete' && !text(r.undo?.deadline)) out.push('Add undo.deadline: the date the deleted records leave the recycle bin, read by the pre-check.');
  if (r.page === 'dataop' && r.operation?.kind === 'undelete' && typeof r.operation?.days_left !== 'number') out.push('Add operation.days_left: the days before the recycle bin is emptied, read by the pre-check.');
  if (r.operation?.kind === 'multi' && Array.isArray(r.operation?.steps) && r.operation.steps.some((s) => !text(s?.object) || !OPERATIONS.includes(s?.kind) || s.kind === 'multi')) {
    out.push('Fix operation.steps: each needs an object and an operation (update, insert, upsert, delete or undelete).');
  }
  if (['dataop', 'undo'].includes(r.page) && r.undo && !UNDO_LEVELS.includes(r.undo.level)) out.push(`Fix undo.level: one of ${UNDO_LEVELS.join(', ')}.`);
  const steps = Array.isArray(r.steps) ? r.steps : [];
  if (!steps.length) out.push('Add steps: the step codes this run will take.');
  const groups = GROUPS[r.page] ?? [];
  steps.forEach((s, i) => {
    const def = STEPS[s?.code];
    if (!def) out.push(`Fix steps[${i}]: ${JSON.stringify(s?.code ?? null)} is not a known step code.`);
    else if (groups.length && !groups.includes(def.group)) out.push(`Fix steps[${i}]: ${s.code} doesn't belong on a ${r.page} page.`);
    else if (s.code === 'skip_edited' && r.page !== 'undo') out.push(`Fix steps[${i}]: skip_edited is for the undo page only.`);
    if (def && s?.org !== undefined && s.org !== def.org) out.push(`Fix steps[${i}]: ${s.code} always runs on ${def.org}; leave org out.`);
  });
  // A run across several objects: each write_step matches operation.steps, in order.
  if (r.operation?.kind === 'multi' && Array.isArray(r.operation?.steps)) {
    const ws = steps.filter((s) => s?.code === 'write_step');
    const os = r.operation.steps;
    if (ws.length !== os.length || ws.some((s, i) => s.object !== os[i]?.object || s.kind !== os[i]?.kind || s.count !== os[i]?.count)) {
      out.push('Fix steps: each write_step must match operation.steps, in order (object, kind and count).');
    }
  }
  // A correction lists only the checks its edit runs again; a wording or allowance edit has no page of its own.
  if (r.page === 'correction' && Array.isArray(EDIT_RERUNS[r.changed?.edit_kind])) {
    const reruns = EDIT_RERUNS[r.changed.edit_kind];
    if (!reruns.length) out.push(`A ${r.changed.edit_kind} edit runs nothing, so it has no page: the next page carries the change. ${NO_LINK}`);
    const allowed = new Set(reruns.flatMap((c) => CHECK_STEPS[c] ?? []));
    steps.forEach((s, i) => {
      if (STEPS[s?.code] && reruns.length && !allowed.has(s.code)) out.push(`Fix steps[${i}]: a ${r.changed.edit_kind} edit doesn't run ${s.code} again.`);
    });
  }
  if (r.changed !== undefined) {
    const kind = r.changed?.edit_kind;
    if (!Object.hasOwn(EDIT_RERUNS, kind)) out.push(`Fix changed.edit_kind: one of ${Object.keys(EDIT_RERUNS).join(', ')}.`);
    else if (EDIT_RERUNS[kind] === 'new_request') out.push(`A change to the ${kind} needs a new request through diagnosis, not a correction. ${NO_LINK}`);
    if (!text(r.changed?.reason)) out.push("Add changed.reason, in diagnosis's words.");
    if (!(Array.isArray(r.changed?.items) && r.changed.items.length)) out.push('Add changed.items: what changed, old and new.');
  }
  if (r.page === 'correction' && r.changed === undefined) out.push('Add changed: a correction page shows what changed.');
  return out;
}

/** Every problem with a code review, each one sentence. Empty when it can be shown. */
export function codeReviewProblems(cr) {
  if (!cr || typeof cr !== 'object') return ['The code review is missing.'];
  const out = [];
  if (!/^[0-9a-f]{7,40}$/.test(String(cr.commit ?? ''))) out.push('Add commit: the reviewed commit hash.');
  const files = Array.isArray(cr.files) ? cr.files : [];
  if (!files.length) out.push('Add files: each changed file.');
  const byPath = new Map();
  files.forEach((f, i) => {
    if (!text(f?.path)) out.push(`Fix files[${i}]: it needs a path.`);
    else byPath.set(f.path, f);
    if (!['new', 'modified', 'deleted'].includes(f?.status)) out.push(`Fix files[${i}].status: new, modified or deleted.`);
    if (f?.status !== 'deleted' && typeof f?.new_text !== 'string') out.push(`Add files[${i}].new_text: the whole file after the change.`);
    if (f?.status !== 'new' && typeof f?.old_text !== 'string') out.push(`Add files[${i}].old_text: the whole file before the change.`);
  });
  const ids = new Set();
  for (const part of ['fixed_by_cli', 'for_you']) {
    const list = cr.findings?.[part];
    if (!Array.isArray(list)) { out.push(`Add findings.${part}: a list, empty if there are none.`); continue; }
    list.forEach((f, i) => {
      if (!text(f?.id) || ids.has(f.id)) out.push(`Fix findings.${part}[${i}]: it needs an id no other finding has.`);
      else ids.add(f.id);
      if (!text(f?.text)) out.push(`Fix findings.${part}[${i}]: it needs its text.`);
    });
  }
  (Array.isArray(cr.notes) ? cr.notes : []).forEach((note, i) => {
    const f = byPath.get(note?.file);
    if (!f) { out.push(`Fix notes[${i}]: its file isn't in files.`); return; }
    const lines = typeof f.new_text === 'string' ? f.new_text.split('\n').length : 0;
    if (!Number.isInteger(note.start_line) || !Number.isInteger(note.end_line) || note.start_line < 1 || note.end_line < note.start_line || note.end_line > lines) {
      out.push(`Fix notes[${i}]: lines ${note.start_line}-${note.end_line} aren't in ${note.file}.`);
    } else if (!noteOnChange(f, note)) {
      // A6: a note sits on the change it explains.
      out.push(`Fix notes[${i}]: lines ${note.start_line}-${note.end_line} of ${note.file} aren't changed lines; a note sits on the change it explains.`);
    }
    if (!text(note.problem_label) || !text(note.text)) out.push(`Fix notes[${i}]: it needs a problem label and its text.`);
    else if (f.status === 'new' && /\n/.test(note.text.trim())) out.push(`Fix notes[${i}]: a note on a new file is one line.`);
    if (text(note.problem_label) && Array.isArray(f.problem_labels) && !f.problem_labels.includes(note.problem_label)) {
      out.push(`Fix notes[${i}]: ${note.problem_label} isn't one of ${note.file}'s problem labels.`);
    }
  });
  if (text(cr.superseded_by) && !/^[0-9a-f]{7,40}$/.test(cr.superseded_by)) out.push('Fix superseded_by: the newer commit hash.');
  return out;
}

// ---------------------------------------------------------------------------
// result lines, in today's shape: "<word> <id>[ <outcome>][: <text>]"
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIM_ID = /^sim-[a-z0-9-]{1,40}$/;

/** One line, at most LINE_TEXT_MAX characters, or '' for nothing. */
export const lineText = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  // Cut text ends with "…", still within the cap (A7).
  return s.length <= LINE_TEXT_MAX ? s : `${s.slice(0, LINE_TEXT_MAX - 1).trimEnd()}…`;
};

function line(word, id, rest = '') {
  const sim = SIM_ID.test(String(id));
  if (!UUID.test(String(id)) && !sim) throw new Error(`not a link id: ${id}`);
  return `${sim ? 'SIMULATION ' : ''}${word} ${id}${rest}`;
}
const withText = (lead, t) => (lineText(t) ? `${lead}: ${lineText(t)}` : lead);

export const runLine = (id) => line('run', id);
export const runCancelledLine = (id, reason) => line('run', id, withText(' cancelled', reason));
export const runResentLine = (id) => line('run', id, ' resent');
// A correction page's Approve runs its reruns, not the write (s12b): its own word. A write approval stays runLine.
export const runRerunsLine = (id) => line('run', id, ' reruns');
export function checkLine(id, { job, at_goal: goal, at_backup: backup, neither }) {
  return line('check', id, ` done: job ${lineText(job) || 'unknown'}; ${n(goal)} at goal, ${n(backup)} at backup, ${n(neither)} neither`);
}
export const reviewReviewedLine = (id) => line('review', id, ' reviewed');
export function reviewQuestionLine(id, question) {
  if (!lineText(question)) throw new Error('a question needs its text');
  return line('review', id, withText(' question', question));
}
export function reviewChangesLine(id, change) {
  if (!lineText(change)) throw new Error('changes required needs the change');
  return line('review', id, withText(' changes required', change));
}
