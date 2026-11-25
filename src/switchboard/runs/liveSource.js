// sb3_pages-h6v B4: the real source for the run and code review pages. It calls switchboard-run-pages with the
// signed-in session's JWT (spec 10b): preview at page open, then approve, rerun, resend, cancel and the review
// answers, each only on a click. The function's refusal text reaches the page unchanged. No polling, no timer: the
// only wait is the desktop check's one 2-second deadline (desktopCheck.js).

import { supabase, supabaseUrl, supabaseAnonKey } from '../../supabaseClient';
import { askDesktop } from './desktopCheck';
import { shownTotal, statusFromEvidence } from './runContract';

const realSession = () => supabase.auth.getSession();

/** A refusal or failure from the function: its own words, and its HTTP status. */
export class RunPagesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RunPagesError';
    this.status = status;
  }
}

/**
 * POST one route of switchboard-run-pages with the session's JWT. Resolves with the reply when ok; throws a
 * RunPagesError carrying the function's error text, word for word, otherwise.
 */
export async function callRunPages(route, body, { fetchImpl = (...a) => fetch(...a), getSession = realSession } = {}) {
  const { data } = await getSession();
  const jwt = data?.session?.access_token;
  if (!jwt) throw new RunPagesError('Sign in to Alfred first. Nothing was sent.', 401);
  let res;
  try {
    res = await fetchImpl(`${supabaseUrl}/functions/v1/switchboard-run-pages/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RunPagesError("Couldn't reach Alfred. Nothing was sent.", 0);
  }
  let reply = null;
  try { reply = await res.json(); } catch { reply = null; }
  if (!reply || reply.ok !== true) {
    throw new RunPagesError(typeof reply?.error === 'string' && reply.error ? reply.error : `Alfred answered ${res.status}.`, res.status);
  }
  return reply;
}

/**
 * Why a previewed link can't be acted on, in the database's own words (switchboard_consume_run_link's refusals), or
 * null when it can: voided (a correction or Don't run), or for an older version of the request.
 */
export function linkEndedReason(preview) {
  const link = preview?.link ?? {};
  if (link.voided_at) return `This link was voided (${link.void_reason ?? 'voided'}). Nothing was approved.`;
  if (link.current === false) return 'The request was corrected since this link was issued. Nothing was approved.';
  return null;
}

/**
 * The count the page approves: the preview's total_count, exactly (the count switchboard_consume_run_link checks),
 * never one worked out here. No total_count sends null, which a write refuses.
 */
export const approveCount = (preview) => preview?.total_count ?? null;

/**
 * On a write page (data operation, undo), the count the page shows must be the count Approve sends, or Alex would
 * approve a number he wasn't shown. When they differ, the reason the page offers no Approve; else null.
 */
export function countMismatch(preview) {
  const r = preview?.request;
  if (!r || !['dataop', 'undo'].includes(r.page)) return null;
  const shown = shownTotal(r);
  const sent = approveCount(preview);
  if (shown === sent && sent !== null) return null;
  return `The count on this page (${shown ?? 'none'}) is not the request's count in the database (${sent ?? 'none'}), so this page can't be approved. Ask Claude to correct the request. Nothing was approved.`;
}

/** 'real' only when the database says the request is not a simulation; anything else shows the SIMULATION strip. */
const kindOf = (preview) => (preview?.request?.simulation === false ? 'real' : 'sim');

/**
 * The real run page source for one token, from its preview. Its kind is fixed here, from the database's simulation
 * flag. The status (phases, "Still valid") is built from the evidence (statusFromEvidence), never from the chat.
 */
export function liveRunSource(token, preview, deps = {}) {
  const call = (route, body) => callRunPages(route, body, deps);
  const ask = deps.askDesktop ?? askDesktop;
  // The preview's run is the link's newest sf_run, which may be a rerun (a correction's Approve, or "Run the pre-check
  // and rehearsal again"). A rerun is not the write: the page sees it only as a rerun still pending (approved, not
  // finished, not left unstarted), so once it finishes the same link offers what comes next, as the database does.
  const rerun = preview.run?.rerun === true ? preview.run : null;
  const rerunPending = Boolean(rerun) && !rerun.finished_at && !rerun.not_started;
  const mismatch = countMismatch(preview);
  const request = { ...statusFromEvidence(preview.request), ...(rerunPending ? { rerun_pending: true } : {}),
    ...(mismatch ? { count_mismatch: mismatch } : {}) };
  let desktop = null;
  const clickBody = () => ({ token, fingerprint: preview.fingerprint, desktop });
  return {
    kind: kindOf(preview),
    load: async () => ({ link_id: preview.link_id, request, sample: preview.sample ?? null, run: rerun ? null : preview.run ?? null }),
    // The page asks at open, on Check again and at the click (Q9); the click sends the newest answer.
    checkDesktop: async () => { desktop = await ask(); return desktop; },
    approve: async () => ({ sent: true, ...(await call('approve', { ...clickBody(), count: approveCount(preview) })) }),
    rerun: async () => ({ sent: true, rerun: true, ...(await call('rerun', clickBody())) }),
    resend: async () => ({ sent: true, resent: true, ...(await call('resend', clickBody())) }),
    cancel: async (reason) => {
      const out = await call('cancel', { token, reason: String(reason ?? '') });
      return { ...out, cancelled: true, reason: out.reason ?? '' };
    },
  };
}

/** The real code review page source for one token, from its preview: the review, with its request's headline and code. */
export function liveReviewSource(token, preview, deps = {}) {
  const call = (route, body) => callRunPages(route, body, deps);
  const ask = deps.askDesktop ?? askDesktop;
  let desktop = null;
  const review = { ...preview.review, headline: preview.request?.headline, project_code: preview.request?.project_code };
  const answer = (kind, text, acks) => call('review', { token, answer: kind, text, acks: acks ?? {}, desktop });
  return {
    kind: kindOf(preview),
    load: async () => ({ link_id: preview.link_id, review }),
    checkDesktop: async () => { desktop = await ask(); return desktop; },
    reviewed: (acks) => answer('reviewed', '', acks),
    question: (text, acks) => answer('question', String(text ?? '').trim(), acks),
    changes: (text, acks) => answer('changes_required', String(text ?? '').trim(), acks),
  };
}
