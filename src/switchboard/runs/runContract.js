// sb3_pages-h6v A1: the contract the Switchboard 3 run pages read (docs/technical-spec-sb3_pages-h6v.md part 4).
// A PROPOSAL until the design thread reconciles it with the data runs thread. Pure functions only: no React, no
// network, so the simulation, the pages and later the queue tool's checks can share the same rules.

// The extension lets the mcp Edge Function (Deno) and node load this file too: one copy of the rules (sb3 B3).
import { noteOnChange } from './codeDiff.js';

export const PAGES = ['precheck', 'dataop', 'undo', 'correction', 'check', 'delete_test_data'];
/** s34 (O24, spec 17.2): the page that deletes the TEST records a pre-check kept, on one sandbox only. */
export const DELETE_TEST_PAGE = 'delete_test_data';
export const DELETE_TEST_STEPS = ['find_kept_test', 'type_count', 'delete_kept_test', 'confirm_gone'];
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
  delete_test_data: ['Sandbox clean-up'],
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
  // s34 (O18): in place of delete_test when the request keeps them (the data runs thread's wording).
  keep_test: { group: 'Sandbox rehearsal', org: 'sandbox', text: () => 'Keep the TEST records in the sandbox for later.' },
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
  // s34 (O24): the delete page, sandbox only. Its type_count is in PAGE_STEPS.
  find_kept_test: { group: 'Sandbox clean-up', org: 'sandbox', text: (s, r) => `Confirm ${targetOrg(r)?.alias ?? '?'} is a sandbox, then find the TEST records the pre-check kept, by the Ids saved on your PC. Any already gone are counted and listed.` },
  delete_kept_test: { group: 'Sandbox clean-up', org: 'sandbox', text: () => "Delete those TEST records, and only those. A record that isn't a TEST record stops the run with nothing deleted." },
  confirm_gone: { group: 'Sandbox clean-up', org: 'sandbox', text: () => 'Confirm none of them is left.' },
};

/** s34: a step code whose group, org and text differ on one page (the delete page's type_count is the sandbox's). */
const PAGE_STEPS = {
  delete_test_data: {
    type_count: { group: 'Sandbox clean-up', org: 'sandbox', text: () => 'You type the number of TEST records the terminal finds; anything else stops with nothing deleted.' },
  },
};
/** A step code's definition on a page: the page's own where it has one, else the shared one. */
export const stepDef = (code, page) => PAGE_STEPS[page]?.[code] ?? STEPS[code];

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
  if (r?.page === DELETE_TEST_PAGE) {
    return `Deletes up to ${n(c.expected)} TEST ${plural(c.expected, 'record')} of ${obj} that pre-check run ${r.test_data_of?.run_tag ?? '?'} kept in ${targetOrg(r)?.alias ?? '?'}.`;
  }
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
  ? (r.steps ?? []).some((s) => stepDef(s?.code, r.page)?.org === type)
  : (r?.orgs ?? []).some((o) => o.org_type === type));

/** The total a write page shows (the count sentence and detail): undo_up_to or expected on an undo, else total or expected. */
export function shownTotal(r) {
  const c = r?.counts ?? {};
  return r?.page === 'undo' ? c.undo_up_to ?? c.expected : c.total ?? c.expected;
}

/** The large count sentence: only on pages that write (data operation, undo). Null elsewhere. */
export function countSentence(r) {
  // s34 (O24): the terminal asks for the number it finds, so the delete page promises only "up to".
  if (r?.page === DELETE_TEST_PAGE) {
    const e = r.counts?.expected;
    return `This deletes up to ${n(e)} TEST ${plural(e, 'record')} of ${r.operation?.object_label ?? r.operation?.object ?? '?'} in ${targetOrg(r)?.alias ?? '?'}.`;
  }
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
  // s34 (O24): the delete page has the sandbox banner only.
  if (r?.page === DELETE_TEST_PAGE) {
    return { production: null, sandbox: `This deletes up to ${n(c.expected)} TEST ${plural(c.expected, 'record')}. Nothing else changes.` };
  }
  return {
    production: touches(r, 'production')
      ? (writes && t?.org_type === 'production' ? `This changes ${r.page === 'undo' ? 'up to ' : ''}${recs(total).replace('record', 'live record')}.` : 'Read only, nothing changes.')
      : null,
    sandbox: touches(r, 'sandbox')
      ? (writes && t?.org_type === 'sandbox' ? `This changes ${r.page === 'undo' ? 'up to ' : ''}${recs(total)}.`
        : keepsTestRecords(r) ? 'TEST records are created and changed, and kept for later. Nothing else changes.'
          : 'TEST records are created, changed and deleted. Nothing else changes.')
      : null,
  };
}

/** The Approve button's label. */
export function approveLabel(r) {
  if (r?.page === 'undo') return 'Approve this UNDO on PRODUCTION';
  if (r?.page === 'check') return 'Check what happened on PRODUCTION';
  if (r?.page === DELETE_TEST_PAGE) return 'Delete the TEST records in SANDBOX';
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
  if (r?.page === DELETE_TEST_PAGE) return 'Undo: none. Deleted TEST records are not restored; the rehearsal made them.';
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
    const prod = [...codes].some((c) => stepDef(c, r.page)?.org === 'production');
    const sandbox = [...codes].some((c) => stepDef(c, r.page)?.org === 'sandbox');
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
  } else if (r?.page === DELETE_TEST_PAGE) {
    lines.push(`A terminal window on your desktop confirms ${targetOrg(r)?.alias ?? '?'} is a sandbox, finds the kept TEST records by the Ids saved on your PC, lists any already gone, then asks you to type the number it finds. Anything else stops it with nothing deleted.`);
    lines.push('Back to Alfred: the counts and pass or fail for each step. Nothing in production is touched.');
  }
  return lines;
}

/** The Problem box's Count: the total, with an upsert's split or a multi-object run's steps. */
export function countDetail(r) {
  const c = r?.counts ?? {};
  const total = r?.page === 'undo' ? c.undo_up_to ?? c.expected : c.total ?? c.expected;
  if (r?.page === 'undo') return `Up to ${n(total)}`;
  if (r?.page === DELETE_TEST_PAGE) return `Up to ${n(c.expected)}`;
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
  if (r?.page === DELETE_TEST_PAGE) return `The TEST records pre-check run ${r.test_data_of?.run_tag ?? '?'} kept, by the Ids saved on your PC.`;
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

const FAILURE_WORDS = { stopped: 'The run stopped partway.' };
/**
 * s21b: how a finished run ended, from the preview's run (status, ok, pass, summary, failure_reason; spec 14.8), or
 * null while it hasn't finished or never started. A failed run (status failed, ok false or a failure_reason) is
 * failed, with its reason, never finished. A succeeded run is PASS or FAIL by pass; once the result is pruned pass is
 * null and it reads plain finished. A run row finished while its action isn't yet succeeded (the runner still
 * recording its evidence) hasn't ended: null, so the page reads running. A sample run with no status counts as
 * succeeded. The helper posts the done and failed lines, so the page draws none.
 */
export function runEnd(run) {
  if (!run?.finished_at || notStarted(run)) return null;
  if (run.status === 'failed' || run.ok === false || run.failure_reason) {
    const summary = typeof run.summary === 'string' ? run.summary.trim() : '';
    const reason = summary || FAILURE_WORDS[run.failure_reason] || run.failure_reason || 'No reason was recorded.';
    return { state: 'failed', word: 'failed', reason };
  }
  if (typeof run.status === 'string' && run.status !== 'succeeded') return null;
  if (run.pass === true) return { state: 'pass', word: 'finished: PASS' };
  if (run.pass === false) return { state: 'fail', word: 'finished: FAIL' };
  return { state: 'finished', word: 'finished' };
}

/** The pre-check and rehearsal that "Run the pre-check and rehearsal again" runs, listed in full beneath it. */
export function rerunRequest(r) {
  const count = r?.selected_by?.kind === 'filter' ? 'count_filter' : 'count_listed';
  const codes = [count, 'login_can_change', 'list_automation', 'save_backup', 'create_test', 'rehearse_operation', 'rehearse_undo',
    keepsTestRecords(r) ? 'keep_test' : 'delete_test'];
  return { ...r, page: 'precheck', steps: codes.map((code) => ({ code })) };
}
export const RERUN_LABEL = 'Run the pre-check and rehearsal again';

/** The correction page's "Still valid, not run again": [{ check, passed_at }]. */
export const stillValid = (r) => (r?.page === 'correction' && Array.isArray(r.changed?.still_valid) ? r.changed.still_valid : []);

/** The checks a data operation's write needs, each passed and in use (as switchboard_consume_run_link holds them). */
export const WRITE_CHECKS = ['count', 'login', 'automation', 'backup', 'rehearsal'];

/**
 * B4 (spec 10d item 3): the status a real page shows, built from the request's evidence, which only the database
 * writes, never from what the chat sent. On a pre-check, data operation or correction page, the phases and (on a
 * correction) "Still valid" are rebuilt from the evidence in use: the pre-check and rehearsal passed when every write
 * check is in use, at the newest of them, "(run again)" when that came after a rerun was asked for; the correction's
 * still-valid list is every check in use with its own time. An undo or check page is left as it is: its phases report
 * the earlier run, which has no evidence here. The expiry is validUntil(evidence) already.
 */
export function statusFromEvidence(r) {
  if (!r || typeof r !== 'object' || !['precheck', 'dataop', 'correction'].includes(r.page)) return r;
  const inUse = (Array.isArray(r.evidence) ? r.evidence : [])
    .filter((e) => e && !e.voided && typeof e.passed_at === 'string' && !Number.isNaN(Date.parse(e.passed_at)));
  const passed = r.page !== 'correction' && WRITE_CHECKS.every((c) => inUse.some((e) => e.check === c));
  const newest = inUse.length ? new Date(Math.max(...inUse.map((e) => Date.parse(e.passed_at)))).toISOString() : null;
  const rerun = passed && Boolean(r.rerun_at) && Date.parse(newest) > Date.parse(r.rerun_at);
  const first = passed
    ? { name: 'Pre-check and rehearsal', state: 'passed', at: newest, ...(rerun ? { rerun: true } : {}) }
    : { name: 'Pre-check and rehearsal', state: 'waiting' };
  const second = { name: 'Data operation', state: r.page === 'dataop' && passed ? 'waiting' : 'not_started' };
  const out = { ...r, phases: [first, second] };
  if (r.page === 'correction') {
    // Only what passed before the correction: a check that has since passed again was run again.
    const since = Date.parse(r.corrected_at ?? '');
    out.changed = { ...(r.changed ?? {}), still_valid: inUse
      .filter((e) => Number.isNaN(since) || Date.parse(e.passed_at) <= since)
      .map(({ check, passed_at }) => ({ check, passed_at })) };
  }
  return out;
}
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
  delete_test_data: 'Delete sandbox test data',
};

/** s34 (O18): the request keeps its TEST records (only the value true; a pre-check or its correction). */
export const keepsTestRecords = (r) => r?.keep_test_records === true;
/** A kept set as the runner reports it, {count, sandbox}: count 1 to 999,999,999, sandbox a name. */
const keptSet = (k) => isPlain(k) && Number.isInteger(k.count) && k.count >= 1 && k.count <= 999_999_999
  && typeof k.sandbox === 'string' && k.sandbox.trim() !== '';
/**
 * s34 (O18, spec 17.1): "N TEST records kept in <sandbox>." on a pre-check page, summing every kept set not yet
 * deleted (request.kept_test_records, which the database keeps, one per run), by sandbox; the run's own
 * kept_test_records when the request has none recorded. Null when nothing is kept.
 */
export function keptTestLine(r, run) {
  if (!['precheck', 'correction'].includes(r?.page)) return null;
  // The run's own set only when the database has recorded none: a recorded set that was deleted stays deleted.
  const recorded = Array.isArray(r.kept_test_records) && r.kept_test_records.length > 0;
  const sets = recorded ? r.kept_test_records.filter((k) => keptSet(k) && !k.deleted_by)
    : keptSet(run?.kept_test_records) ? [run.kept_test_records] : [];
  if (!sets.length) return null;
  const by = new Map();
  sets.forEach((k) => by.set(k.sandbox, (by.get(k.sandbox) ?? 0) + k.count));
  return [...by].map(([sb, c]) => `${n(c)} TEST ${plural(c, 'record')} kept in ${sb}.`).join(' ');
}
/** s34 (O24): why a delete page can't be drawn: any org other than its one sandbox. Null when it can. */
export function deletePageOrgProblem(r) {
  if (r?.page !== DELETE_TEST_PAGE) return null;
  const orgs = Array.isArray(r.orgs) ? r.orgs : [];
  return orgs.length === 1 && orgs[0]?.org_type === 'sandbox' && orgs[0]?.role === 'target' ? null
    : 'This delete page names an org that is not its one sandbox, so it is not shown. Nothing was approved.';
}

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
    const def = stepDef(s?.code, r.page);
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
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const count0 = (v) => Number.isInteger(v) && v >= 0;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** s28: request.pretend's scenario name, as the queue checks it (256): a name, never a path. */
export const PRETEND_SCENARIO = /^[a-z0-9_-]{1,40}$/;
/** s28: a pretend request (256): request.pretend = {scenario}, only on a simulation. */
export const isPretendRequest = (r) => r?.simulation === true && isPlain(r?.pretend);

/** s28 (item c): why an undo page has no sample record. */
export const UNDO_NO_SAMPLE = 'No sample record here: an undo has no pre-check. The terminal shows a fresh sample before it counts.';

/** s28 (O17): the details.queries label that carries an Id list's Ids, or a filter's production query (s30). */
export const RECORDS_QUERY = 'records';
/** s30 (16.2): the label of a filter's sandbox query, there exactly when selected_by.sandbox_text is. */
export const SANDBOX_RECORDS_QUERY = 'sandbox records';

// s30 (16.2): a filter's WHERE clause is comparisons joined by AND, nothing else, so the count can't move between the
// pre-check and the write. Tokens: a quoted string, an operator, a bracket, a word (fields, values, keywords), or any
// other one character (a comma in the SELECT list; inside the WHERE clause it breaks a comparison).
const SOQL_TOKEN = /\s*('(?:\\.|[^'\\])*'|<=|>=|!=|<>|=|<|>|\(|\)|[A-Za-z0-9_.:+-]+|[^\s'])/y;
const SOQL_END = /^(ORDER|LIMIT|GROUP|OFFSET|FOR|WITH)$/i;
const SOQL_REFUSED = /^(OR|NOT|IN|LIKE|INCLUDES|EXCLUDES)$/i;
const SOQL_FIELD = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
const SOQL_OPS = ['=', '!=', '<>', '<', '<=', '>', '>='];
const SOQL_VALUE = /^('(?:\\.|[^'\\])*'|-?\d+(\.\d+)?|true|false|null|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2}))$/i;
// Salesforce's relative date literals: TODAY, YESTERDAY, TOMORROW, THIS_WEEK, LAST_N_DAYS:30, NEXT_90_DAYS and the like.
const SOQL_RELATIVE = /^(TODAY|YESTERDAY|TOMORROW|(THIS|LAST|NEXT)_[A-Z0-9_]+(:\d+)?|N_[A-Z_]+_AGO:\d+)$/i;
const FILTER_RULE = 'only comparisons <field> <op> <value> joined by AND (op = != < <= > >=; value a quoted string, a number, true, false, null, or an ISO date or datetime)';

/**
 * s30 (16.2): the one problem with a filter query's WHERE clause, as a sentence starting `Fix details.queries "<label>"`,
 * or null when it is comparisons joined by AND. Quoted strings are skipped, so an AND inside quotes isn't a join.
 */
export function filterQueryProblem(label, soql) {
  const fix = (why) => `Fix details.queries "${label}": ${why}.`;
  if (typeof soql !== 'string' || !soql.trim()) return fix('its soql, the query, as text');
  const tokens = [];
  let pos = 0;
  for (;;) {
    SOQL_TOKEN.lastIndex = pos;
    const m = SOQL_TOKEN.exec(soql);
    if (!m) break;
    tokens.push(m[1]);
    pos = SOQL_TOKEN.lastIndex;
  }
  // An unclosed quote is the one thing left over.
  if (soql.slice(pos).trim()) return fix(`${FILTER_RULE}; it has an unclosed quote`);
  const start = tokens.findIndex((t) => /^WHERE$/i.test(t));
  if (start < 0) return fix(`a WHERE clause of ${FILTER_RULE}`);
  const end = tokens.findIndex((t, i) => i > start && SOQL_END.test(t));
  const where = tokens.slice(start + 1, end < 0 ? undefined : end);
  // What follows ORDER BY, LIMIT and the like is checked too (s30 cold review), so nothing slips in after them; WITH
  // is only a security or user mode, never WITH DATA CATEGORY (a filter of its own).
  const after = end < 0 ? [] : tokens.slice(end);
  const bad = [...where, ...after].find((t) => SOQL_REFUSED.test(t));
  if (bad) return fix(`${FILTER_RULE}; it has ${bad.toUpperCase()}`);
  if ([...where, ...after].some((t) => t === '(' || t === ')')) return fix(`${FILTER_RULE}; it has brackets`);
  const w = after.findIndex((t) => /^WITH$/i.test(t));
  if (w >= 0 && !/^(SECURITY_ENFORCED|USER_MODE|SYSTEM_MODE)$/i.test(after[w + 1] ?? '')) return fix(`${FILTER_RULE}; it has WITH ${after[w + 1] ?? ''}`.trimEnd());
  const groups = [[]];
  where.forEach((t) => (/^AND$/i.test(t) ? groups.push([]) : groups[groups.length - 1].push(t)));
  // A relative date is a value: only the token after an operator, so a field such as Last_Name__c isn't one.
  const rel = groups.map(([, op, v]) => (SOQL_OPS.includes(op) && SOQL_RELATIVE.test(v ?? '') ? v : null)).find(Boolean);
  if (rel) return fix(`no relative date such as ${rel}: a moving filter changes the count between the pre-check and the write; use a fixed date or datetime`);
  const whole = groups.every(([f, op, v, ...more]) => !more.length && SOQL_FIELD.test(f ?? '') && SOQL_OPS.includes(op) && SOQL_VALUE.test(v ?? ''));
  return whole ? null : fix(FILTER_RULE);
}

/** s28 (O2): the allowed modes of the structured allows. */
export const ALLOWS_MODES = ['frozen', 'moving'];
const ALLOWS_KEYS = ['mode', 'kinds', 'integrations', 'failure_tolerance'];

/**
 * s28 (O2): every problem with a top-level `allows`, each one sentence naming the key; empty when it is absent or
 * whole. Its shape: {mode: frozen | moving, kinds: [{kind, limit, reason}], integrations: {allowed, reason},
 * failure_tolerance: {rows, reason}}, every key present and nothing else.
 */
export function allowsProblems(a) {
  if (a === undefined) return [];
  if (!isPlain(a)) return ['Fix allows: {mode, kinds, integrations, failure_tolerance}, or leave it out.'];
  const out = [];
  const extra = Object.keys(a).filter((k) => !ALLOWS_KEYS.includes(k));
  if (extra.length) out.push(`Fix allows: leave out ${extra.join(', ')}; it has mode, kinds, integrations and failure_tolerance only.`);
  if (!ALLOWS_MODES.includes(a.mode)) out.push(`Fix allows.mode: ${ALLOWS_MODES.join(' or ')}.`);
  if (!Array.isArray(a.kinds)) out.push('Fix allows.kinds: a list of {kind, limit, reason}, empty if there are none.');
  else {
    a.kinds.forEach((k, i) => {
      if (!isPlain(k) || !text(k.kind) || !count0(k.limit) || !text(k.reason) || Object.keys(k).some((x) => !['kind', 'limit', 'reason'].includes(x))) {
        out.push(`Fix allows.kinds[${i}]: {kind, limit (a whole number, 0 or more), reason}, nothing else.`);
      }
    });
  }
  const ig = a.integrations;
  if (!isPlain(ig) || typeof ig.allowed !== 'boolean' || !text(ig.reason) || Object.keys(ig).some((x) => !['allowed', 'reason'].includes(x))) {
    out.push('Fix allows.integrations: {allowed (true or false), reason}, nothing else.');
  }
  const ft = a.failure_tolerance;
  if (!isPlain(ft) || !count0(ft.rows) || !text(ft.reason) || Object.keys(ft).some((x) => !['rows', 'reason'].includes(x))) {
    out.push('Fix allows.failure_tolerance: {rows (a whole number, 0 or more), reason}, nothing else.');
  }
  return out;
}

/** s28 (O2): the structured allows to draw, or null when it is absent or malformed (never half drawn). */
export const allowsView = (a) => (a !== undefined && allowsProblems(a).length === 0 ? a : null);

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
  const del = r.page === DELETE_TEST_PAGE;
  if (r.page !== 'check' && !del && !['ids', 'filter'].includes(r.selected_by?.kind)) out.push('Add selected_by: kind ids or filter, and its text.');
  // s34 (O18, spec 17.1): keep_test_records, true only, on a pre-check (or its correction); keep_test goes with it.
  if (r.keep_test_records !== undefined) {
    if (!['precheck', 'correction'].includes(r.page)) out.push('Leave keep_test_records out: only a pre-check keeps its TEST records.');
    else if (r.keep_test_records !== true) out.push('Fix keep_test_records: true, or leave it out.');
    else if (!(Array.isArray(r.orgs) && r.orgs.some((o) => o?.role === 'rehearsal' && o?.org_type === 'sandbox'))) {
      out.push('Add the rehearsal sandbox (role rehearsal, org_type sandbox): keep_test_records keeps the TEST records there.');
    }
  }
  // s34 (O24, spec 17.2): the delete page, one sandbox, the pre-check it cleans up after, the count, its four steps.
  if (r.test_data_of !== undefined && !del) out.push('Leave test_data_of out: only a delete page names the pre-check whose TEST records it deletes.');
  if (del) {
    const o = Array.isArray(r.orgs) ? r.orgs : [];
    if (!(o.length === 1 && o[0]?.org_type === 'sandbox' && o[0]?.role === 'target')) {
      out.push(`Fix orgs: a delete page runs on one sandbox only: one org, org_type sandbox, role target. ${NO_LINK}`);
    }
    if (r.operation?.kind !== 'delete') out.push('Fix operation.kind: a delete page deletes.');
    const t = r.test_data_of;
    if (!isPlain(t) || typeof t.request_id !== 'string' || !LOWER_UUID.test(t.request_id) || !text(t.run_tag)) {
      out.push("Add test_data_of: {request_id, run_tag}, the pre-check whose kept TEST records this deletes (its id a lower-case uuid).");
    }
    const ce = r.counts?.expected;
    if (!(Number.isInteger(ce) && ce >= 1)) out.push('Add counts.expected: the TEST records the pre-check kept, a whole number of 1 or more.');
    if (r.counts?.total !== undefined) out.push('Leave counts.total out: a delete page counts only what the pre-check kept.');
    const extra = ['selected_by', 'undo_of', 'interrupted', 'pre_check_request_id', 'sample', 'undo'].filter((k) => r[k] !== undefined);
    if (extra.length) out.push(`Leave ${extra.join(', ')} out of a delete page.`);
    const sc = (Array.isArray(r.steps) ? r.steps : []).map((s) => s?.code);
    if (sc.join() !== DELETE_TEST_STEPS.join()) out.push(`Fix steps: a delete page's steps are ${DELETE_TEST_STEPS.join(', ')}, in that order.`);
  }
  if (r.diagnosis_allows !== undefined && !(Array.isArray(r.diagnosis_allows) && r.diagnosis_allows.every(text))) {
    out.push("Fix diagnosis_allows: a list of sentences in diagnosis's words, or leave it out.");
  }
  // s28 (O2): the structured allows beside the sentences.
  out.push(...allowsProblems(r.allows));
  // s28: pretend, as the queue checks it (256).
  if (r.pretend !== undefined) {
    const p = r.pretend;
    if (!isPlain(p) || Object.keys(p).some((k) => k !== 'scenario') || typeof p.scenario !== 'string' || !PRETEND_SCENARIO.test(p.scenario)) {
      out.push(`Fix pretend: {"scenario": "<name>"}, the name 1 to 40 lower-case letters, digits, hyphens or underscores, and nothing else. ${NO_LINK}`);
    } else if (r.simulation !== true) {
      out.push(`Fix pretend: it needs simulation true, since a pretend run is a simulation whose data the helper makes up. ${NO_LINK}`);
    }
  }
  // s28 (O17): an Id list's Ids are the details.queries entry labelled "records", exactly one.
  const qs = Array.isArray(r.details?.queries) ? r.details.queries : [];
  const labelled = (label) => qs.filter((q) => q?.label === label);
  if (r.selected_by?.kind === 'ids') {
    const n = labelled(RECORDS_QUERY).length;
    if (n !== 1) out.push(`Add details.queries: exactly one entry labelled "${RECORDS_QUERY}", the query that lists the Ids (it has ${n}).`);
    if (labelled(SANDBOX_RECORDS_QUERY).length) out.push(`Leave out details.queries "${SANDBOX_RECORDS_QUERY}": only a filter has a sandbox query.`);
  }
  // s30 (16.2): a filter's production query is "records"; its sandbox query is "sandbox records", there exactly when
  // selected_by.sandbox_text is. Each one's WHERE clause is comparisons joined by AND.
  if (r.selected_by?.kind === 'filter') {
    const sel = r.selected_by;
    const rec = labelled(RECORDS_QUERY);
    if (rec.length !== 1) out.push(`Add details.queries: exactly one entry labelled "${RECORDS_QUERY}", the filter's query on production (it has ${rec.length}).`);
    if (sel.sandbox_text !== undefined && !text(sel.sandbox_text)) out.push("Fix selected_by.sandbox_text: the sandbox's filter in words, or leave it out.");
    const sb = labelled(SANDBOX_RECORDS_QUERY);
    if (text(sel.sandbox_text) && sb.length !== 1) out.push(`Add details.queries: exactly one entry labelled "${SANDBOX_RECORDS_QUERY}", the filter's query on the sandbox, since selected_by.sandbox_text is set (it has ${sb.length}).`);
    if (!text(sel.sandbox_text) && sb.length) out.push(`Leave out details.queries "${SANDBOX_RECORDS_QUERY}", or add selected_by.sandbox_text: a sandbox query goes with the sandbox's filter in words.`);
    for (const q of [...rec, ...sb]) {
      const p = filterQueryProblem(q.label, q.soql);
      if (p) out.push(p);
    }
  }
  // s28 (O5): undo_of.request_id names the data operation an undo undoes; the queue checks it is the caller's own.
  if (isPlain(r.undo_of) && Object.hasOwn(r.undo_of, 'request_id')) {
    if (r.page !== 'undo') out.push('Leave undo_of.request_id out: only an undo names the data operation it undoes.');
    else if (typeof r.undo_of.request_id !== 'string' || !LOWER_UUID.test(r.undo_of.request_id)) {
      out.push("Fix undo_of.request_id: the data operation request's id, a lower-case uuid.");
    }
  }
  // s30 (O23): interrupted.request_id names the data operation the interrupted run was; the queue (s31) checks it.
  if (isPlain(r.interrupted) && Object.hasOwn(r.interrupted, 'request_id')) {
    if (r.page !== 'check') out.push('Leave interrupted.request_id out: only a check names the data operation that was interrupted.');
    else if (typeof r.interrupted.request_id !== 'string' || !LOWER_UUID.test(r.interrupted.request_id)) {
      out.push("Fix interrupted.request_id: the interrupted data operation request's id, a lower-case uuid.");
    }
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
  // s34 (O18): keep_test replaces delete_test exactly when the request keeps its TEST records.
  const codesHere = steps.map((s) => s?.code);
  if (keepsTestRecords(r) && codesHere.includes('delete_test')) out.push('Fix steps: a request that keeps its TEST records lists keep_test, not delete_test.');
  if (!keepsTestRecords(r) && codesHere.includes('keep_test')) out.push('Fix steps: keep_test needs keep_test_records true; otherwise the rehearsal lists delete_test.');
  if (keepsTestRecords(r) && r.page === 'precheck' && !codesHere.includes('keep_test')) out.push('Add the keep_test step: a request that keeps its TEST records says so in its rehearsal.');
  steps.forEach((s, i) => {
    const def = stepDef(s?.code, r.page);
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
    // s34: a rehearsal that keeps its TEST records ends with keep_test where it would delete them.
    if (allowed.has('delete_test')) allowed.add('keep_test');
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

// s28: `simulated` prefixes SIMULATION on a real link id too: a pretend page's lines (its link is a real one).
function line(word, id, rest = '', simulated = false) {
  const simId = SIM_ID.test(String(id));
  if (!UUID.test(String(id)) && !simId) throw new Error(`not a link id: ${id}`);
  return `${simId || simulated ? 'SIMULATION ' : ''}${word} ${id}${rest}`;
}
const withText = (lead, t) => (lineText(t) ? `${lead}: ${lineText(t)}` : lead);

export const runLine = (id, simulated) => line('run', id, '', simulated);
export const runCancelledLine = (id, reason, simulated) => line('run', id, withText(' cancelled', reason), simulated);
export const runResentLine = (id, simulated) => line('run', id, ' resent', simulated);
// A correction page's Approve runs its reruns, not the write (s12b): its own word. A write approval stays runLine.
export const runRerunsLine = (id, simulated) => line('run', id, ' reruns', simulated);
// s30: `simulated` as runLine's, for a pretend check run (its link is a real one).
export function checkLine(id, { job, at_goal: goal, at_backup: backup, neither }, simulated = false) {
  return line('check', id, ` done: job ${lineText(job) || 'unknown'}; ${n(goal)} at goal, ${n(backup)} at backup, ${n(neither)} neither`, simulated);
}
export const reviewReviewedLine = (id) => line('review', id, ' reviewed');
export function reviewQuestionLine(id, question) {
  if (!lineText(question)) throw new Error('a question needs its text');
  return line('review', id, withText(' question', question));
}
/**
 * s17: the parts of a write's outcome (switchboard_run_requests.outcome, 254) the page shows, and nothing else. Its
 * shape belongs to the data runs thread; a part that is missing or malformed is left out, never guessed:
 *   changed  a count (an integer, 0 or more): "Changed: N records"
 *   rows     [{label, before, goal, after, knock_on?}]: a table, knock-on rows last, each cell a number or short text
 *   stopped  {already_changed (a count), saved_on_pc (text, or a list of text), next (one sentence), by_step
 *            ({step, object}, short text)}: on a stop, what already changed, what is saved on the PC, what to do next and
 *            where it stopped (s32, item d)
 *   skipped  [{kind, count}]: kind short text, count a count; one row each (s32, item d)
 * Counts and names only, never field values. Null when there is nothing to show.
 */
export function outcomeView(outcome) {
  if (!isPlain(outcome)) return null;
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const cell = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.length <= 200 ? v : null);
  const text = (v) => (typeof v === 'string' && v.trim() && v.length <= 500 ? v : null);
  const short = (v) => (typeof v === 'string' && v.trim() && v.length <= SHORT_TEXT_MAX ? v : null);
  const changed = count(outcome.changed);
  const rows = (Array.isArray(outcome.rows) ? outcome.rows : [])
    .filter((row) => row && typeof row === 'object' && text(row.label))
    .map((row) => ({ label: row.label, before: cell(row.before), goal: cell(row.goal), after: cell(row.after), knock_on: row.knock_on === true }));
  // Knock-on rows last, each group in its own order.
  const ordered = [...rows.filter((row) => !row.knock_on), ...rows.filter((row) => row.knock_on)];
  const s = isPlain(outcome.stopped) ? outcome.stopped : null;
  const saved = s ? (Array.isArray(s.saved_on_pc) ? s.saved_on_pc : [s.saved_on_pc]).map(text).filter(Boolean) : [];
  // s32 (item d): one sentence of at most 200 characters, and where it stopped; anything else is left out.
  const next = s && typeof s.next === 'string' && s.next.trim() && s.next.length <= 200 && !/\n/.test(s.next) ? s.next.trim() : null;
  const byStep = s && isPlain(s.by_step) && short(s.by_step.step) && short(s.by_step.object)
    ? { step: s.by_step.step, object: s.by_step.object } : null;
  const stopped = s && (count(s.already_changed) !== null || saved.length || next || byStep)
    ? { already_changed: count(s.already_changed), saved_on_pc: saved, next, by_step: byStep } : null;
  const skipped = (Array.isArray(outcome.skipped) ? outcome.skipped : [])
    .filter((k) => isPlain(k) && short(k.kind) && count(k.count) !== null)
    .map((k) => ({ kind: k.kind, count: k.count }));
  if (changed === null && !ordered.length && !stopped && !skipped.length) return null;
  return { changed, rows: ordered, stopped, skipped };
}

/** s32 (item d): the longest short text an outcome name may be (a step, an object, a kind of skip). */
export const SHORT_TEXT_MAX = 80;
/** s32 (item e): Salesforce's job states, and none for a small run with no job (258 takes the same list). */
export const CHECK_JOBS = ['Queued', 'Preparing', 'Processing', 'Holding', 'InProgress', 'Completed', 'Failed', 'Aborted', 'none'];
/** s32 (item e): the largest count a check reports, as 258's nine-digit rule. */
export const CHECK_COUNT_MAX = 999_999_999;
const checkCount = (v) => Number.isInteger(v) && v >= 0 && v <= CHECK_COUNT_MAX;

/**
 * s32 (item e): why a check's result {job, at_goal, at_backup, neither} can't be kept, or null. job one of CHECK_JOBS;
 * each count a whole number, 0 to CHECK_COUNT_MAX; nothing else. The runner refuses it before anything is stored, and
 * 258's switchboard_record_run_outcome refuses the same shapes.
 */
export function checkResultProblem(c) {
  const keys = ['job', 'at_goal', 'at_backup', 'neither'];
  if (!isPlain(c) || Object.keys(c).length !== keys.length || !keys.every((k) => Object.hasOwn(c, k))) {
    return 'check must be {job, at_goal, at_backup, neither}, nothing else.';
  }
  if (!CHECK_JOBS.includes(c.job)) return `check.job must be one of ${CHECK_JOBS.join(', ')}.`;
  if (!['at_goal', 'at_backup', 'neither'].every((k) => checkCount(c[k]))) {
    return `check.at_goal, at_backup and neither must each be a whole number from 0 to ${CHECK_COUNT_MAX.toLocaleString('en-US')}.`;
  }
  return null;
}

/** s32 (item e): a check page's stored outcome {check: {...}} to draw, or null when it is absent or malformed. */
export const checkOutcomeView = (outcome) =>
  (isPlain(outcome) && Object.keys(outcome).length === 1 && checkResultProblem(outcome.check) === null ? { ...outcome.check } : null);

export function reviewChangesLine(id, change) {
  if (!lineText(change)) throw new Error('changes required needs the change');
  return line('review', id, withText(' changes required', change));
}
