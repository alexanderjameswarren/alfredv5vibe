#!/usr/bin/env node
// PreToolUse guard: refuse to change a file this thread has not claimed, and
// refuse to deploy to Supabase without holding db:deploy.
//
// Claude Code runs this before every tool call, handing it the call as JSON on
// stdin. Exit 0 allows the call; exit 2 blocks it and shows whatever this
// script wrote to stderr to Claude, which is how the message below becomes
// instructions Claude actually follows.
//
// Registered in .claude/settings.local.json. The command uses an absolute path
// built from CLAUDE_PROJECT_DIR so it does not depend on the hook's working
// directory; see the note by the settings entry.
//
// ---------------------------------------------------------------------------
// WHY THIS GUARDS THE SHELL TOO
// ---------------------------------------------------------------------------
//
// Found on 2026-09-28, the first time this was tested for real: asked to add a
// comment to src/utils/recurrence.js, a session never touched Edit or Write. It
// ran
//
//   { printf '...'; cat src/utils/recurrence.js; } > /tmp/rec.$$ \
//     && mv /tmp/rec.$$ src/utils/recurrence.js
//
// and the guard, which only watched the edit tools and Supabase deploys, waved
// it straight through. Worth noticing that the redirect went to /tmp: a check
// for "redirects into the repo" would have missed it as well. The file was
// clobbered by `mv`.
//
// Claude Code's auto mode actively tells the model to prefer shell commands for
// file changes, so this is the normal path, not an exotic one. Guarding Edit and
// Write alone guards nothing.
//
// ---------------------------------------------------------------------------
// FAIL CLOSED, AND WHAT THAT COSTS
// ---------------------------------------------------------------------------
//
// An unclaimed file is blocked, and so is every edit when the claims file is
// missing or unreadable. A guard that waves things through when it is confused
// is not a guard: the whole point is that two threads never touch one file, and
// a single silent exception puts a merge conflict in main.
//
// The cost is real: nothing can be changed until it is claimed, including
// ordinary solo work in the main checkout. The way out is to claim what you are
// working on — `node scripts/claims.mjs claim <paths>`. For a session where that
// is genuinely in the way, set CLAIMS_GUARD=off in the environment; the hook
// then allows everything and says so on stderr and in its log, so it is never
// off quietly.
//
// Reads, searches and every tool that is not a change or a deploy return before
// this script touches git or the filesystem — a correctness rule and a speed one,
// since this runs before EVERY tool call.

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ClaimsError,
  fold,
  heldBy,
  isExempt,
  readState,
  repoPathsIn,
  resolveRepo,
  toRepoRelative,
  writeIndicator,
} from "../../scripts/lib/claims-core.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// `npx supabase functions deploy mcp` contains `supabase functions deploy`, so
// substring matching on the whitespace-normalised command covers every spelling
// we use. Deliberately broad: a false block costs one question to Alex, a false
// allow costs a deploy from a thread that does not own the function.
const DEPLOY_PATTERNS = ["supabase functions deploy", "supabase db push"];

const LOG_RELATIVE = ".clip/claims-guard.log";
const LOG_MAX_BYTES = 256 * 1024;

const ALLOW = 0;
const BLOCK = 2;

// Filled in as we learn them, so the log line is useful even on an early exit.
const entry = { tool: "?", owner: "?", cwd: "?" };

/**
 * Append one line per invocation to .clip/claims-guard.log.
 *
 * This exists because a hook that allows leaves no trace anywhere: when the
 * guard missed the shell write above, there was no way to tell from the
 * transcript whether it had run and allowed, or never run at all. Now there is.
 * .clip/ is git-ignored, so the log never reaches a commit.
 */
function log(decision, detail) {
  try {
    const root = entry.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const file = path.join(root, LOG_RELATIVE);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      // Bounded: this appends on every single tool call.
      if (statSync(file).size > LOG_MAX_BYTES) return;
    } catch {
      /* no log yet */
    }
    const line = [
      new Date().toISOString(),
      decision.toUpperCase().padEnd(5),
      entry.tool,
      `owner=${entry.owner}`,
      detail,
    ].join("  ");
    appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    // Logging must never be the reason a tool call fails.
  }
}

function allow(detail = "", note) {
  log("allow", detail);
  if (note) process.stderr.write(`${note}\n`);
  process.exit(ALLOW);
}

function block(detail, message) {
  log("block", detail);
  process.stderr.write(`${message}\n`);
  process.exit(BLOCK);
}

/**
 * Hand the call to Alex, whatever the session's permission mode says.
 *
 * Why this exists: on 2026-09-28 a claim ran with no prompt at all, even though
 * `claim` was deliberately left out of the allow list. The cause was **auto
 * mode**, whose classifier approves "local file operations within project
 * scope" before the allow list is ever consulted — so leaving a rule out no
 * longer causes a prompt. A PreToolUse hook returning permissionDecision "ask"
 * is the one lever that reaches the permission layer directly rather than by
 * omission.
 *
 * The JSON goes to stdout with exit 0; stderr and exit 2 are the block path.
 */
function ask(detail, reason) {
  log("ask", detail);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(ALLOW);
}

function readStdin() {
  try {
    // fd 0 in one go: the payload is small and everything else here is sync.
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** The path this tool call would change, or null if it is not an edit. */
function targetPath(toolName, input) {
  if (!EDIT_TOOLS.has(toolName)) return null;
  // NotebookEdit takes notebook_path; the rest take file_path.
  const p = input.notebook_path ?? input.file_path;
  return typeof p === "string" && p.trim() ? p : null;
}

function isDeploy(command) {
  const flat = String(command).replace(/\s+/g, " ").toLowerCase();
  return DEPLOY_PATTERNS.some((p) => flat.includes(p));
}

const claimHint = (items) =>
  `  node scripts/claims.mjs claim ${items.join(" ")}`;

// `claim`, `reserve` and `cleanup` are the commands Alex approves, and Claude
// Code's permission prompt is how he approves them. Everything else about
// claims.mjs is pre-approved in .claude/settings.local.json so a thread can
// check and tidy up after itself without interrupting him.
const APPROVAL_NEEDED = /claims\.mjs\s+(claim|reserve|cleanup)\b/;
const CHAINED = /(?:&&|\|\||[;|]|\n)/;

// `cd <somewhere> && ` at the very start, with the path quoted or bare.
const CD_PREFIX = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))\s*&&\s*/;

/**
 * Strip a leading `cd <this checkout> &&` if that is what it is.
 *
 * Sessions in the VS Code Claude panel put that prefix on commands as a matter of
 * course, and blocking it made claiming from a panel session impossible. It is
 * safe to allow for exactly one destination — this thread's own checkout — because
 * going somewhere it already is cannot change which claims file is written or
 * which owner does the writing, and the command after it is still checked for
 * every other kind of chaining.
 *
 * A `cd` anywhere else is not stripped, so it stays a chained command and is
 * blocked: `cd ../other-worktree && claims.mjs claim x` would claim as a
 * different owner, which is the thing worth refusing.
 */
function stripOwnCd(command, root) {
  const m = command.match(CD_PREFIX);
  if (!m) return command;
  const target = m[1] ?? m[2] ?? m[3];
  try {
    if (fold(path.resolve(root, target)) !== fold(path.resolve(root))) return command;
  } catch {
    return command;
  }
  return command.slice(m[0].length);
}

/**
 * Refuse a claim that is chained onto another command.
 *
 * Those permission rules are prefix matches, and it is not documented whether
 * Claude Code splits a compound command before matching them. If it does not,
 * `claims.mjs check x && claims.mjs claim x` would match the pre-approved
 * `check *` rule and claim without ever asking Alex — which is exactly the
 * failure this change is fixing, one layer down. Requiring the command to stand
 * alone removes the question: on its own it can only match a claim, reserve or
 * cleanup rule, and there are none.
 */
function checkApprovalBypass(command, root) {
  const m = command.match(APPROVAL_NEEDED);
  if (!m) return;

  command = stripOwnCd(command, root);

  if (!CHAINED.test(command)) {
    // Bare claim/reserve/cleanup: put it in front of Alex. See ask().
    ask(
      `ask: ${m[1]}`,
      `${m[1]} changes who owns what. Alex approves these — see .claude/CLAUDE.md.`,
    );
  }

  block(
    "chained claim",
    `Claims guard is blocking this command: it chains a claim onto other commands.\n\n` +
      `claim, reserve and cleanup must be run on their own, as a single command with\n` +
      `nothing before or after them. Alex approves them through Claude Code's permission\n` +
      `prompt, and chaining can hide one behind a rule that approved something else.\n\n` +
      `Run the claim by itself — and per .claude/CLAUDE.md, tell him which file you need\n` +
      `and why before you run it.`,
  );
}

function main() {
  if (process.env.CLAIMS_GUARD === "off") {
    allow(
      "CLAIMS_GUARD=off",
      "claims-guard: CLAIMS_GUARD=off — not enforcing claims this session.",
    );
  }

  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // We cannot tell what tool this is, so we cannot say it changes anything.
    // Allow, but loudly: a malformed payload is a harness problem, not a claims
    // one, and blocking every tool call on it would wedge the session.
    allow(
      "unparseable payload",
      "claims-guard: could not parse the hook payload — allowing this call.",
    );
  }

  const toolName = payload?.tool_name ?? "?";
  const input = payload?.tool_input ?? {};
  entry.tool = toolName;
  entry.cwd = payload?.cwd ?? process.cwd();

  const filePath = targetPath(toolName, input);
  const command = toolName === "Bash" ? String(input.command ?? "") : "";
  const needsApproval = command && APPROVAL_NEEDED.test(command);

  const deploying = toolName === "Bash" && isDeploy(command);
  const indicator = command ? writeIndicator(command) : null;

  if (!filePath && !deploying && !indicator && !needsApproval) allow("not a change");

  // Hooks run from the session's directory, which in a worktree is the worktree
  // root — exactly what decides the owner.
  let ctx;
  let state;
  try {
    ctx = resolveRepo(entry.cwd);
    entry.owner = ctx.owner;
    entry.root = ctx.root;
    state = readState(ctx.file);
  } catch (err) {
    if (err instanceof ClaimsError && err.code === "no-git") {
      allow("not a git repo"); // nothing to coordinate
    }
    block(
      "claims file unreadable",
      `Claims guard cannot read the claims file, so it is blocking this call.\n` +
        `${err.message}\n\n` +
        `Tell Alex: the claims file is broken and needs fixing by hand.`,
    );
  }

  // After resolveRepo, because working out whether a `cd` prefix points at this
  // thread's own checkout needs to know where that is.
  if (needsApproval) checkApprovalBypass(command, ctx.root);

  if (!state.existed) {
    block(
      "no claims file",
      `Claims guard is blocking this call: the claims system is not running yet.\n` +
        `No claims file at ${ctx.file}.\n\n` +
        `Stop and ask Alex. Once he confirms, claim what this step needs:\n` +
        `  node scripts/claims.mjs claim <paths...>`,
    );
  }

  // --- Supabase deploys -----------------------------------------------------
  if (deploying) {
    if (heldBy(state, "db:deploy", ctx.owner)) allow("holds db:deploy");
    const holder = state.claims.find((c) => c.item === "db:deploy");
    block(
      "deploy without db:deploy",
      `Claims guard is blocking this Supabase deploy: ${ctx.owner} does not hold db:deploy.\n` +
        (holder
          ? `${holder.owner} holds it${holder.note ? ` — ${holder.note}` : ""}.\n`
          : `Nobody holds it.\n`) +
        `\nFollow the database claim protocol: check the items, ask Alex to run gitsync,\n` +
        `do the drift check, and only claim db:deploy after he confirms. Do not deploy\n` +
        `until then.`,
    );
  }

  // --- a shell command that writes ------------------------------------------
  if (indicator) {
    const unclaimed = repoPathsIn(command, ctx.root).filter(
      (rel) => !heldBy(state, rel, ctx.owner),
    );
    if (!unclaimed.length) allow(`shell write ok (${indicator})`);
    block(
      `shell write: ${unclaimed.join(", ")}`,
      `Claims guard is blocking this command: it can change repo files ${ctx.owner}\n` +
        `has not claimed.\n\n` +
        `  writes via: ${indicator}\n` +
        `  unclaimed:  ${unclaimed.join("\n              ")}\n\n` +
        `STOP. Do not retry this in another form.\n\n` +
        `File changes must go through the Edit and Write tools, not the shell — that is\n` +
        `the project rule, and it is what makes them reviewable. If this command really\n` +
        `only reads those files, tell Alex; otherwise ask him whether to claim them, and\n` +
        `only after he confirms:\n${claimHint(unclaimed)}`,
    );
  }

  // --- an edit tool ---------------------------------------------------------
  const rel = toRepoRelative(filePath, ctx.root);
  if (rel === null) allow("outside the repo");
  if (isExempt(rel)) allow(`exempt: ${rel}`);
  if (heldBy(state, rel, ctx.owner)) allow(`claimed: ${rel}`);

  const holders = state.claims.filter(
    (c) => c.item === rel || (c.item.endsWith("/") && rel.startsWith(c.item)),
  );
  const reserved = state.reservations.filter((r) => r.item === rel);

  block(
    `unclaimed: ${rel}`,
    `Claims guard is blocking this edit: ${ctx.owner} has not claimed ${rel}.\n` +
      (holders.length
        ? `${holders
            .map((c) => `${c.owner} holds ${c.item}${c.note ? ` — ${c.note}` : ""}`)
            .join("\n")}\n`
        : `Nobody holds it — it is simply unclaimed.\n`) +
      (reserved.length
        ? `Reserved by ${reserved.map((r) => `${r.owner} for ${r.step}`).join(", ")}.\n`
        : "") +
      `\nSTOP. Do not edit this file and do not work around this — a shell command\n` +
      `that writes it is blocked too.\n` +
      (holders.length
        ? `Another thread owns it. Report this to Alex and wait.\n`
        : `Tell Alex this file was not in the plan and ask whether to claim it.\n` +
          `Only after he confirms:\n${claimHint([rel])}`),
  );
}

main();
