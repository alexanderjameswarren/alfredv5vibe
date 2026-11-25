// switchboard-run-pages: routes, input checks and response shaping for the Switchboard 3 run and code review pages
// (docs/technical-spec-sb3_pages-h6v.md parts 4, 5, 10a; migration 250_run_pages.sql). No network here: index.ts hands
// in the dependencies, so core.test.mjs runs it against fakes.
// Run the tests: node --experimental-strip-types --test supabase/functions/switchboard-run-pages/core.test.mjs
//
// Alex's routes (POST, his JWT; every one calls a 250 function with a client built from that JWT, so row-level
// security and the database's link rules decide, and their refusal text comes back unchanged):
//   /preview  { token }                                      -> switchboard_run_preview
//   /approve  { token, fingerprint, desktop, count }          -> switchboard_consume_run_link (approve)
//   /rerun    { token, fingerprint, desktop }                 -> switchboard_consume_run_link (rerun)
//   /resend   { token, fingerprint, desktop }                 -> switchboard_retry_run
//   /cancel   { token, reason? }                              -> switchboard_cancel_run_link (the note capped at 200)
//   /review   { token, answer, text?, acks, desktop? }        -> the code review answer (reviewed, question,
//             changes_required): the review is found through switchboard_run_preview with his JWT; the write is the
//             service role's, as 250 reserves it (s10 decision), with only the validated answer, text and acks.
// The desktop helper never calls this function (Alex's option A, s12): the evidence and the sample reach the database
// through switchboard-runner, which calls switchboard_record_run_evidence and switchboard_store_run_sample.
// Every reply carries "line": the result line to paste or post (spec 4.4), "SIMULATION "-prefixed for a simulation.

export const LINE_TEXT_MAX = 200;
export const REVIEW_TEXT_MAX = 1000;
const TOKEN = /^[0-9a-f]{64}$/;

export type DbError = { message: string; code?: string };
export type DbResult<T = unknown> = { data: T | null; error: DbError | null };

export type Deps = {
  userId: string;
  /** The JWT's user id, or null when it isn't a valid session. */
  authUser: (jwt: string) => Promise<string | null>;
  /** A 250 function, called with Alex's JWT. */
  rpcAsUser: (jwt: string, fn: string, args: Record<string, unknown>) => Promise<DbResult>;
  /**
   * The service role, only for the code review answer (250 reserves it): appends the answer and merges the acks, only
   * if the review is unchanged since it was read; says whether it did.
   */
  answerReview: (reviewId: string, patch: { status: string; acks: Record<string, unknown>; answer: Record<string, unknown> }) => Promise<boolean>;
  now?: () => Date;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const USER_ROUTES = new Set(["preview", "approve", "rerun", "resend", "cancel", "review"]);

export function json(body: unknown, status = 200, browser = false): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(browser ? CORS : {}) } });
}

/** One line, at most 200 characters; cut text ends with "…" (A7). */
export function lineText(t: unknown): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length <= LINE_TEXT_MAX ? s : `${s.slice(0, LINE_TEXT_MAX - 1).trimEnd()}…`;
}

/** A result line in today's shape (spec 4.4): "<word> <link id>[ <outcome>][: <text>]". */
export function resultLine(word: "run" | "review", linkId: string, rest: string, simulated: boolean): string {
  return `${simulated ? "SIMULATION " : ""}${word} ${linkId}${rest}`;
}


async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The database's refusal, passed on word for word, with a status from its error code. */
export function refusal(error: DbError, browser = true): Response {
  const status = error.code === "28000" ? 401 : error.code === "P0002" ? 404
    : error.code === "23514" || error.code === "22023" || error.code === "22P02" ? 400 : 409;
  return json({ ok: false, error: error.message, code: error.code ?? null }, status, browser);
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The desktop answer the page got at the click (Q9): only these keys go on. */
function desktopOf(v: unknown): Record<string, unknown> | null {
  if (!isObject(v)) return null;
  const out: Record<string, unknown> = {};
  if (typeof v.answer === "string") out.answer = v.answer.slice(0, 40);
  if (typeof v.panel === "boolean") out.panel = v.panel;
  if (typeof v.helper === "boolean") out.helper = v.helper;
  if (typeof v.extension_version === "string") out.extension_version = v.extension_version.slice(0, 40);
  return out;
}

// ---------------------------------------------------------------------------
// Alex's routes
// ---------------------------------------------------------------------------

async function handleUser(route: string, req: Request, deps: Deps): Promise<Response> {
  const reply = (body: unknown, status = 200) => json(body, status, true);
  const jwt = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const user = jwt ? await deps.authUser(jwt) : null;
  if (!user || user !== deps.userId) return reply({ ok: false, error: "unauthorized" }, 401);

  const body = await readBody(req);
  if (!body) return reply({ ok: false, error: "the body must be a JSON object." }, 400);
  const token = body.token;
  if (typeof token !== "string" || !TOKEN.test(token)) return reply({ ok: false, error: "token is missing or malformed." }, 400);
  const call = (fn: string, args: Record<string, unknown>) => deps.rpcAsUser(jwt, fn, args);

  if (route === "preview") {
    const res = await call("switchboard_run_preview", { p_token: token });
    if (res.error) return refusal(res.error);
    return reply({ ok: true, ...(res.data as Record<string, unknown>) });
  }

  if (route === "cancel") {
    const raw = body.reason;
    if (raw !== undefined && raw !== null && typeof raw !== "string") return reply({ ok: false, error: "reason must be text." }, 400);
    // The note is one line of at most 200 characters, cut with "…" (4.5 point 5).
    const note = lineText(raw ?? "");
    const preview = await call("switchboard_run_preview", { p_token: token });
    if (preview.error) return refusal(preview.error);
    const res = await call("switchboard_cancel_run_link", { p_token: token, p_reason: note || null });
    if (res.error) return refusal(res.error);
    const out = res.data as { link_id: string; reason: string | null };
    const simulated = simulationOf(preview.data);
    return reply({ ok: true, ...out, simulated,
      line: resultLine("run", out.link_id, out.reason ? ` cancelled: ${out.reason}` : " cancelled", simulated) });
  }

  if (route === "review") return handleReview(body, token, call, deps, reply);

  // approve, rerun, resend: the page sends back what it showed and what the desktop answered.
  const fingerprint = body.fingerprint;
  if (typeof fingerprint !== "string" || !fingerprint) return reply({ ok: false, error: "fingerprint is missing." }, 400);
  const desktop = desktopOf(body.desktop);
  if (route === "resend") {
    const res = await call("switchboard_retry_run", { p_token: token, p_fingerprint: fingerprint, p_desktop: desktop });
    if (res.error) return refusal(res.error);
    const out = res.data as { link_id: string };
    return reply({ ok: true, ...out, simulated: false, line: resultLine("run", out.link_id, " resent", false) });
  }
  let count: number | null = null;
  if (route === "approve") {
    if (body.count !== undefined && body.count !== null && !(Number.isInteger(body.count) && (body.count as number) >= 0)) {
      return reply({ ok: false, error: "count must be a whole number." }, 400);
    }
    count = (body.count as number | undefined) ?? null;
  }
  const res = await call("switchboard_consume_run_link", {
    p_token: token, p_fingerprint: fingerprint, p_desktop: desktop, p_count: count, p_mode: route === "rerun" ? "rerun" : "approve",
  });
  if (res.error) return refusal(res.error);
  const out = res.data as { link_id: string; simulated: boolean; as_rerun?: boolean };
  // A correction's Approve runs its reruns, not the write (251 as_rerun): `run <id> reruns` (s12b). The expired-checks
  // rerun (/rerun) and a write approval keep the bare line.
  const rest = route === "approve" && out.as_rerun === true ? " reruns" : "";
  return reply({ ok: true, ...out, line: resultLine("run", out.link_id, rest, out.simulated === true) });
}

const simulationOf = (preview: unknown) => isObject(preview) && isObject(preview.request) && preview.request.simulation === true;

const ANSWERS = new Set(["reviewed", "question", "changes_required"]);
const ANSWER_WORDS: Record<string, string> = { reviewed: " reviewed", question: " question", changes_required: " changes required" };

async function handleReview(
  body: Record<string, unknown>, token: string, call: (fn: string, args: Record<string, unknown>) => Promise<DbResult>,
  deps: Deps, reply: (b: unknown, s?: number) => Response,
): Promise<Response> {
  const answer = body.answer;
  if (typeof answer !== "string" || !ANSWERS.has(answer)) {
    return reply({ ok: false, error: "answer is reviewed, question or changes_required." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (answer !== "reviewed" && !text) return reply({ ok: false, error: "a question or a change needs its text." }, 400);
  if (text.length > REVIEW_TEXT_MAX) return reply({ ok: false, error: `the text is at most ${REVIEW_TEXT_MAX} characters.` }, 400);
  if (body.acks !== undefined && !isObject(body.acks)) return reply({ ok: false, error: "acks must be an object." }, 400);

  // The review is found with Alex's JWT, so it is his and the link is a review link.
  const preview = await call("switchboard_run_preview", { p_token: token });
  if (preview.error) return refusal(preview.error);
  const p = preview.data as Record<string, unknown>;
  const review = isObject(p.review) ? p.review : null;
  if (!review) return reply({ ok: false, error: "this is not a code review link." }, 400);
  // A voided link (a correction) or one for an older version answers nothing.
  const link = isObject(p.link) ? p.link : {};
  if (link.voided_at || link.current === false) {
    return reply({ ok: false, error: "this review link is no longer current (the request was corrected); reload it." }, 409);
  }
  if (review.status === "superseded") {
    return reply({ ok: false, error: "The code has changed since this review. A new review comes after the next rehearsal." }, 409);
  }
  if (review.status !== "open") return reply({ ok: false, error: `this review was already answered (${review.status}).` }, 409);

  const forYou = Array.isArray((review.findings as Record<string, unknown> | undefined)?.for_you)
    ? ((review.findings as Record<string, unknown>).for_you as Record<string, unknown>[]).map((f) => String(f?.id)) : [];
  // Only acknowledgements of this review's own findings, each with a one-line note of at most 200 characters.
  const acks: Record<string, unknown> = {};
  for (const [id, v] of Object.entries((body.acks as Record<string, unknown> | undefined) ?? {})) {
    if (!forYou.includes(id)) return reply({ ok: false, error: `acks: ${id} is not one of this review's findings.` }, 400);
    const note = isObject(v) && typeof v.note === "string" ? lineText(v.note) : "";
    acks[id] = { note };
  }
  if (answer === "reviewed") {
    const missing = forYou.filter((id) => !acks[id]);
    if (missing.length) return reply({ ok: false, error: `acknowledge every "For you" finding first (${missing.join(", ")}).` }, 409);
    // "I reviewed this code" needs the desktop ready, as Approve does (4.3a).
    const d = desktopOf(body.desktop);
    if (!d || d.answer !== "running" || d.panel !== true || d.helper !== true) {
      return reply({ ok: false, error: "the desktop is not ready (panel and helper running). Nothing was sent." }, 409);
    }
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const status = answer === "question" ? "open" : answer;
  const done = await deps.answerReview(String(review.id), { status, acks, answer: { kind: answer, text, at } });
  if (!done) return reply({ ok: false, error: "this review changed while you answered; reload it." }, 409);
  const linkId = String(p.link_id);
  const simulated = simulationOf(p);
  const rest = answer === "reviewed" ? ANSWER_WORDS[answer] : `${ANSWER_WORDS[answer]}: ${lineText(text)}`;
  return reply({ ok: true, link_id: linkId, review_id: review.id, status, simulated, line: resultLine("review", linkId, rest, simulated) });
}

// ---------------------------------------------------------------------------

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!USER_ROUTES.has(route)) return json({ ok: false, error: "not found." }, 404);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed; use POST." }, 405, true);
  return handleUser(route, req, deps);
}
