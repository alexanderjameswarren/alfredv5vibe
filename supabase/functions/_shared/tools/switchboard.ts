// ============================================================================
// supabase/functions/_shared/tools/switchboard.ts
//
// The SQL approval queue, from Claude's side. Spec: docs/technical-spec-switchboard2-h8r.md §8.1.
//
//   get_switchboard_run     tier 1  an action (with its full SQL) and a run
//   get_claim_state         tier 1  each repo's claims and live blocks, as of its last claim change (§11.8)
//   issue_switchboard_link  tier 2  issue the approval link for the SQL Claude reviewed
//   get_sql_read            tier 1  one read-only query, as claude_reader (§8.2)
//   queue_switchboard_git   tier 2  queue a git action and issue its link (§11)
//   queue_switchboard_sf_check  tier 2  queue a read-only sandbox check and issue its link (§11.4)
//   queue_switchboard_sb_setup  tier 2  queue sb client start or org add answers and issue its link (§11.5)
//   queue_switchboard_sf_read   tier 2  queue one Salesforce read and issue its link (§10)
//   get_switchboard_sf_result   tier 1  take a Salesforce read's rows, once (§10)
//   queue_switchboard_sf_dataop tier 2  queue a production data run and issue its link (dataops_alfred-d4x)
//   queue_switchboard_sf_datawrite tier 2  queue a Data run v2 write link and issue it (dataop_write-j5w)
//
// Database access ONLY through ctx.db, except get_sql_read's query itself: see readerSeam.
// ============================================================================

import { defineTool } from "../platform.ts";
import { dbError, fail } from "./claude-notifications.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Named columns: link_hash is a secret column and must never be selected.
const ACTION_COLUMNS = "id, kind, project_code, status, headline, fingerprint, payload, chat_url, needs_click, " +
  "link_expires_at, link_used_at, created_by, created_at, updated_at";
const RUN_COLUMNS = "id, action_id, mode, summary, result, result_pruned_at, started_at, finished_at";
// switchboard_issue_link's own refusals: no user, no such action, not issuable or another link live for the project.
const REFUSALS = new Set(["28000", "P0002", "55000"]);

function requireUuid(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v.trim())) throw fail(tool, `\`${name}\` must be a UUID.`);
  return v.trim();
}

export const getSwitchboardRunTool = defineTool({
  name: "get_switchboard_run",
  tier: 1,
  tables: { reads: ["switchboard_actions", "switchboard_runs"], writes: [] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_switchboard_run";
    const given = [args.action_id, args.run_id, args.project_code].filter((v) => v != null).length;
    if (given !== 1) throw fail(tool, "pass exactly one of `action_id`, `run_id` or `project_code`.");

    const readAction = async (id: string) => {
      const { data, error } = await ctx.db.from("switchboard_actions").select(ACTION_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(tool, "reading the action", error);
      if (!data) throw fail(tool, `no such action: ${id}.`);
      return data as unknown as Record<string, unknown>;
    };
    const latestRun = async (id: string) => {
      const { data: run, error } = await ctx.db.from("switchboard_runs").select(RUN_COLUMNS).eq("action_id", id)
        .order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw dbError(tool, "reading the latest run", error);
      return run ?? null;
    };

    if (args.project_code != null) {
      const code = typeof args.project_code === "string" ? args.project_code.trim() : "";
      if (!PROJECT_CODE.test(code)) throw fail(tool, "`project_code` must be a project code such as switchboard2-h8r.");
      const { data, error } = await ctx.db.from("switchboard_actions").select(ACTION_COLUMNS).eq("project_code", code)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw dbError(tool, "reading the latest action", error);
      if (!data) throw fail(tool, `no action for ${code}.`);
      const action = data as unknown as Record<string, unknown>;
      return { action, run: await latestRun(action.id as string) };
    }

    if (args.run_id != null) {
      const id = requireUuid(tool, "run_id", args.run_id);
      const { data: run, error } = await ctx.db.from("switchboard_runs").select(RUN_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(tool, "reading the run", error);
      if (!run) throw fail(tool, `no such run: ${id}.`);
      return { action: await readAction((run as Record<string, unknown>).action_id as string), run };
    }

    const id = requireUuid(tool, "action_id", args.action_id);
    const action = await readAction(id);
    return { action, run: await latestRun(id) };
  },
});

// ---------------------------------------------------------------------------
// get_claim_state (s87e, spec §11.8): each repo's claims as of its last claim change
// ---------------------------------------------------------------------------

const CLAIM_STATE_COLUMNS = "repo, claims, blocks, posted_at, source_host";
const MAX_REPOS = 50;
type HeldClaim = { item: string; owner: string; kind: string; claimed_at: string };
type LiveBlock = { waiter: string; holder: string; item: string; since: string };

/** The repo's last folder name: C:\Users\Alex\projects\alfred-v5 -> alfred-v5. */
const repoName = (repo: string) => repo.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? repo;

/** One row, filtered to a project code if given, with the claims grouped by owner. */
export function shapeClaimState(row: Record<string, unknown>, code: string | null) {
  const claims = ((row.claims ?? []) as HeldClaim[]).filter((c) => !code || c.owner === code);
  const blocks = ((row.blocks ?? []) as LiveBlock[]).filter((b) => !code || b.waiter === code || b.holder === code);
  const holders: Record<string, { item: string; kind: string; claimed_at: string }[]> = {};
  for (const c of claims) (holders[c.owner] ??= []).push({ item: c.item, kind: c.kind, claimed_at: c.claimed_at });
  return { repo: row.repo, name: repoName(String(row.repo)), posted_at: row.posted_at, source_host: row.source_host ?? null, holders, blocks };
}

export const getClaimStateTool = defineTool({
  name: "get_claim_state",
  tier: 1,
  tables: { reads: ["switchboard_claim_state"], writes: [] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_claim_state";
    const repo = typeof args.repo === "string" ? args.repo.trim() : "";
    if (args.repo != null && (!repo || repo.length > 300)) throw fail(tool, "`repo` must be a repos.json key or its last folder name, such as alfred-v5.");
    const code = typeof args.project_code === "string" ? args.project_code.trim() : "";
    if (args.project_code != null && !PROJECT_CODE.test(code)) throw fail(tool, "`project_code` must be a project code such as switchboard2-h8r.");

    const { data, error } = await ctx.db.from("switchboard_claim_state").select(CLAIM_STATE_COLUMNS)
      .order("repo", { ascending: true }).limit(MAX_REPOS);
    if (error) throw dbError(tool, "reading the claim state", error);
    const want = repo.toLowerCase();
    const rows = ((data ?? []) as Record<string, unknown>[]).filter((r) => {
      if (!repo) return true;
      const key = String(r.repo).toLowerCase();
      return /[\\/]/.test(want) ? key.replace(/[\\/]+$/, "") === want.replace(/[\\/]+$/, "") : repoName(key) === want;
    });
    return { repos: rows.map((r) => shapeClaimState(r, code || null)) };
  },
});

export const issueSwitchboardLinkTool = defineTool({
  name: "issue_switchboard_link",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "issue_switchboard_link";
    const actionId = requireUuid(tool, "action_id", args.action_id);
    if (typeof args.fingerprint !== "string" || !args.fingerprint.trim()) {
      throw fail(tool, "`fingerprint` is required: the fingerprint get_switchboard_run showed for the SQL you reviewed.");
    }
    const { data: action, error: readError } = await ctx.db.from("switchboard_actions").select("fingerprint")
      .eq("id", actionId).maybeSingle();
    if (readError) throw dbError(tool, "reading the action", readError);
    if (!action) throw fail(tool, `no such action: ${actionId}.`);
    if ((action as Record<string, unknown>).fingerprint !== args.fingerprint.trim()) {
      throw fail(tool, "refused: the fingerprint does not match this action. Read it again with get_switchboard_run and review that SQL.");
    }
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `refused: ${error.message}`);
      throw dbError(tool, "issuing the link", error);
    }
    return data;
  },
});

// ---------------------------------------------------------------------------
// queue_switchboard_git (§11): the payload the helper accepts (switchboard helper/lib/core.mjs), and nothing else.
// The helper still checks the checkout (main or worktree) and refuses what this cannot know.
// ---------------------------------------------------------------------------

const GIT_KEYS: Record<string, string[]> = {
  gitcom: ["command", "message", "include_unclaimed"],
  gitsync: ["command", "then_send"],
  // sb3 E2 (r6): client and lane register the project; main: true binds main instead of making a worktree.
  gitnewtree: ["command", "install", "repo", "client", "lane", "main"],
  gitpush: ["command", "mode", "finish", "paths", "all", "db", "message", "include_unclaimed", "then_send", "no_prod_deploy"],
};

/**
 * s90d: a chain's run tag, as 234's check holds it: lowercase, at most 40 characters, the action's own project code
 * and "-s", then digits, optional letters, "-" and 4 characters. Null when it fits, else why not.
 */
export function chainTagProblem(tag: unknown, code: string): string | null {
  if (typeof tag !== "string" || !tag) return "`then_send` must be a run tag, such as switchboard2-h8r-s90e-ab12.";
  if (tag.length > 40) return `\`then_send\` ${tag} is over 40 characters, so it can't be chained; use a Send link instead.`;
  if (!/^[a-z0-9_-]+$/.test(tag)) return `\`then_send\` ${JSON.stringify(tag)} must be lowercase letters, digits, _ and - only.`;
  if (!tag.startsWith(`${code}-s`)) {
    return `\`then_send\` ${tag} is not a run tag of ${code}: a chain only sends into the window it ran in.`;
  }
  if (!/^[0-9]+[a-z]*-[a-z0-9]{4}$/.test(tag.slice(code.length + 2))) {
    return `\`then_send\` ${tag} is not a run tag: after ${code}-s it needs the step's digits, any letters, then - and 4 characters.`;
  }
  return null;
}
const PROJECT_CODE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const CHAT_URL = /^https:\/\/claude\.ai\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** A gitnewtree's repo, as the database check holds it: C:\... with no trailing backslash; ".." is refused separately. */
export const GIT_REPO = /^[A-Za-z]:(\\[^\\/:*?"<>|\x00-\x1f]+)+$/;
/** A gitnewtree's client slug and lanes, as the helper holds them (helper/lib/core.mjs, START_LANES). */
const GIT_CLIENT = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const START_LANES = ["Fast track", "Main", "Side road", "Country road"];

/** A repo-relative path: segments may start with a dot (.claude), never . or .., no leading -, empty segment or \ or :. */
export function usablePath(x: unknown): boolean {
  if (typeof x !== "string" || !x || x.startsWith("-")) return false;
  const segs = (x.endsWith("/") ? x.slice(0, -1) : x).split("/");
  return segs.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
}

/** The payload to store, or a refusal reason. args minus project_code and chat_url is the payload. */
export function gitPayload(args: Record<string, unknown>): { payload: Record<string, unknown> } | { refused: string } {
  const r = (refused: string) => ({ refused });
  const { project_code: _c, chat_url: _u, ...p } = args;
  const command = p.command;
  if (typeof command !== "string" || !Object.hasOwn(GIT_KEYS, command)) {
    return r(`\`command\` must be gitcom, gitsync, gitnewtree or gitpush, not ${JSON.stringify(command ?? null)}.`);
  }
  if (p.then_send !== undefined && p.then_send !== null && !GIT_KEYS[command].includes("then_send")) {
    return r(`${command} can't chain a prompt: only gitsync and gitpush checkpoint or push take \`then_send\`.`);
  }
  const extra = Object.keys(p).filter((k) => !GIT_KEYS[command].includes(k));
  if (extra.length) {
    if (extra.includes("no_prod_deploy")) {
      return r(`\`no_prod_deploy\` is only for gitpush finish, not ${command}: only a Finish checks for a production deploy.`);
    }
    return r(`${command} does not take ${extra.join(", ")}.`);
  }
  for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === null) delete p[k];
  // w3k s9: a Salesforce repo's Finish refuses with no production deploy recorded unless this says none went out.
  // The helper refuses it outside a Salesforce repo; here only true, and only on a Finish.
  if (p.no_prod_deploy !== undefined) {
    if (p.no_prod_deploy !== true) return r("`no_prod_deploy` can only be true; leave it out otherwise.");
    if (p.mode !== "finish") {
      return r(`\`no_prod_deploy\` is only for gitpush finish, not ${p.mode ?? "(no mode)"}: only a Finish checks for a production deploy.`);
    }
  }

  if (p.message !== undefined) {
    const m = p.message;
    if (typeof m !== "string" || !m.trim() || m.length > 200 || /[\r\n"]/.test(m) || m.trim().startsWith("-")) {
      return r("`message` must be one line of at most 200 characters, with no double quote, not starting with -.");
    }
    p.message = m.trim();
  }
  if (p.include_unclaimed !== undefined && !["all", "none"].includes(p.include_unclaimed as string)) {
    return r("`include_unclaimed` must be all or none.");
  }
  if (command === "gitnewtree" && p.install !== undefined && typeof p.install !== "boolean") {
    return r("`install` must be true or false.");
  }
  // sb3 E2 (r6): as the helper refuses them (helper/lib/core.mjs, gitnewtree), so a bad link is never issued.
  if (p.client !== undefined && (typeof p.client !== "string" || !GIT_CLIENT.test(p.client))) {
    return r(`client must be a client slug (lowercase letters, digits and hyphens), not ${JSON.stringify(p.client)} — ask for a new link with the client's slug.`);
  }
  if (p.lane !== undefined && !START_LANES.includes(p.lane as string)) {
    return r(`lane must be one of ${START_LANES.join(", ")}, not ${JSON.stringify(p.lane)} — ask for a new link with one of them.`);
  }
  if (p.main !== undefined && p.main !== true) return r("main takes only true; leave it out for a worktree.");
  if (p.repo !== undefined) {
    const repo = typeof p.repo === "string" ? p.repo.trim() : p.repo;
    if (typeof repo !== "string" || repo.length > 240 || !GIT_REPO.test(repo) || repo.includes("..")) {
      return r("`repo` must be the repo's absolute path, such as C:\\Users\\Alex\\projects\\alfred-v5, with no trailing backslash.");
    }
    p.repo = repo;
  }
  if (command === "gitpush") {
    const mode = p.mode;
    if (!["push", "checkpoint", "finish"].includes(mode as string)) return r("gitpush needs `mode`: push, checkpoint or finish.");
    if (mode === "finish") {
      if (!["phase", "project-done"].includes(p.finish as string)) {
        return r("a Finish needs `finish`: phase (this worktree only) or project-done (also moves the docs to history).");
      }
    } else if (p.finish !== undefined) return r(`\`finish\` is only for a Finish, not ${mode}.`);
    if (mode === "checkpoint") {
      const paths = p.paths;
      if (p.all === true && paths === undefined) { /* every uncommitted path */ }
      else if (Array.isArray(paths) && paths.length && p.all === undefined) {
        const bad = paths.filter((x) => !usablePath(x));
        if (bad.length) return r(`not a usable path: ${bad.map(String).join(", ")}.`);
      } else return r("a Checkpoint needs `paths` (a list) or `all: true`, not both.");
      if (p.db !== undefined && !["release", "keep"].includes(p.db as string)) return r("`db` must be release or keep.");
    } else if (p.paths !== undefined || p.all !== undefined || p.db !== undefined) {
      return r(`\`paths\`, \`all\` and \`db\` are only for a Checkpoint, not ${mode}.`);
    }
    if (mode === "checkpoint" && p.include_unclaimed !== undefined) return r("`include_unclaimed` is only for main.");
  }
  // s90d: the chained link. Stored as then: {send}, as 234 holds it.
  if (p.then_send !== undefined) {
    if (command === "gitpush" && p.mode === "finish") return r("a Finish can't chain a prompt: the worktree is gone afterwards.");
    const code = typeof _c === "string" ? _c.trim() : "";
    const problem = chainTagProblem(p.then_send, code);
    if (problem) return r(problem);
    p.then = { send: p.then_send };
    delete p.then_send;
  }
  return { payload: p };
}

/** What the click will do, in the queue's capitals; a chain adds what follows (s90d). */
export function gitHeadline(code: string, p: Record<string, unknown>): string {
  const send = (p.then as { send?: string } | undefined)?.send;
  return send ? `${gitCommandHeadline(code, p)}, THEN SENDS PROMPT ${send} AT YOUR TAP` : gitCommandHeadline(code, p);
}

function gitCommandHeadline(code: string, p: Record<string, unknown>): string {
  switch (p.command) {
    case "gitcom":
      return `GITCOM ${code}: COMMITS ITS CLAIMED FILES${p.include_unclaimed === "all" ? " AND EVERY UNCLAIMED CHANGE" : ""}`;
    case "gitsync":
      return `GITSYNC ${code}: MERGES MAIN INTO THE WORKTREE`;
    case "gitnewtree":
      return `GITNEWTREE ${code}: ${p.main === true ? "BINDS MAIN TO THE PROJECT" : "CREATES A WORKTREE FROM ORIGIN/MAIN"}` +
        (p.repo ? ` IN ${(p.repo as string).toUpperCase()}` : "");
    default: {
      if (p.mode === "push") return `GITPUSH PUSH ${code}: COMMITS AND PUSHES MAIN`;
      if (p.mode === "checkpoint") {
        const what = p.all ? "EVERY UNCOMMITTED PATH" : `${(p.paths as string[]).length} PATH${(p.paths as string[]).length === 1 ? "" : "S"}`;
        return `GITPUSH CHECKPOINT ${code}: MERGES ${what} INTO MAIN, PUSHES${p.db === "keep" ? ", KEEPS THE DB CLAIMS" : ""}`;
      }
      return `GITPUSH FINISH ${code}: MERGES INTO MAIN, PUSHES, REMOVES THE WORKTREE` +
        (p.finish === "project-done" ? ", MOVES THE DOCS TO HISTORY" : "") +
        (p.no_prod_deploy === true ? `; APPROVING CONFIRMS NOTHING FROM ${code.toUpperCase()} WENT TO PRODUCTION` : "");
    }
  }
}

export const queueSwitchboardGitTool = defineTool({
  name: "queue_switchboard_git",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_git";
    const code = typeof args.project_code === "string" ? args.project_code.trim() : "";
    if (!PROJECT_CODE.test(code)) throw fail(tool, "`project_code` must be a project code such as switchboard2-h8r.");
    // Optional: the extension remembers the chat. Only a claude.ai chat address is kept; anything else is dropped.
    const chatUrl = typeof args.chat_url === "string" && CHAT_URL.test(args.chat_url.trim()) ? args.chat_url.trim() : null;
    const checked = gitPayload(args);
    if ("refused" in checked) throw fail(tool, `refused: ${checked.refused}`);
    const headline = gitHeadline(code, checked.payload);

    // Authenticated cannot insert into switchboard_actions (189): the queue function does it as the caller.
    const { data: queued, error: queueError } = await ctx.db.rpc("switchboard_queue_git", {
      p_project_code: code, p_payload: checked.payload, p_headline: headline, p_chat_url: chatUrl,
    });
    if (queueError) {
      if (REFUSALS.has(queueError.code ?? "") || queueError.code === "23514") throw fail(tool, `refused: ${queueError.message}`);
      throw dbError(tool, "queueing the git action", queueError);
    }
    const actionId = (queued as Record<string, unknown> | null)?.action_id as string | undefined;
    if (!actionId) throw fail(tool, "the queue returned no action id.");

    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw dbError(tool, `issuing the link for ${actionId}`, error);
    }
    const send = (checked.payload.then as { send?: string } | undefined)?.send;
    return {
      ...(data as Record<string, unknown>), action_id: actionId, payload: checked.payload,
      next: send
        ? `Give Alex the url; it replaces both the git link and the Send link, and your reply still ends with the ${send} prompt block. ` +
          `Once he approves and taps the tile, the result arrives in this chat as "git ${actionId} done; prompt sent", ` +
          `"git ${actionId} done; send not run: <reason>" or "git ${actionId} failed; send not run".`
        : "Give Alex the url. Once he approves, the result line (git <action id> done or failed) arrives in this chat " +
          "by itself when the command finishes; he can also say \"check the git run\" (get_switchboard_run).",
    };
  },
});

// ---------------------------------------------------------------------------
// queue_switchboard_sf_check (§11.4) and queue_switchboard_sb_setup (§11.5): the payloads the helper accepts
// (switchboard helper/lib/core.mjs planSfCheck and planSbSetup), checked here first, then by 218's constraints.
// ---------------------------------------------------------------------------

export const SF_CHECKS = ["org-verify", "limits", "metadata-types", "metadata", "retrieve-preview", "deploy-preview"];
const SF_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const METADATA_TYPE = /^[A-Za-z]{1,80}$/;
const SB_KEYS = ["command", "client", "repo", "adopt", "from_sandbox", "folder", "project", "name", "sandboxes", "integration_ok", "orgs"];
// Strictly inside C:\Users\Alex\projects\, as the payload check in the database holds it; ".." is refused separately.
export const SB_FOLDER = /^c:\\users\\alex\\projects(\\[^\\/:*?"<>|\x00-\x1f]+)+$/i;
const SB_ORG_KEYS = ["alias", "type", "level", "login", "cli_deploy", "shared"];
const SB_TYPES = ["developer", "developer_pro", "partial", "full"];
// Alex's D2: none of these is ever set by link. Named so the refusal says why, not just "unknown key".
const TERMINAL_ONLY = /^(contract|contract_ok|contract-ok|contract_allows_claude|contractallowsclaude|production_allowed|productionallowed|ids|data)$/i;
const CLIENT = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const plainArg = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 300 && !/^[-\s]|[\r\n"]/.test(v);
const isBool = (v: unknown) => typeof v === "boolean";

/** args minus project_code and chat_url, with undefined and null dropped. */
function payloadOf(args: Record<string, unknown>): Record<string, unknown> {
  const { project_code: _c, chat_url: _u, ...p } = args;
  for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === null) delete p[k];
  return p;
}

export function sfCheckPayload(args: Record<string, unknown>): { payload: Record<string, unknown> } | { refused: string } {
  const p = payloadOf(args);
  const extra = Object.keys(p).filter((k) => !["check", "alias", "metadata_type"].includes(k));
  if (extra.length) return { refused: `an sf_check does not take ${extra.join(", ")}.` };
  if (!SF_CHECKS.includes(p.check as string)) return { refused: `\`check\` must be one of ${SF_CHECKS.join(", ")}.` };
  if (typeof p.alias !== "string" || !SF_ALIAS.test(p.alias)) return { refused: "`alias` must be an org alias (letters, digits, _ . -)." };
  if (p.check === "metadata") {
    if (typeof p.metadata_type !== "string" || !METADATA_TYPE.test(p.metadata_type)) return { refused: "metadata needs `metadata_type`, letters only, such as ApexClass." };
  } else if (p.metadata_type !== undefined) return { refused: `\`metadata_type\` is only for metadata, not ${p.check}.` };
  return { payload: p };
}

// s86aa: every answer sb asks for by link (switchboard sb/lib/client.mjs startClient, org.mjs addOrg). sb refuses the
// first question it meets, so a missing one is refused here, all at once, before anything is queued.
const SB_START_NEEDS: [string, string][] = [
  ["sandboxes", "which sandboxes checks may run on: all, or a list of aliases"],
  ["integration_ok", "whether the client allows an integration user (true or false)"],
  ["name", "the client's display name on the panel, at most 60 characters"],
];
const SB_ORG_NEEDS: [string, string][] = [
  ["alias", "the org's alias"],
  ["type", "the sandbox type: developer, developer_pro, partial or full"],
  ["level", "the access level: objects or metadata"],
  ["login", "how sf logs in: integration or admin"],
  ["cli_deploy", "whether the CLI may deploy to it (true or false)"],
  ["shared", "whether other developers use this org (true or false)"],
];

/** Every setting sb would ask for and the payload leaves out, as "key: what it is" lines. */
export function sbSetupMissing(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (p.client === undefined) out.push("client: the client name, lower case letters, digits, _ and -");
  if (p.command === "client start") {
    if (!["repo", "adopt", "from_sandbox"].some((k) => p[k] !== undefined)) {
      out.push("repo, adopt or from_sandbox: where the code comes from (a git URL, an existing checkout, or an alias to retrieve from)");
    }
    if (p.from_sandbox !== undefined && p.folder === undefined) out.push("folder: the empty folder to write, inside C:\\Users\\Alex\\projects\\");
    for (const [k, d] of SB_START_NEEDS) if (p[k] === undefined) out.push(`${k}: ${d}`);
  }
  if (p.orgs === undefined) out.push(`orgs: ${p.command === "org add" ? "the one org" : "1 to 10 orgs"}, each with ${SB_ORG_NEEDS.map(([k]) => k).join(", ")}`);
  else if (Array.isArray(p.orgs)) {
    p.orgs.forEach((o, i) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) return;
      const org = o as Record<string, unknown>;
      const who = typeof org.alias === "string" ? org.alias : `org ${i + 1}`;
      for (const [k, d] of SB_ORG_NEEDS) if (org[k] === undefined) out.push(`${who} ${k}: ${d}`);
    });
  }
  return out;
}

export function sbSetupPayload(args: Record<string, unknown>): { payload: Record<string, unknown> } | { refused: string } {
  const r = (refused: string) => ({ refused });
  const p = payloadOf(args);
  const terminal = Object.keys(p).filter((k) => TERMINAL_ONLY.test(k));
  if (terminal.length) return r(`${terminal.join(", ")} is never set by link; it stays with Alex in the terminal (sb org add or sb org set).`);
  const extra = Object.keys(p).filter((k) => !SB_KEYS.includes(k));
  if (extra.length) return r(`an sb setup does not take ${extra.join(", ")}.`);
  if (!["client start", "org add"].includes(p.command as string)) return r("`command` must be client start or org add.");
  const missing = sbSetupMissing(p);
  if (missing.length) {
    return r(`${missing.length} setting${missing.length === 1 ? "" : "s"} missing; sb by link asks no questions, so ask Alex for ` +
      `${missing.length === 1 ? "it" : "all of them at once"}, then queue again. Nothing was queued.\n${missing.map((m) => `- ${m}`).join("\n")}`);
  }
  if (typeof p.client !== "string" || !CLIENT.test(p.client)) return r("`client` must be a client name: lower case letters, digits, _ and -.");
  if (!Array.isArray(p.orgs) || p.orgs.length < 1 || p.orgs.length > 10) return r("`orgs` must list 1 to 10 orgs.");
  for (const o of p.orgs as Record<string, unknown>[]) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return r("each org must be an object.");
    const name = typeof o.alias === "string" ? o.alias : "an org";
    const term = Object.keys(o).filter((k) => TERMINAL_ONLY.test(k));
    if (term.length) return r(`${name}: ${term.join(", ")} is never set by link; it stays with Alex in the terminal.`);
    const bad = Object.keys(o).filter((k) => !SB_ORG_KEYS.includes(k));
    if (bad.length) return r(`${name}: an org does not take ${bad.join(", ")} by link.`);
    if (typeof o.alias !== "string" || !SF_ALIAS.test(o.alias)) return r(`${JSON.stringify(o.alias ?? null)} is not an org alias.`);
    if (o.type === "production") return r(`${name}: production is never set up by link; Alex adds it in the terminal.`);
    if (!SB_TYPES.includes(o.type as string)) return r(`${name}: \`type\` must be a sandbox: ${SB_TYPES.join(", ")}.`);
    if (!["objects", "metadata"].includes(o.level as string)) return r(`${name}: \`level\` by link is objects or metadata only; ids and data stay in the terminal.`);
    if (o.login !== undefined && !["integration", "admin"].includes(o.login as string)) return r(`${name}: \`login\` must be integration or admin.`);
    for (const k of ["cli_deploy", "shared"]) if (o[k] !== undefined && !isBool(o[k])) return r(`${name}: \`${k}\` must be true or false.`);
  }
  const aliases = (p.orgs as { alias: string }[]).map((o) => o.alias);
  if (new Set(aliases).size !== aliases.length) return r("an alias is listed twice.");
  if (p.sandboxes !== undefined && p.sandboxes !== "all" &&
      !(Array.isArray(p.sandboxes) && p.sandboxes.length && p.sandboxes.every((a) => typeof a === "string" && SF_ALIAS.test(a)))) {
    return r("`sandboxes` must be all or a list of aliases.");
  }
  if (p.integration_ok !== undefined && !isBool(p.integration_ok)) return r("`integration_ok` must be true or false.");
  if (p.project !== undefined && (typeof p.project !== "string" || !PROJECT_CODE.test(p.project))) return r("`project` must be a project code.");
  if (p.command === "org add") {
    const notHere = ["repo", "adopt", "from_sandbox", "folder", "name"].filter((k) => p[k] !== undefined);
    if (notHere.length) return r(`org add does not take ${notHere.join(", ")}.`);
    if (aliases.length !== 1) return r("org add by link sets up exactly one org; queue one action per org.");
  } else {
    const sources = ["repo", "adopt", "from_sandbox"].filter((k) => p[k] !== undefined);
    if (sources.length !== 1) return r("client start needs exactly one of `repo`, `adopt` or `from_sandbox`.");
    const src = sources[0];
    if (src === "from_sandbox" ? typeof p[src] !== "string" || !SF_ALIAS.test(p[src] as string) : !plainArg(p[src])) {
      return r(`\`${src}\` is not usable: one line, no double quote, not starting with - or a space.`);
    }
    if (src !== "from_sandbox" && p.folder !== undefined) return r(`\`folder\` is only for from_sandbox; ${src} has its own folder.`);
    if (src === "from_sandbox" && (typeof p.folder !== "string" || p.folder.length > 240 || !SB_FOLDER.test(p.folder) || p.folder.includes(".."))) {
      return r("from_sandbox needs `folder`: Alex's answer, a full path inside C:\\Users\\Alex\\projects\\ (not that folder itself), no .., no trailing \\.");
    }
    if (p.name !== undefined && (!plainArg(p.name) || (p.name as string).length > 60)) {
      return r("`name` must be one line of at most 60 characters, with no double quote.");
    }
  }
  return { payload: p };
}

export function sfCheckHeadline(code: string | null, p: Record<string, unknown>): string {
  return `SF CHECK${code ? ` ${code}` : ""}: ${String(p.check).toUpperCase()}${p.metadata_type ? ` ${p.metadata_type}` : ""} ON SANDBOX ${p.alias}, READ ONLY`;
}

export function sbSetupHeadline(p: Record<string, unknown>): string {
  const orgs = p.orgs as { alias: string }[];
  if (p.command === "org add") return `SB ORG ADD ${p.client}: ADDS SANDBOX ${orgs[0].alias} TO ORGS.JSON`;
  return `SB CLIENT START ${p.client}: SETS UP THE CLIENT WITH ${orgs.length} SANDBOX${orgs.length === 1 ? "" : "ES"}, WRITES SWITCHBOARD CONFIG`;
}

/** switchboard_queue_helper as the signed-in caller, and the action id. A null code: the database derives one. */
async function queueHelper(tool: string, ctx: { db: any }, kind: string, code: string | null, payload: Record<string, unknown>,
                           headline: string, chatUrl: string | null): Promise<string> {
  const { data, error } = await ctx.db.rpc("switchboard_queue_helper", {
    p_kind: kind, p_project_code: code, p_payload: payload, p_headline: headline, p_chat_url: chatUrl,
  });
  if (error) {
    if (REFUSALS.has(error.code ?? "") || error.code === "23514") throw fail(tool, `refused: ${error.message}`);
    throw dbError(tool, `queueing the ${kind} action`, error);
  }
  const id = (data as Record<string, unknown> | null)?.action_id as string | undefined;
  if (!id) throw fail(tool, "the queue returned no action id.");
  return id;
}

const chatOf = (args: Record<string, unknown>) =>
  typeof args.chat_url === "string" && CHAT_URL.test(args.chat_url.trim()) ? args.chat_url.trim() : null;

export const queueSwitchboardSfCheckTool = defineTool({
  name: "queue_switchboard_sf_check",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_sf_check";
    // Optional: the helper finds the repo from the alias. Without one, the row's code is sf-<alias>.
    const given = typeof args.project_code === "string" ? args.project_code.trim() : "";
    if (given && !PROJECT_CODE.test(given)) throw fail(tool, "`project_code` must be a project code such as ti-x1, or left out.");
    const code = given || null;
    const chatUrl = chatOf(args);
    const checked = sfCheckPayload(args);
    if ("refused" in checked) throw fail(tool, `refused: ${checked.refused}`);
    // s86pa: a click by link, as sb_setup (needs_click is true for sf_check since that migration).
    const actionId = await queueHelper(tool, ctx, "sf_check", code, checked.payload, sfCheckHeadline(code, checked.payload), chatUrl);
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw dbError(tool, `issuing the link for ${actionId}`, error);
    }
    return {
      ...(data as Record<string, unknown>), action_id: actionId, payload: checked.payload,
      next: "Give Alex the url whole; it lasts 30 minutes. Nothing runs until he clicks Approve; then the desktop helper " +
        `runs the check. The result line (sf ${actionId} done or failed) arrives in this chat by itself; read it with get_switchboard_run.`,
    };
  },
});

export const queueSwitchboardSbSetupTool = defineTool({
  name: "queue_switchboard_sb_setup",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_sb_setup";
    const checked = sbSetupPayload(args);
    if ("refused" in checked) throw fail(tool, `refused: ${checked.refused}`);
    // Setup is per client: no project code, so the row's code is sb-<client> and one link is live per client.
    const actionId = await queueHelper(tool, ctx, "sb_setup", null, checked.payload, sbSetupHeadline(checked.payload), chatOf(args));
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw dbError(tool, `issuing the link for ${actionId}`, error);
    }
    return {
      ...(data as Record<string, unknown>), action_id: actionId, payload: checked.payload,
      next: "Give Alex the url. The page lists every answer and the files it writes; his click is the yes. Once the " +
        `helper finishes, the result line (sb ${actionId} done or failed) arrives in this chat by itself; read it with get_switchboard_run.`,
    };
  },
});

// ---------------------------------------------------------------------------
// queue_switchboard_sf_read and get_switchboard_sf_result (§10, s89e). The payload as 233's check holds it, checked
// here first so a refusal says why; the helper checks it again against orgs.json and Salesforce.
// ---------------------------------------------------------------------------

export const SF_LEVELS = ["objects", "metadata", "ids", "data"];
const SF_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const SF_OPS = ["=", "!=", "<", "<=", ">", ">="];
const IDS_FIELDS = ["Id", "CreatedDate", "LastModifiedDate"];
const SF_READ_KEYS = ["alias", "production", "level", "object", "objects", "count", "fields", "limit", "filters"];
/** d4x: a metadata read may describe up to this many objects in one link, as the helper (salesforce/read/plan.mjs) allows. */
export const SF_OBJECTS_MAX = 20;
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

export function sfReadPayload(args: Record<string, unknown>): { payload: Record<string, unknown> } | { refused: string } {
  const r = (refused: string) => ({ refused });
  const p = payloadOf(args);
  const extra = Object.keys(p).filter((k) => !SF_READ_KEYS.includes(k));
  if (extra.length) {
    return r(`an sf_read does not take ${extra.join(", ")}.${extra.some((k) => /soql|query/i.test(k)) ? " Never SOQL text: name the object, fields and filters." : ""}`);
  }
  if (typeof p.alias !== "string" || !SF_ALIAS.test(p.alias)) return r("`alias` must be an org alias (letters, digits, _ . -).");
  if (!isBool(p.production)) return r("`production` must be true or false: whether the org is production. The helper refuses a wrong answer.");
  if (!SF_LEVELS.includes(p.level as string)) return r(`\`level\` must be one of ${SF_LEVELS.join(", ")}.`);
  const level = p.level as string;
  const has = (k: string) => p[k] !== undefined;
  if (level === "objects") {
    const not = ["object", "objects", "count", "fields", "limit", "filters"].filter(has);
    return not.length ? r(`objects lists the org's objects and takes no ${not.join(", ")}.`) : { payload: p };
  }
  // d4x: one production read link for every object a preflight needs.
  if (has("objects")) {
    if (level !== "metadata") return r("`objects` (a list) is for level metadata only; other levels take one `object`.");
    if (has("object")) return r("give `object` or `objects`, not both.");
    const list = p.objects;
    if (!Array.isArray(list) || list.length < 1 || list.length > SF_OBJECTS_MAX || !list.every((o) => typeof o === "string" && SF_NAME.test(o))) {
      return r(`\`objects\` must list 1 to ${SF_OBJECTS_MAX} API names (no dots).`);
    }
    if (new Set(list.map((o) => (o as string).toLowerCase())).size !== list.length) return r("an object is listed twice in `objects`.");
    const not = ["count", "fields", "limit", "filters"].filter(has);
    return not.length ? r(`metadata describes objects and takes no ${not.join(", ")}.`) : { payload: p };
  }
  if (typeof p.object !== "string" || !SF_NAME.test(p.object)) return r("`object` must be one API name, e.g. Contact or Donation__c (no dots).");
  if (level === "metadata") {
    const not = ["count", "fields", "limit", "filters"].filter(has);
    return not.length ? r(`metadata describes one object and takes no ${not.join(", ")}.`) : { payload: p };
  }
  if (has("count")) {
    if (p.count !== true) return r("`count` must be true, or left out.");
    if (has("fields") || has("limit")) return r("a count takes no fields or limit.");
  } else {
    if (!Array.isArray(p.fields) || p.fields.length < 1 || p.fields.length > 50 || !p.fields.every((f) => typeof f === "string" && SF_NAME.test(f))) {
      return r("`fields` must list 1 to 50 API names (no dots), or pass count: true.");
    }
    if (!Number.isInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 1000) return r("`limit` must be a whole number from 1 to 1000.");
  }
  if (has("filters")) {
    if (!Array.isArray(p.filters) || p.filters.length < 1 || p.filters.length > 10) return r("`filters` must list 1 to 10 filters, or be left out.");
    for (const f of p.filters as unknown[]) {
      const o = f as Record<string, unknown>;
      if (!o || typeof o !== "object" || Array.isArray(o)) return r("each filter must be {field, op, value}.");
      const bad = Object.keys(o).filter((k) => !["field", "op", "value"].includes(k));
      if (bad.length) return r(`a filter does not take ${bad.join(", ")}.`);
      if (typeof o.field !== "string" || !SF_NAME.test(o.field)) return r("a filter's `field` must be one API name (no dots).");
      if (!("value" in o)) return r(`the filter on ${o.field} needs a value.`);
      if (o.op === "in") {
        if (!Array.isArray(o.value) || o.value.length < 1 || o.value.length > 100 || !o.value.every(isScalar)) {
          return r(`in on ${o.field} needs a list of 1 to 100 plain values.`);
        }
      } else if (!SF_OPS.includes(o.op as string)) {
        return r(`a filter's \`op\` must be one of ${[...SF_OPS, "in"].join(" ")}.`);
      } else if (!isScalar(o.value)) {
        return r(`the filter on ${o.field} needs one plain value: text, a number, true, false or null.`);
      }
    }
  }
  // ids returns only the three fields. Filters may name any field: the helper (salesforce/read/plan.mjs) limits them
  // to the three unless the org's contractAllowsClaude is on, which only it knows (spec §7, switchboard_prod-w3k).
  if (level === "ids") {
    const other = ((p.fields as string[] | undefined) ?? []).filter((n) => !IDS_FIELDS.includes(n));
    if (other.length) return r(`ids returns only ${IDS_FIELDS.join(", ")}; ${[...new Set(other)].join(", ")} needs level data.`);
  }
  if (JSON.stringify(p).length > 8000) return r("the read is too long; trim the filters.");
  return { payload: p };
}

export function sfReadHeadline(p: Record<string, unknown>): string {
  const full = p.production === true && p.level === "data";
  const where = `${p.production === true ? "PRODUCTION" : "SANDBOX"} ${p.alias}`;
  const many = Array.isArray(p.objects) ? (p.objects as string[]) : null;
  const what = p.level === "objects" ? "THE OBJECT LIST"
    : many ? `THE DESCRIBE OF ${many.length} OBJECT${many.length === 1 ? "" : "S"}: ${many.slice(0, 5).join(", ")}${many.length > 5 ? ` AND ${many.length - 5} MORE` : ""}`
    : p.level === "metadata" ? `THE DESCRIBE OF ${p.object}`
    : p.count === true ? `A COUNT OF ${p.object}`
    : `${(p.fields as string[]).length} FIELD${(p.fields as string[]).length === 1 ? "" : "S"} OF ${p.object}, UP TO ${p.limit} ROWS`;
  return `${full ? "PRODUCTION FULL DATA: " : ""}SF READ ${String(p.level).toUpperCase()} ON ${where}: ${what}, READ ONLY`;
}

// The same numbers as get_sql_read's BUDGETS (below), counted from the Salesforce log.
const SF_READ_BUDGETS = [
  { limit: 20, seconds: 600, words: "10 minutes" },
  { limit: 200, seconds: 86400, words: "day" },
];

export const queueSwitchboardSfReadTool = defineTool({
  name: "queue_switchboard_sf_read",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings", "switchboard_sf_read_log"], writes: ["switchboard_actions", "switchboard_sf_read_log"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_sf_read";
    const p = payloadOf(args);
    // The log row for this attempt, from what was asked, kept within the log's own checks. Never rows.
    const logRow = (stage: "queued" | "refused", extra: Record<string, unknown>) => ({
      stage, org_alias: typeof p.alias === "string" && p.alias.trim() ? p.alias.trim().slice(0, 80) : "?",
      level: SF_LEVELS.includes(p.level as string) ? p.level : null,
      object: typeof p.object === "string" ? p.object.slice(0, 80) : null,
      // d4x O4: needs the migration's objects column, so this tool deploys after it.
      ...(Array.isArray(p.objects) ? { objects: p.objects.slice(0, SF_OBJECTS_MAX + 1) } : {}),
      fields: Array.isArray(p.fields) ? p.fields : null,
      filters: Array.isArray(p.filters) ? p.filters : null,
      ...extra,
    });
    const log = async (stage: "queued" | "refused", extra: Record<string, unknown>) => {
      const { error } = await ctx.db.from("switchboard_sf_read_log").insert(logRow(stage, extra));
      return error ? error.message ?? "the log write failed" : null;
    };
    const refuse = async (error: Error) => {
      await log("refused", { error: error.message.slice(0, 500) });
      return error;
    };

    const checked = sfReadPayload(args);
    if ("refused" in checked) throw await refuse(fail(tool, `refused: ${checked.refused}`));

    // Both fail closed, as get_sql_read's.
    const { data: settings, error: settingsError } = await ctx.db.from("switchboard_settings").select("sf_reads_enabled").maybeSingle();
    if (settingsError) throw await refuse(dbError(tool, "reading the kill switch", settingsError));
    if (!settings) throw await refuse(fail(tool, "refused: no settings row, so the kill switch can't be read."));
    if (!(settings as { sf_reads_enabled: boolean }).sf_reads_enabled) {
      throw await refuse(fail(tool, "refused: Salesforce reads are switched off (switchboard_settings.sf_reads_enabled)."));
    }
    // Counted from the log's queue attempts, refusals included; a read's ran or failed row isn't a second call.
    for (const b of SF_READ_BUDGETS) {
      const since = new Date(Date.now() - b.seconds * 1000).toISOString();
      const { count, error } = await ctx.db.from("switchboard_sf_read_log").select("id", { count: "exact", head: true })
        .in("stage", ["queued", "refused"]).gte("created_at", since);
      if (error) throw await refuse(dbError(tool, "reading the read budget", error));
      if ((count ?? 0) >= b.limit) {
        throw await refuse(fail(tool, `READ BUDGET EXCEEDED: ${count} Salesforce reads in the last ${b.words} (limit ${b.limit}). Do NOT retry. Stop and report to the user.`));
      }
    }

    const headline = sfReadHeadline(checked.payload);
    const actionId = await queueHelper(tool, ctx, "sf_read", null, checked.payload, headline, chatOf(args));
    const logError = await log("queued", { action_id: actionId });
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw dbError(tool, `issuing the link for ${actionId}`, error);
    }
    return {
      ...(data as Record<string, unknown>), action_id: actionId, headline, payload: checked.payload,
      ...(logError ? { log_error: logError } : {}),
      next: "Give Alex the url whole; it lasts 30 minutes. Nothing runs until he clicks Approve; then the desktop helper checks the org " +
        `against orgs.json and Salesforce and reads. The result line (sf ${actionId} done or failed) arrives in this chat by itself; ` +
        `then call get_switchboard_sf_result with this action_id, once: the rows come back once and are deleted, and are gone 10 minutes after the read.`,
    };
  },
});

// ---------------------------------------------------------------------------
// queue_switchboard_sf_dataop (dataops_alfred-d4x A1): the production data run, started only by Alex's click on its
// link (switchboard spec D1). The payload is the contract in docs/technical-spec-dataops_alfred-d4x.md, checked here
// first so a refusal says why, then by the database's switchboard_actions_sf_dataop_payload, then by the helper against
// the stamped plan. This tool queues and issues the link; nothing here can approve it.
// ---------------------------------------------------------------------------

const DATAOP_KEYS = ["alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const PLAN_PATH = /^[A-Za-z0-9_.-]+([\\/][A-Za-z0-9_.-]+)*\.json$/;
export const DATAOP_MAX_ROWS = 40;
const chars = (s: string) => [...s].length;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

export function sfDataopPayload(args: Record<string, unknown>): { payload: Record<string, unknown> } | { refused: string } {
  const r = (refused: string) => ({ refused });
  const p = payloadOf(args);
  const extra = Object.keys(p).filter((k) => !DATAOP_KEYS.includes(k));
  if (extra.length) {
    return r(`an sf_dataop does not take ${extra.join(", ")}. Pass sb's printed arguments exactly as they are; the Id list, SOQL and scripts never go in the link (the stamp covers them).`);
  }
  const missing = DATAOP_KEYS.filter((k) => k !== "rehearsal" && p[k] === undefined);
  if (missing.length) return r(`missing ${missing.join(", ")}: pass every argument sb printed.`);
  if (typeof p.alias !== "string" || !SF_ALIAS.test(p.alias)) return r("`alias` must be the production org's alias (letters, digits, _ . -).");
  if (typeof p.repo !== "string" || p.repo.length > 240 || !GIT_REPO.test(p.repo) || p.repo.includes("..")) {
    return r("`repo` must be the checkout's absolute path, e.g. C:\\Users\\Alex\\projects\\common-defense, with no ..");
  }
  if (typeof p.plan !== "string" || p.plan.length > 260 || !PLAN_PATH.test(p.plan) || p.plan.includes("..")) {
    return r("`plan` must be the plan file's path inside repo, ending .json, with no ..");
  }
  if (typeof p.stamp !== "string" || !/^[0-9a-f]{64}$/.test(p.stamp)) return r("`stamp` must be the full preflight stamp: 64 lower-case hex characters.");
  if (typeof p.preflight_at !== "string" || !ISO_TIME.test(p.preflight_at)) return r("`preflight_at` must be an ISO time, e.g. 2026-11-18T15:00:00Z.");
  if (typeof p.object !== "string" || !SF_NAME.test(p.object)) return r("`object` must be one API name, e.g. Contact or Donation__c.");
  if (typeof p.problem !== "string" || chars(p.problem) < 20 || chars(p.problem) > 600) return r("`problem` must be the plan's problem sentence, 20 to 600 characters.");
  if (!Number.isInteger(p.expected) || (p.expected as number) < 1 || (p.expected as number) > 999_999_999) {
    return r("`expected` must be the whole number of records the write changes, at least 1.");
  }
  const w = p.write;
  if (!isObject(w) || Object.keys(w).some((k) => k !== "kind" && k !== "class")) return r("`write` must be {kind: bulk} or {kind: batch, class}.");
  if (w.kind === "bulk") {
    if (w.class !== undefined) return r("a bulk write takes no class.");
  } else if (w.kind === "batch") {
    if (typeof w.class !== "string" || !SF_NAME.test(w.class)) return r("a batch write needs its deployed class name.");
  } else {
    return r("`write.kind` must be bulk or batch (D5: no other way to write).");
  }
  const rows = p.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > DATAOP_MAX_ROWS) return r(`\`rows\` must list 1 to ${DATAOP_MAX_ROWS} state rows.`);
  for (const [i, row] of rows.entries()) {
    const at = `row ${i + 1}`;
    if (!isObject(row)) return r(`${at} must be {label, before, goal, knock_on?}.`);
    const bad = Object.keys(row).filter((k) => !["label", "before", "goal", "knock_on"].includes(k));
    if (bad.length) return r(`${at} does not take ${bad.join(", ")}.`);
    if (typeof row.label !== "string" || !row.label.trim() || chars(row.label) > 200 || /[\r\n]/.test(row.label)) {
      return r(`${at}'s label must be one line of 1 to 200 characters.`);
    }
    if (!isCount(row.before) || !isCount(row.goal)) return r(`${at}'s before and goal must be whole numbers, 0 or more.`);
    if (row.knock_on !== undefined && typeof row.knock_on !== "boolean") return r(`${at}'s knock_on must be true or false.`);
  }
  if (p.rehearsal !== undefined) {
    const h = p.rehearsal;
    if (!isObject(h) || Object.keys(h).some((k) => k !== "sandbox" && k !== "at")) return r("`rehearsal` must be {sandbox, at}, or left out.");
    if (typeof h.sandbox !== "string" || !SF_ALIAS.test(h.sandbox)) return r("`rehearsal.sandbox` must be the sandbox's alias.");
    if (typeof h.at !== "string" || !ISO_TIME.test(h.at)) return r("`rehearsal.at` must be an ISO time.");
  }
  if (JSON.stringify(p).length > 16000) return r("the payload is over 16,000 characters.");
  return { payload: p };
}

export function sfDataopHeadline(code: string, p: Record<string, unknown>): string {
  const n = (p.expected as number).toLocaleString("en-US");
  const w = p.write as { kind: string; class?: string };
  const how = w.kind === "batch" ? `BY BATCH ${w.class}` : "BY BULK";
  return `PRODUCTION DATA RUN ${code} ON ${p.alias}: ABOUT TO CHANGE ${n} LIVE RECORD${p.expected === 1 ? "" : "S"} OF ${p.object} ${how}`;
}

export const queueSwitchboardSfDataopTool = defineTool({
  name: "queue_switchboard_sf_dataop",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_sf_dataop";
    const code = typeof args.project_code === "string" ? args.project_code.trim() : "";
    if (!PROJECT_CODE.test(code)) throw fail(tool, "`project_code` must be the data operation's project code, as sb printed it.");
    const checked = sfDataopPayload(args);
    if ("refused" in checked) throw fail(tool, `refused: ${checked.refused}`);
    const headline = sfDataopHeadline(code, checked.payload);
    // needs_click is always true for this kind, whoever queues it (the database sets it and refuses false).
    const actionId = await queueHelper(tool, ctx, "sf_dataop", code, checked.payload, headline, chatOf(args));
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw dbError(tool, `issuing the link for ${actionId}`, error);
    }
    return {
      ...(data as Record<string, unknown>), action_id: actionId, headline, payload: checked.payload,
      next: "Give Alex the url whole, in its own reply; it lasts 30 minutes. ONLY HIS CLICK ON APPROVE STARTS THE RUN. The page " +
        `shows the PRODUCTION banner, "About to change ${(checked.payload.expected as number).toLocaleString("en-US")} live records", ` +
        "the problem, the stamp and the Before and Goal rows. After the click the desktop helper must pick it up within 15 minutes " +
        "or it fails unrun; it checks the stamp and the sandbox pass against the plan before anything is written. " +
        `The result line (dataop ${actionId} done or failed) arrives in this chat by itself, and the receipt as a clip.`,
    };
  },
});

// ---------------------------------------------------------------------------
// queue_switchboard_sf_dataquery (dataop_link-k7d A1): production bulk exports or SELECT COUNT()s for Data run v2,
// started only by Alex's click on its link; only whole-number counts and a pass flag come back. The payload is
// docs/technical-spec-dataop_link-k7d.md parts 2 to 4, checked here with the same rules as the database's
// switchboard_dataquery_payload_ok (so a refusal says why), then by it, then by the helper against the run folder.
// ---------------------------------------------------------------------------

const DATAQUERY_KEYS = ["alias", "org_type", "repo", "run", "run_tag", "request_sha256", "queries"];
// dataquery_fixes-v3n: the org's type, as sb prints it from orgs.json; the helper refuses a mismatch.
export const DATAQUERY_ORG_TYPES = ["sandbox", "production"];
const DATAQUERY_QUERY_KEYS = ["step", "soql", "sha256", "file", "label"];
export const DATAQUERY_EXPORT_STEPS = ["manifest", "before", "undo"];
export const DATAQUERY_COUNT_STEPS = ["preflight-counts", "rules"];
export const DATAQUERY_MAX_QUERIES = 40;
export const DATAQUERY_MAX_COUNT_CHARS = 8000;
export const DATAQUERY_MAX_EXPORT_CHARS = 100_000;
export const DATAQUERY_MAX_PAYLOAD = 220_000;
const HEX64 = /^[0-9a-f]{64}$/;
// Blank space is [ \t\r\n] exactly, as in the database function (not \s, whose set differs between the two).
const EXPORT_SOQL = /^[ \t\r\n]*SELECT[ \t\r\n]+Id([ \t\r\n]*,|[ \t\r\n]+FROM[ \t\r\n])/i;
const COUNT_SOQL = /^[ \t\r\n]*SELECT[ \t\r\n]+COUNT\(\)[ \t\r\n]+FROM[ \t\r\n]+[A-Za-z][A-Za-z0-9_]*[ \t\r\n]+WHERE[ \t\r\n]/i;
const ANY_COUNT = /COUNT[ \t\r\n]*\(/i;
const GROUP_BY = /GROUP[ \t\r\n]+BY/i;
const SOQL_FILE = /^[A-Za-z0-9_.-]{1,80}\.soql$/;
const RUN_FOLDER = /^[\\/][A-Za-z0-9_.-]{1,80}$/;
const RUN_TAG_TAIL = /^[0-9]+[a-z]*-[a-z0-9]{4}$/;

/** The SHA-256 of a string's UTF-8 bytes, lower-case hex: what the database computes with sha256(convert_to(...)). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The length of a value as Postgres prints jsonb (", " and ": " separators), so the payload cap means the same here. */
export function jsonbTextLength(v: unknown): number {
  if (Array.isArray(v)) return v.length ? 2 + v.reduce((n: number, x) => n + jsonbTextLength(x), 0) + 2 * (v.length - 1) : 2;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return 2;
    return 2 + entries.reduce((n, [k, x]) => n + JSON.stringify(k).length + 2 + jsonbTextLength(x), 0) + 2 * (entries.length - 1);
  }
  return JSON.stringify(v).length;
}

export async function sfDataqueryPayload(code: string, args: Record<string, unknown>):
    Promise<{ payload: Record<string, unknown> } | { refused: string }> {
  const r = (refused: string) => ({ refused });
  const p = payloadOf(args);
  const extra = Object.keys(p).filter((k) => !DATAQUERY_KEYS.includes(k));
  if (extra.length) return r(`an sf_dataquery does not take ${extra.join(", ")}. Pass sb's printed arguments exactly as they are.`);
  const missing = DATAQUERY_KEYS.filter((k) => k !== "request_sha256" && p[k] === undefined);
  if (typeof p.org_type !== "string" || !DATAQUERY_ORG_TYPES.includes(p.org_type)) {
    return r(`\`org_type\` must be exactly "sandbox" or "production", as sb printed it${p.org_type === undefined ? "" : `, not ${JSON.stringify(p.org_type)}`}.`);
  }
  if (missing.length) return r(`missing ${missing.join(", ")}: pass every argument sb printed.`);
  if (typeof p.alias !== "string" || !SF_ALIAS.test(p.alias)) return r("`alias` must be the org's alias (letters, digits, _ . -).");
  if (typeof p.repo !== "string" || p.repo.length > 240 || !GIT_REPO.test(p.repo) || p.repo.includes("..")) {
    return r("`repo` must be the checkout's absolute path, e.g. C:\\Users\\Alex\\projects\\common-defense, with no ..");
  }
  const run = p.run;
  const tail = typeof run === "string" ? run.slice(9 + code.length) : "";
  if (typeof run !== "string" || run.length > 200 || run.includes("..") || !["data-ops/", "data-ops\\"].includes(run.slice(0, 9)) ||
      run.slice(9, 9 + code.length) !== code || !RUN_FOLDER.test(tail) || /^[\\/]\.+$/.test(tail)) {
    return r(`\`run\` must be the run folder inside repo: data-ops/${code}/<run>, one folder, with no ..`);
  }
  const tag = p.run_tag;
  if (typeof tag !== "string" || tag.length > 60 || !tag.startsWith(`${code}-s`) || !RUN_TAG_TAIL.test(tag.slice(code.length + 2))) {
    return r(`\`run_tag\` must be this project's run tag, e.g. ${code}-s4-ab12.`);
  }
  if (p.request_sha256 !== undefined && (typeof p.request_sha256 !== "string" || !HEX64.test(p.request_sha256))) {
    return r("`request_sha256` must be request.json's SHA-256: 64 lower-case hex characters.");
  }
  const queries = p.queries;
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > DATAQUERY_MAX_QUERIES) {
    return r(`\`queries\` must list 1 to ${DATAQUERY_MAX_QUERIES} queries.`);
  }
  let first: string | null = null;
  const labels = new Set<string>();
  for (const [i, q] of queries.entries()) {
    const at = `query ${i + 1}`;
    if (!isObject(q)) return r(`${at} must be {step, soql, sha256, file | label}.`);
    const bad = Object.keys(q).filter((k) => !DATAQUERY_QUERY_KEYS.includes(k));
    if (bad.length) return r(`${at} does not take ${bad.join(", ")}.`);
    const step = q.step;
    const isExport = typeof step === "string" && DATAQUERY_EXPORT_STEPS.includes(step);
    if (typeof step !== "string" || !(isExport || DATAQUERY_COUNT_STEPS.includes(step))) {
      return r(`${at}'s step must be one of ${[...DATAQUERY_EXPORT_STEPS, ...DATAQUERY_COUNT_STEPS].join(", ")}.`);
    }
    if (first === null) first = step;
    else if (DATAQUERY_EXPORT_STEPS.includes(first) !== isExport) return r("a link is all exports (manifest, before, undo) or all counts, never both.");
    else if (!isExport && step !== first) return r(`a count link is one step: ${at} is ${step}, the first is ${first}.`);
    if (typeof q.soql !== "string") return r(`${at}'s soql must be the query's exact text.`);
    const soql = q.soql;
    if (soql.includes(";")) return r(`${at}'s soql has a semicolon: one query, no ;.`);
    if (typeof q.sha256 !== "string" || q.sha256 !== await sha256Hex(soql)) {
      return r(`${at}'s sha256 isn't the SHA-256 of its soql's exact bytes: pass both as sb printed them.`);
    }
    if (isExport) {
      if (chars(soql) > DATAQUERY_MAX_EXPORT_CHARS) return r(`${at} is over ${DATAQUERY_MAX_EXPORT_CHARS.toLocaleString("en-US")} characters.`);
      if (!EXPORT_SOQL.test(soql) || ANY_COUNT.test(soql)) return r(`${at} is an export: SELECT Id, ... FROM ..., with no COUNT(.`);
    } else {
      if (chars(soql) > DATAQUERY_MAX_COUNT_CHARS) return r(`${at} is over ${DATAQUERY_MAX_COUNT_CHARS.toLocaleString("en-US")} characters.`);
      if (!COUNT_SOQL.test(soql) || GROUP_BY.test(soql)) return r(`${at} is a count: SELECT COUNT() FROM <object> WHERE ..., with no GROUP BY.`);
    }
    if (("file" in q) === ("label" in q)) return r(`${at} needs exactly one of file and label.`);
    if ("file" in q) {
      if (typeof q.file !== "string" || !SOQL_FILE.test(q.file)) return r(`${at}'s file must be one .soql file name in the run folder.`);
    } else {
      const label = q.label;
      if (typeof label !== "string" || chars(label) < 1 || chars(label) > 200 || /^ *$/.test(label) || /[\r\n]/.test(label)) {
        return r(`${at}'s label must be one line of 1 to 200 characters.`);
      }
      if (labels.has(label)) return r(`${at}'s label "${label}" is already used in this link.`);
      labels.add(label);
    }
  }
  if (labels.size && p.request_sha256 === undefined) return r("a query with a label needs `request_sha256`, the request it was built from.");
  if (jsonbTextLength(p) > DATAQUERY_MAX_PAYLOAD) return r(`the payload is over ${DATAQUERY_MAX_PAYLOAD.toLocaleString("en-US")} characters.`);
  return { payload: p };
}

export function sfDataqueryHeadline(code: string, p: Record<string, unknown>): string {
  const queries = p.queries as { step: string }[];
  const steps = [...new Set(queries.map((q) => q.step))];
  const what = DATAQUERY_EXPORT_STEPS.includes(steps[0]) ? "EXPORT" : "COUNTS";
  const n = queries.length;
  const org = p.org_type === "sandbox" ? "SANDBOX" : "PRODUCTION";
  return `${org} ${what} ${code} ON ${p.alias}: ${n} QUER${n === 1 ? "Y" : "IES"} (${steps.join(", ")}), READ ONLY`;
}

export const queueSwitchboardSfDataqueryTool = defineTool({
  name: "queue_switchboard_sf_dataquery",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_sf_dataquery";
    const code = typeof args.project_code === "string" ? args.project_code.trim() : "";
    if (!PROJECT_CODE.test(code)) throw fail(tool, "`project_code` must be the data operation's project code, as sb printed it.");
    const checked = await sfDataqueryPayload(code, args);
    if ("refused" in checked) throw fail(tool, `refused: ${checked.refused}`);
    const headline = sfDataqueryHeadline(code, checked.payload);
    // needs_click is always true for this kind, whoever queues it (the database sets it and refuses false).
    const actionId = await queueHelper(tool, ctx, "sf_dataquery", code, checked.payload, headline, chatOf(args));
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw dbError(tool, `issuing the link for ${actionId}`, error);
    }
    const org = checked.payload.org_type === "sandbox" ? "SANDBOX" : "PRODUCTION";
    return {
      ...(data as Record<string, unknown>), action_id: actionId, headline, payload: checked.payload,
      next: `Give Alex the url whole, in its own reply; it lasts 30 minutes. ONLY HIS CLICK ON APPROVE RUNS THESE ${org} ` +
        `QUERIES. The page shows the ${org} banner and each SOQL in full with its step and hash. After the click the desktop ` +
        "helper must pick it up within 15 minutes or it fails unrun; it checks every hash against the run folder first. The " +
        "exported files stay on Alex's PC. When the result line arrives, read the counts with get_switchboard_run: " +
        "run.result.query_counts, one per query in this order, and run.result.pass.",
    };
  },
});

// ---------------------------------------------------------------------------
// queue_switchboard_sf_datawrite (dataop_write-j5w A2): Data run v2's write link, the gate, the write (batch, bulk
// update or undo), the after export and the after counts under one approval, started only by Alex's click. The payload
// is docs/technical-spec-dataop_write-j5w.md part 2. sfDatawriteProblem is the database's
// switchboard_datawrite_payload_problem rule for rule, check for check, in the same order and with the same sentences,
// so a refusal here is the refusal the database would give. Change the two together.
// ---------------------------------------------------------------------------

const DATAWRITE_KEYS = ["alias", "org_type", "repo", "run", "run_tag", "request_sha256", "selection_sha256", "object", "problem",
  "expected", "write", "uploads", "queries"];
const DATAWRITE_REQUIRED = ["alias", "org_type", "repo", "run", "run_tag", "request_sha256", "selection_sha256", "object",
  "expected", "write", "queries"];
const DATAWRITE_QUERY_KEYS = ["step", "soql", "sha256", "file", "label", "wait"];
export const DATAWRITE_MAX_PAYLOAD = 200_000;
export const DATAWRITE_MAX_IDS = 200;
export const DATAWRITE_MAX_COUNTS = 40;
export const DATAWRITE_MAX_WAIT_MINUTES = 180;
/** An Id, as the database counts it: a quoted literal of exactly 15 or 18 letters and digits. Conservative. */
export const DATAWRITE_ID = /'[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?'/g;
const CSV_FILE = /^[A-Za-z0-9_.-]{1,80}\.csv$/;
const WHOLE = /^[1-9][0-9]{0,8}$/;
// The database's repo pattern uses [:cntrl:]; \x7f is added here so DEL is refused on both sides.
const DATAWRITE_REPO = /^[A-Za-z]:(\\[^\\/:*?"<>|\x00-\x1f\x7f]+)+$/;
const STEP_RANK: Record<string, number> = { gate: 1, after: 2, "after-counts": 3 };

/** A positive whole number as jsonb prints one, 1 to 999,999,999 (the database's '^[1-9][0-9]{0,8}$'). */
const isWhole = (v: unknown) => typeof v === "number" && Number.isInteger(v) && WHOLE.test(String(v));
/** Postgres quote_literal: '' for ', and E'' with \\ when there is a backslash. */
const quoteLiteral = (s: string) => (s.includes("\\") ? `E'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'` : `'${s.replace(/'/g, "''")}'`);
const fmt = (n: number) => n.toLocaleString("en-US");
/** Keys in v that aren't in allowed, sorted. */
const extraKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).filter((k) => !allowed.includes(k)).sort();
/** Postgres jsonb `-` then `= '{}'`: v has no key outside allowed. */
const onlyKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
const hasAll = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => k in v);
export const datawriteIdCount = (soql: string) => (soql.match(DATAWRITE_ID) ?? []).length;

/**
 * Why an sf_datawrite payload fails the contract, as one sentence saying what to do, or null when it passes: the
 * database's switchboard_datawrite_payload_problem, in the same order with the same sentences.
 */
export async function sfDatawriteProblem(code: string, p: Record<string, unknown>): Promise<string | null> {
  if (!isObject(p)) return "the payload must be a JSON object: pass sb's printed arguments exactly as they are.";
  if (!PROJECT_CODE.test(code)) return "the action needs the data operation's project code, as sb printed it.";
  const extra = extraKeys(p, DATAWRITE_KEYS);
  if (extra.length) return `the payload does not take ${extra.join(", ")}. Pass sb's printed arguments exactly as they are.`;
  const missing = DATAWRITE_REQUIRED.filter((k) => !(k in p));
  if (missing.length) return `missing ${missing.join(", ")}: pass every argument sb printed.`;
  const len = jsonbTextLength(p);
  if (len > DATAWRITE_MAX_PAYLOAD) {
    return `the payload is ${fmt(len)} characters; the limit is 200,000. Select by criteria instead of long lists, or split the run.`;
  }

  // ---- the run's identity (A1's rules, with org_type required) ----
  if (typeof p.alias !== "string" || !SF_ALIAS.test(p.alias)) return "alias must be the org's alias (letters, digits, _ . -).";
  if (typeof p.org_type !== "string" || !DATAQUERY_ORG_TYPES.includes(p.org_type)) {
    return 'org_type must be exactly "sandbox" or "production", as sb printed it from orgs.json.';
  }
  if (typeof p.repo !== "string" || chars(p.repo) > 240 || !DATAWRITE_REPO.test(p.repo) || p.repo.includes("..")) {
    return "repo must be the checkout's absolute path, e.g. C:\\Users\\Alex\\projects\\common-defense, with no ..";
  }
  const run = p.run;
  const runTail = typeof run === "string" ? run.slice(9 + code.length) : "";
  if (typeof run !== "string" || chars(run) > 200 || run.includes("..") || !["data-ops/", "data-ops\\"].includes(run.slice(0, 9)) ||
      run.slice(9, 9 + code.length) !== code || !RUN_FOLDER.test(runTail) || /^[\\/]\.+$/.test(runTail)) {
    return `run must be the run folder inside repo: data-ops/${code}/<run>, one folder, with no ..`;
  }
  const tag = p.run_tag;
  if (typeof tag !== "string" || chars(tag) > 60 || !tag.startsWith(`${code}-s`) || !RUN_TAG_TAIL.test(tag.slice(code.length + 2))) {
    return `run_tag must be this project's run tag, e.g. ${code}-s4-ab12.`;
  }
  if (typeof p.request_sha256 !== "string" || !HEX64.test(p.request_sha256)) {
    return "request_sha256 must be request.json's SHA-256: 64 lower-case hex characters.";
  }
  if (typeof p.selection_sha256 !== "string" || !HEX64.test(p.selection_sha256)) {
    return "selection_sha256 must be selection.soql's SHA-256: 64 lower-case hex characters.";
  }
  const sel = p.selection_sha256;
  if (typeof p.object !== "string" || !SF_NAME.test(p.object)) return "object must be one API name, e.g. GiftTransaction or Donation__c.";
  if ("problem" in p && (typeof p.problem !== "string" || chars(p.problem) < 20 || chars(p.problem) > 600 || /[\r\n]/.test(p.problem))) {
    return "problem must be the request's problem sentence: one line of 20 to 600 characters, or left out.";
  }
  if (!isWhole(p.expected)) return "expected must be the whole number of records the write changes, 1 to 999,999,999.";
  const expected = p.expected as number;

  // ---- the write: batch, bulk update or undo ----
  const w = p.write;
  if (!isObject(w)) {
    return "write must be {kind: batch, class}, {kind: bulk, operation: update, csv, csv_sha256} or {kind: undo, class, ids_file, ids_sha256}.";
  }
  const wkind = typeof w.kind === "string" ? w.kind : null;
  if (wkind === "batch") {
    if (!onlyKeys(w, ["kind", "class"]) || !("class" in w)) {
      return "a batch write is {kind: batch, class} only: the class name, with no Ids or start arguments (production starts new <Class>()).";
    }
  } else if (wkind === "bulk") {
    if (!onlyKeys(w, ["kind", "operation", "csv", "csv_sha256"]) || !hasAll(w, ["operation", "csv", "csv_sha256"])) {
      return "a bulk write is {kind: bulk, operation: update, csv, csv_sha256}, nothing more or less.";
    }
    if (w.operation !== "update") return 'a bulk write is an update only: operation must be "update".';
    if (typeof w.csv !== "string" || !CSV_FILE.test(w.csv)) return "write.csv must be one .csv file name in the run folder.";
    if (typeof w.csv_sha256 !== "string" || !HEX64.test(w.csv_sha256)) return "write.csv_sha256 must be the CSV's SHA-256: 64 lower-case hex characters.";
  } else if (wkind === "undo") {
    if (!onlyKeys(w, ["kind", "class", "ids_file", "ids_sha256"]) || !hasAll(w, ["class", "ids_file", "ids_sha256"])) {
      return "an undo write is {kind: undo, class, ids_file, ids_sha256}, nothing more or less.";
    }
    if (typeof w.ids_file !== "string" || !CSV_FILE.test(w.ids_file)) return "write.ids_file must be one .csv file name in the run folder.";
    if (typeof w.ids_sha256 !== "string" || !HEX64.test(w.ids_sha256)) return "write.ids_sha256 must be the Id file's SHA-256: 64 lower-case hex characters.";
  } else {
    return "write.kind must be batch, bulk or undo.";
  }
  if ((wkind === "batch" || wkind === "undo") && (typeof w.class !== "string" || !SF_NAME.test(w.class))) {
    return "write.class must be the deployed Batch class's name (letters, digits, _).";
  }

  // ---- uploads: the files known before the run that it uploads after Alex's Enter ----
  let undoUpload: Record<string, unknown> | null = null;
  // s6b: a bulk write uploads nothing (left-out records come out of the CSV; failures are the Bulk API job's own).
  if (wkind === "bulk" && "uploads" in p) return "a bulk write uploads nothing; remove uploads.";
  if ("uploads" in p) {
    if (!Array.isArray(p.uploads) || p.uploads.length > 2) return "uploads must list at most 2 files, each {purpose, file, sha256, rows}, or be left out.";
    const purposes: string[] = [];
    for (const u of p.uploads) {
      if (!isObject(u) || !onlyKeys(u, ["purpose", "file", "sha256", "rows"]) || !hasAll(u, ["purpose", "file", "sha256", "rows"])) {
        return "each upload is {purpose, file, sha256, rows}, nothing more or less.";
      }
      const purpose = u.purpose;
      if (purpose !== "exclude" && purpose !== "undo-ids") return 'an upload\'s purpose must be "exclude" or "undo-ids".';
      if (purposes.includes(purpose)) return `there are two ${purpose} uploads: list each purpose once.`;
      purposes.push(purpose);
      if (typeof u.file !== "string" || !CSV_FILE.test(u.file)) return `the ${purpose} upload's file must be one .csv file name in the run folder.`;
      if (typeof u.sha256 !== "string" || !HEX64.test(u.sha256)) return `the ${purpose} upload's sha256 must be 64 lower-case hex characters.`;
      if (!isWhole(u.rows)) return `the ${purpose} upload's rows must be its row count, 1 to 999,999,999.`;
      // s11c: no rows-versus-expected rule for exclude (exclude.csv also holds records added at the gate).
      if (purpose === "undo-ids") undoUpload = u;
    }
  }
  if (wkind === "undo") {
    if (!undoUpload) {
      return 'an undo needs its Id file in uploads: {purpose: "undo-ids", file: <ids_file>, sha256: <ids_sha256>, rows: <expected>}.';
    }
    if (undoUpload.file !== w.ids_file || undoUpload.sha256 !== w.ids_sha256) {
      return "the undo-ids upload must be the write's Id file: the same file and sha256 as write.ids_file and write.ids_sha256.";
    }
    if (undoUpload.rows !== expected) {
      return `the undo Id file has ${undoUpload.rows} rows but expected is ${expected}: they must be equal, since expected is the Id file's row count.`;
    }
  } else if (undoUpload) {
    return "only an undo uploads an Id file: leave the undo-ids upload out.";
  }

  // ---- queries: the gate, the after export, the after counts, in that order ----
  const queries = p.queries;
  if (!Array.isArray(queries) || queries.length < 2 || queries.length > 44) {
    return "queries must list 2 to 44 queries: the gate, the after export, then the after counts.";
  }
  let last = 0;
  let nGate = 0;
  let nCounts = 0;
  let waits = 0;
  let broad = false;
  const labels: string[] = [];
  for (const [i, q] of queries.entries()) {
    if (!isObject(q)) return `query ${i + 1} must be {step, soql, sha256, file | label, wait?}.`;
    const label = typeof q.label === "string" ? q.label : null;
    const name = label !== null ? quoteLiteral(label) : typeof q.file === "string" ? quoteLiteral(q.file) : `number ${i + 1}`;
    const bad = extraKeys(q, DATAWRITE_QUERY_KEYS);
    if (bad.length) return `the query ${name} does not take ${bad.join(", ")}.`;
    const step = typeof q.step === "string" ? q.step : "";
    const rank = STEP_RANK[step];
    if (!rank) return `the query ${name} needs a step: gate, after or after-counts.`;
    if (rank < last) return `the query ${name} (${step}) comes after a later step: list the gate first, then after, then after-counts.`;
    last = rank;

    if (typeof q.soql !== "string") return `the query ${name} needs its soql, the exact text.`;
    const soql = q.soql;
    if (soql.includes(";")) return `the query ${name} has a semicolon: one query, no ;.`;
    const sha = await sha256Hex(soql);
    if (typeof q.sha256 !== "string" || q.sha256 !== sha) {
      return `the query ${name} has a sha256 that isn't the SHA-256 of its soql's exact bytes: pass both as sb printed them.`;
    }
    if (step === "gate" || step === "after") {
      if (chars(soql) > DATAQUERY_MAX_EXPORT_CHARS) {
        return `the query ${name} is ${fmt(chars(soql))} characters; an export is at most 100,000. Select by criteria instead, or split the run.`;
      }
      if (!EXPORT_SOQL.test(soql) || ANY_COUNT.test(soql)) return `the query ${name} is an export: SELECT Id, ... FROM ..., with no COUNT(.`;
    } else {
      if (chars(soql) > DATAQUERY_MAX_COUNT_CHARS) return `the query ${name} is ${fmt(chars(soql))} characters; a count is at most 8,000.`;
      if (!COUNT_SOQL.test(soql) || GROUP_BY.test(soql)) return `the query ${name} is a count: SELECT COUNT() FROM <object> WHERE ..., with no GROUP BY.`;
    }

    // Exactly one of file and label; labels unique within the payload.
    if (("file" in q) === ("label" in q)) return `the query ${name} needs exactly one of file and label.`;
    if ("file" in q) {
      if (typeof q.file !== "string" || !SOQL_FILE.test(q.file)) return `the query ${name}'s file must be one .soql file name in the run folder.`;
    } else {
      if (label === null || chars(label) < 1 || chars(label) > 200 || /^ *$/.test(label) || /[\r\n]/.test(label)) {
        return `the query ${name}'s label must be one line of 1 to 200 characters.`;
      }
      if (labels.includes(label)) return `the label ${name} is used twice: labels are unique within a link.`;
      labels.push(label);
    }

    // What each step holds.
    if (step === "gate") {
      nGate++;
      if (wkind === "undo") {
        if (nGate > 1) return "an undo's gate is exactly one export: a fresh export of the broad snapshot.";
        if (label === null || !/broad snapshot$/.test(label)) {
          return 'an undo\'s gate is a fresh export of the broad snapshot, labelled e.g. "gate: broad snapshot".';
        }
      } else if (nGate === 1) {
        if (q.file !== "selection.soql" || sha !== sel) {
          return 'the gate\'s first export must be selection.soql (file "selection.soql"), with its sha256 equal to selection_sha256.';
        }
      } else if (label === null) {
        return 'the gate\'s second export must be labelled, e.g. "gate: broad snapshot".';
      }
    } else if (step === "after") {
      if (label !== "after: broad snapshot" && label !== "after: selection") {
        return 'an after export is labelled "after: broad snapshot" (required) or "after: selection" (optional).';
      }
      if (label === "after: selection") {
        if (wkind === "undo") return 'an undo\'s after is only "after: broad snapshot": leave "after: selection" out.';
        if (sha !== sel) return "the query 'after: selection' is selection.soql run again: its sha256 must equal selection_sha256.";
      } else {
        broad = true;
      }
    } else {
      nCounts++;
    }

    // A wait only on an after-count labelled "...: wait".
    if ("wait" in q) {
      if (step !== "after-counts" || label === null || !/: wait$/.test(label)) {
        return `the query ${name} takes no wait: only an after-count labelled "...: wait" does.`;
      }
      const wt = q.wait;
      if (!isObject(wt) || !onlyKeys(wt, ["stable_minutes", "limit_minutes"])
          || typeof wt.stable_minutes !== "number" || !/^[1-9][0-9]?$/.test(String(wt.stable_minutes))
          || typeof wt.limit_minutes !== "number" || !/^[1-9][0-9]{0,2}$/.test(String(wt.limit_minutes))
          || (wt.stable_minutes as number) > 60 || (wt.limit_minutes as number) > 240) {
        return `the query ${name}'s wait must be {stable_minutes: 1 to 60, limit_minutes: 1 to 240}.`;
      }
      waits += wt.limit_minutes as number;
    }

    // Ids (s10): a Salesforce query takes at most 200 listed Ids, so each query that may list them (selection.soql,
    // "after: selection", every after-count, every export labelled "... broad snapshot") lists at most 200. Every
    // other export lists none. There is no cap across the link; the 200,000-character payload cap still applies.
    const ids = datawriteIdCount(soql);
    const mayListIds = step === "after-counts" || (step === "gate" && q.file === "selection.soql")
      || label === "after: selection" || (label !== null && /broad snapshot$/.test(label));
    if (mayListIds) {
      if (ids > DATAWRITE_MAX_IDS) {
        return `the query ${name} lists ${ids} Ids; a Salesforce query takes at most 200. Select by criteria instead, or split the run.`;
      }
    } else if (ids > 0) {
      return `the query ${name} lists ${ids} Id${ids === 1 ? "" : "s"}; Ids go only in selection.soql, "after: selection", an after-count or an export labelled "... broad snapshot". Select by criteria instead.`;
    }
  }

  if (nGate === 0 || nGate > 2) return `the gate has ${nGate} exports; it takes 1 or 2 (an undo, exactly 1).`;
  if (!broad) return 'the after step needs "after: broad snapshot", the same fields as the before broad snapshot.';
  if (nCounts > DATAWRITE_MAX_COUNTS) return `there are ${nCounts} after-counts; the limit is 40. Move the rest to a count link.`;
  if (waits > DATAWRITE_MAX_WAIT_MINUTES) {
    return `the waits add up to ${waits} minutes; the limit is 180, so the run fits its 4 hours. Shorten the waits, or move a rule to a count link.`;
  }
  return null;
}

/** The arguments as an sf_datawrite payload, or the sentence saying what to fix. */
export async function sfDatawritePayload(code: string, args: Record<string, unknown>):
    Promise<{ payload: Record<string, unknown> } | { refused: string }> {
  const p = payloadOf(args);
  const problem = await sfDatawriteProblem(code, p);
  return problem === null ? { payload: p } : { refused: problem };
}

export function sfDatawriteHeadline(code: string, p: Record<string, unknown>): string {
  const n = p.expected as number;
  const w = p.write as { kind: string; class?: string };
  const how = w.kind === "batch" ? `BY BATCH ${w.class}` : w.kind === "undo" ? `BY UNDO ${w.class}` : "BY BULK UPDATE";
  const sandbox = p.org_type === "sandbox";
  return `${sandbox ? "SANDBOX" : "PRODUCTION"} DATA WRITE ${code} ON ${p.alias}: ABOUT TO CHANGE ${fmt(n)} ` +
    `${sandbox ? "" : "LIVE "}RECORD${n === 1 ? "" : "S"} OF ${p.object} ${how}`;
}

export const queueSwitchboardSfDatawriteTool = defineTool({
  name: "queue_switchboard_sf_datawrite",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "queue_switchboard_sf_datawrite";
    const code = typeof args.project_code === "string" ? args.project_code.trim() : "";
    if (!PROJECT_CODE.test(code)) throw fail(tool, "`project_code` must be the data operation's project code, as sb printed it.");
    const checked = await sfDatawritePayload(code, args);
    if ("refused" in checked) throw fail(tool, `refused: ${checked.refused}`);
    const p = checked.payload;
    const headline = sfDatawriteHeadline(code, p);
    // needs_click is always true for this kind, whoever queues it (the database sets it and refuses false).
    const { data: queued, error: queueError } = await ctx.db.rpc("switchboard_queue_helper", {
      p_kind: "sf_datawrite", p_project_code: code, p_payload: p, p_headline: headline, p_chat_url: chatOf(args),
    });
    if (queueError) {
      if (REFUSALS.has(queueError.code ?? "") || queueError.code === "23514") throw fail(tool, `refused: ${queueError.message}`);
      throw fail(tool, `queueing the write link failed: ${queueError.message ?? "(no message)"}` +
        `${queueError.code ? ` [${queueError.code}]` : ""}. Nothing was queued; the same call can be made again.`);
    }
    const actionId = (queued as Record<string, unknown> | null)?.action_id as string | undefined;
    if (!actionId) throw fail(tool, "the queue returned no action id; the same call can be made again.");
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `queued as ${actionId}, but no link: ${error.message}`);
      throw fail(tool, `queued as ${actionId}, but issuing its link failed: ${error.message ?? "(no message)"}` +
        `${error.code ? ` [${error.code}]` : ""}. Issue it again with issue_switchboard_link for ${actionId}.`);
    }
    const sandbox = p.org_type === "sandbox";
    const n = fmt(p.expected as number);
    return {
      ...(data as Record<string, unknown>), action_id: actionId, headline, payload: p,
      next: "Give Alex the url whole, in its own reply; it lasts 30 minutes. ONLY HIS CLICK ON APPROVE STARTS THIS " +
        `${sandbox ? "SANDBOX" : "PRODUCTION"} WRITE. The page shows the ${sandbox ? "SANDBOX" : "PRODUCTION"} banner, ` +
        `"about to change ${n} ${sandbox ? "records in the sandbox" : "live records"}", the write, every query in full and the files ` +
        "it uploads. After the click the desktop helper must pick it up within 15 minutes or it fails unrun; it asks Alex for " +
        "Enter before the write and before any upload. " +
        `The result line (datawrite ${actionId} done or failed) arrives in this chat by itself. Only counts and pass or fail come ` +
        "back: read them with get_switchboard_run, run.result.pass and run.result.datawrite (query_counts in payload order, " +
        "gate, write, check).",
    };
  },
});

export const getSwitchboardSfResultTool = defineTool({
  name: "get_switchboard_sf_result",
  tier: 1,
  tables: { reads: ["switchboard_sf_results", "switchboard_actions", "switchboard_runs"], writes: ["switchboard_sf_results"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_switchboard_sf_result";
    const actionId = requireUuid(tool, "action_id", args.action_id);
    const { data, error } = await ctx.db.rpc("switchboard_take_sf_result", { p_action_id: actionId });
    if (error) throw dbError(tool, "taking the result", error);
    const got = data as Record<string, unknown> | null;
    if (got) {
      return {
        ...(got.production_full_data === true ? { stamp: "PRODUCTION FULL DATA" } : {}),
        action_id: actionId, row_count: got.row_count, truncated: got.truncated === true, rows: got.rows,
        note: "These rows are now deleted from Alfred and won't come back. Summarise them; don't repeat raw rows, and never put them in a CLI prompt.",
      };
    }
    // Nothing to take: say which.
    const { data: action, error: aError } = await ctx.db.from("switchboard_actions").select("id, kind, status").eq("id", actionId).maybeSingle();
    if (aError) throw dbError(tool, "reading the action", aError);
    if (!action) throw fail(tool, `no such action: ${actionId}.`);
    const a = action as { kind: string; status: string };
    if (a.kind !== "sf_read") throw fail(tool, `${actionId} is a ${a.kind} action, not a Salesforce read.`);
    const { data: run, error: rError } = await ctx.db.from("switchboard_runs").select("summary, finished_at").eq("action_id", actionId)
      .eq("mode", "real").order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (rError) throw dbError(tool, "reading the run", rError);
    const r = run as { summary: string | null; finished_at: string | null } | null;
    if (a.status === "failed") return { action_id: actionId, rows: null, state: "failed", summary: r?.summary ?? null };
    if (a.status === "cancelled") return { action_id: actionId, rows: null, state: "cancelled", summary: "Alex chose Don't run." };
    if (a.status !== "succeeded" || !r?.finished_at) {
      return { action_id: actionId, rows: null, state: "not finished", summary: `The read is ${a.status}; wait for the sf ${actionId} line, then call again.` };
    }
    return { action_id: actionId, rows: null, state: "gone", summary: "Already taken, or past its 10 minutes. Queue the read again if it is still needed." };
  },
});

// ---------------------------------------------------------------------------
// get_sql_read
// ---------------------------------------------------------------------------

const MAX_SQL = 20000;
const MAX_ROWS = 1000;
const BUDGETS = [
  { limit: 20, seconds: 600, words: "10 minutes" },
  { limit: 200, seconds: 86400, words: "day" },
];
const ROLLBACK = Symbol("rollback");

type Tx = { unsafe(text: string, params?: unknown[], options?: unknown): PromiseLike<unknown> & { cursor(size: number): AsyncIterable<unknown[]> } };
type Reader = { begin(fn: (tx: Tx) => Promise<unknown>): Promise<unknown>; end(options?: unknown): Promise<unknown> };

// The one exception to "database access only through ctx.db": the query goes through claude_reader's own login, which
// can reach nothing else, and never through Alex's token. Swappable for the tests, and imported only when used,
// since node can't load npm: specifiers.
export const readerSeam = {
  url: (): string => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("SWITCHBOARD_READER_DB_URL") ?? "",
  connect: async (url: string): Promise<Reader> => {
    const { default: postgres } = await import("npm:postgres@3.4.5");
    return postgres(url, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 }) as unknown as Reader;
  },
};

/** An error's words for Claude and the log: a driver's error can quote the address it was given. */
const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/postgres(ql)?:\/\/\S+/gi, "[connection string]");

// --- The plan guard: only public and pg_catalog, read from what Postgres says it would do. ---

const READABLE_SCHEMAS = new Set(["public", "pg_catalog"]);
// pg_catalog functions that take a query or a table by name, so the plan can't see what they read.
const RUNS_TEXT = /\b(query_to_xml|query_to_xmlschema|query_to_xml_and_xmlschema|cursor_to_xml|cursor_to_xmlschema|table_to_xml|table_to_xmlschema|table_to_xml_and_xmlschema|schema_to_xml|schema_to_xmlschema|schema_to_xml_and_xmlschema|database_to_xml|database_to_xmlschema|database_to_xml_and_xmlschema|ts_stat|ts_rewrite)\s*\(/gi;
const NAME_IN_PLAN = String.raw`("[^"]+"|[A-Za-z_][\w$]*)`;
const QUALIFIED_CALL = new RegExp(String.raw`${NAME_IN_PLAN}\.${NAME_IN_PLAN}\s*\(`, "g");
const QUALIFIED_CAST = new RegExp(String.raw`::${NAME_IN_PLAN}\.${NAME_IN_PLAN}`, "g");
const NOT_EXPRESSIONS = new Set(["Schema", "Alias", "Relation Name", "Node Type"]);

const stripStrings = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''").replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");

/** What in an EXPLAIN (VERBOSE, FORMAT JSON) plan reaches outside the readable schemas. [] when nothing does. */
export function planProblems(plan: unknown): string[] {
  const found = new Set<string>();
  const readExpression = (text: string) => {
    const bare = stripStrings(text);
    for (const re of [QUALIFIED_CALL, QUALIFIED_CAST]) {
      for (const m of bare.matchAll(re)) {
        const schema = m[1].replace(/"/g, "");
        if (!READABLE_SCHEMAS.has(schema)) found.add(`${schema}.${m[2].replace(/"/g, "")}`);
      }
    }
    for (const m of bare.matchAll(RUNS_TEXT)) found.add(m[1].toLowerCase());
  };
  const walk = (v: unknown, key = "") => {
    if (typeof v === "string") {
      if (key === "Schema" && !READABLE_SCHEMAS.has(v)) found.add(v);
      if (!NOT_EXPRESSIONS.has(key)) readExpression(key === "Function Name" ? `${v}()` : v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(plan);
  return [...found];
}

const outsideReadable = (what: string) =>
  new Error(`refused: this query reaches outside public and pg_catalog (${what}). get_sql_read reads only public and pg_catalog.`);

/** One statement, read only, limited, always rolled back. The extended protocol refuses a second statement. */
async function runReadOnly(text: string) {
  const out = { rows: [] as unknown[], truncated: false, error: null as string | null };
  const url = readerSeam.url();
  if (!url) return { ...out, error: "SWITCHBOARD_READER_DB_URL is not set." };
  let sql: Reader | null = null;
  try {
    sql = await readerSeam.connect(url);
    await sql.begin(async (tx) => {
      await tx.unsafe("set transaction read only");
      await tx.unsafe("set local statement_timeout = '10s'");
      await tx.unsafe("set local lock_timeout = '1s'");
      // information_schema's views expand to pg_catalog tables, so its name is only ever in the query's own text.
      if (/\binformation_schema\b/i.test(stripStrings(text))) throw outsideReadable("information_schema");
      const answer = await tx.unsafe(`explain (verbose, format json) ${text}`, [], { simple: false }) as Record<string, unknown>[];
      const raw = answer[0]?.["QUERY PLAN"];
      const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!plan) throw new Error("refused: the query's plan could not be read.");
      const problems = planProblems(plan);
      if (problems.length) throw outsideReadable(problems.join(", "));
      for await (const batch of tx.unsafe(text, [], { simple: false }).cursor(MAX_ROWS + 1)) {
        out.truncated = batch.length > MAX_ROWS;
        out.rows = batch.slice(0, MAX_ROWS);
        break;
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) {
      out.rows = [];
      out.truncated = false;
      out.error = cleanError(e);
    }
  } finally {
    try { await sql?.end({ timeout: 2 }); } catch { /* the answer is already in hand */ }
  }
  return out;
}

export const getSqlReadTool = defineTool({
  name: "get_sql_read",
  tier: 1,
  tables: { reads: ["*", "switchboard_settings", "switchboard_read_log"], writes: ["switchboard_read_log"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_sql_read";
    const given = typeof args.sql === "string" ? args.sql : String(args.sql ?? "");
    const log = async (row: { ok: boolean; row_count: number | null; truncated: boolean; error: string | null; took_ms: number }) => {
      const { error } = await ctx.db.from("switchboard_read_log").insert({ query_text: given.slice(0, MAX_SQL), ...row });
      return error ? error.message ?? "the log write failed" : null;
    };
    const refuse = async (error: Error) => {
      await log({ ok: false, row_count: null, truncated: false, error: error.message, took_ms: 0 });
      return error;
    };

    if (typeof args.sql !== "string" || !args.sql.trim() || args.sql.length > MAX_SQL) {
      throw await refuse(fail(tool, `\`sql\` must be one statement of at most ${MAX_SQL} characters.`));
    }

    // Both checks fail closed: a guard that can't be read stops the query.
    const { data: settings, error: settingsError } = await ctx.db.from("switchboard_settings").select("reads_enabled").maybeSingle();
    if (settingsError) throw await refuse(dbError(tool, "reading the kill switch", settingsError));
    if (!settings) throw await refuse(fail(tool, "refused: no settings row, so the kill switch can't be read."));
    if (!(settings as { reads_enabled: boolean }).reads_enabled) {
      throw await refuse(fail(tool, "refused: read-only queries are switched off (switchboard_settings.reads_enabled)."));
    }

    // Counted from the log, refused calls included. platform_check_call_budget counts every tool's calls, not these,
    // and it adds to the budget defineTool already spends on this call.
    for (const b of BUDGETS) {
      const since = new Date(Date.now() - b.seconds * 1000).toISOString();
      const { count, error } = await ctx.db.from("switchboard_read_log").select("id", { count: "exact", head: true }).gte("created_at", since);
      if (error) throw await refuse(dbError(tool, "reading the read budget", error));
      if ((count ?? 0) >= b.limit) {
        throw await refuse(fail(tool, `READ BUDGET EXCEEDED: ${count} calls in the last ${b.words} (limit ${b.limit}). Do NOT retry. Stop and report to the user.`));
      }
    }

    const started = Date.now();
    const { rows, truncated, error } = await runReadOnly(args.sql);
    const logError = await log({
      ok: error === null, row_count: error === null ? rows.length : null, truncated, error, took_ms: Date.now() - started,
    });
    return { ok: error === null, rows, count: rows.length, truncated, error, ...(logError ? { log_error: logError } : {}) };
  },
});
