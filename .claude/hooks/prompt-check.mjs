#!/usr/bin/env node
// UserPromptSubmit guard: stop a prompt landing in the wrong window.
//
// With several VS Code windows open — main plus a worktree per project — a
// prompt pasted into the wrong one is easy to do and expensive to undo. The
// thread starts work on the wrong branch, claims files for the wrong owner, and
// nothing downstream notices, because every one of those actions is legitimate
// for the window it ran in.
//
// Claude Code runs this before the prompt reaches Claude. Exit 0 lets it
// through; exit 2 blocks it and shows this script's stderr to Alex.
//
// ---------------------------------------------------------------------------
// WHAT IT CHECKS
// ---------------------------------------------------------------------------
//
//   Run tag present, project matches this window   pass
//   Run tag present, project does not match        BLOCK, naming both projects
//   Run tag present, this window has no project    pass, and record it (main only)
//   Run tag present but malformed                  BLOCK, showing the format
//   No tag, short reply ("yes", "no drift")        pass
//   No tag, looks like a pasted prompt             BLOCK, ask to confirm
//   Starts with "override:"                        pass, said out loud and logged
//   A machine envelope (a subagent's report)        pass, it is not Alex typing
//
// Pasted text arrives wrapped by the VS Code panel — <pasted_content id="c70a">
// … </pasted_content id="c70a"> — so the wrappers come off before anything is
// looked for, in scripts/lib/project-code.mjs. Without that the "Run tag:" line
// of a pasted prompt is not at the start of its line, which makes every pasted
// prompt read as untagged, and a typed "override:" is never at the front.
//
// Every decision goes to .clip/claims-guard.log alongside the tool guard's, so
// the two read as one story.

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ClaimsError, resolveRepo } from "../../scripts/lib/claims-core.mjs";
import {
  classifyPrompt,
  codeOfCheckout,
  projectOfTag,
  TAG_EXAMPLE,
  TAG_FORMAT,
  writeMainCode,
} from "../../scripts/lib/project-code.mjs";

const LOG_RELATIVE = ".clip/claims-guard.log";
const LOG_MAX_BYTES = 256 * 1024;

const ALLOW = 0;
const BLOCK = 2;

const entry = { root: null };

function log(decision, detail) {
  try {
    const root = entry.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    // The tests drive this hook for real, and must not write the real log.
    const file = process.env.CLAIMS_GUARD_LOG
      ? path.resolve(process.env.CLAIMS_GUARD_LOG)
      : path.join(root, LOG_RELATIVE);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES) return;
    } catch {
      /* no log yet */
    }
    appendFileSync(
      file,
      `${[
        new Date().toISOString(),
        decision.toUpperCase().padEnd(5),
        "Prompt",
        `project=${entry.code ?? "unset"}`,
        detail,
      ].join("  ")}\n`,
      "utf8",
    );
  } catch {
    // Logging must never be the reason a prompt fails.
  }
}

function allow(detail, note) {
  log("allow", detail);
  if (note) process.stderr.write(`${note}\n`);
  process.exit(ALLOW);
}

function block(detail, message) {
  log("block", detail);
  process.stderr.write(`${message}\n`);
  process.exit(BLOCK);
}

function main() {
  let payload;
  try {
    // The BOM strip is for hand-testing: PowerShell puts one in front of
    // anything piped to a native command, and JSON.parse refuses it.
    payload = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    allow("unparseable payload");
  }

  // Only interactive prompts. Loop and schedule wake-ups, SDK and system
  // messages are machinery, and blocking those would wedge the session.
  const source = payload?.source ?? "user";
  if (source !== "user") allow(`source=${source}`);

  // The panel's paste wrappers come off first: the run tag and a typed
  // "override:" both sit inside or after them.
  const prompt = classifyPrompt(payload?.prompt ?? "");
  const wrapped = prompt.wrapped ? " unwrapped" : "";
  if (!prompt.text.trim()) allow(`empty prompt${wrapped}`);

  // Machinery too, but it arrives looking exactly like typing: `source` is
  // absent, and the session_id is this session's, because a subagent's report
  // is delivered into its parent's conversation. Until 2026-09-30 every one of
  // these was blocked as an untagged pasted prompt — a subagent ran, was
  // guarded correctly, and its report was then silently eaten, with the parent
  // told it had been delivered. A run tag cannot help here: nothing Alex types
  // reaches the envelope.
  if (prompt.machine) allow(`machine envelope <${prompt.machine}>`);

  if (prompt.override) {
    allow(
      `override:${wrapped}`,
      "prompt-check: 'override:' — project check skipped for this prompt.",
    );
  }

  let ctx;
  try {
    ctx = resolveRepo(payload?.cwd ?? process.cwd());
  } catch (err) {
    if (err instanceof ClaimsError) allow("not a git repo");
    throw err;
  }
  entry.root = ctx.root;

  const { code, settable } = codeOfCheckout(ctx);
  entry.code = code;
  const where = ctx.isWorktree ? `worktree ${path.basename(ctx.root)}` : "the main checkout";

  const tag = prompt.tag;

  if (tag) {
    const wanted = projectOfTag(tag);
    if (!wanted) {
      // A tag that cannot be read is a tag that cannot be checked. This used to
      // pass, and on 2026-09-29 a prompt tagged `rem-k4q-plan-t6v2` reached a
      // window unchecked because of it — "plan" is not a step segment.
      block(
        `tag=${tag}${wrapped} unparseable`,
        `\n🛑  MALFORMED RUN TAG — this prompt cannot be checked.\n\n` +
          `  The tag     ${tag}\n` +
          `  Expected    ${TAG_FORMAT}\n` +
          `  For example ${TAG_EXAMPLE}\n\n` +
          `  The step segment is "s" then a number — s1, s2, s10 — with a letter\n` +
          `  added for a follow-up within a step (s3b). Words like "plan" or "fix"\n` +
          `  do not parse, and nor does a missing or wrong-length random suffix.\n\n` +
          `This window is ${where}${code ? `, working on "${code}"` : ", with no project set"}.\n` +
          `Nothing has been sent to Claude. Fix the tag and resend, or resend with\n` +
          `"override:" on the front if you meant it to go here as it is.`,
      );
    }
    if (!code) {
      // First tagged prompt in the main checkout claims it for that project.
      if (settable) {
        writeMainCode(ctx, wanted);
        allow(
          `tag=${tag}${wrapped} set main project=${wanted}`,
          `prompt-check: the main checkout is now working on "${wanted}".\n` +
            `gitpush Finish on main clears that when the project is done.`,
        );
      }
      allow(`tag=${tag}${wrapped} no project code for this checkout`);
    }
    if (wanted !== code) {
      block(
        `tag=${tag}${wrapped} wants=${wanted} here=${code}`,
        `\n🛑  WRONG WINDOW — this prompt was not sent to the right place.\n\n` +
          `  This window is  ${where}, working on "${code}".\n` +
          `  The run tag      ${tag}\n` +
          `  belongs to       "${wanted}".\n\n` +
          `Nothing has been sent to Claude. Paste it into the "${wanted}" window instead.\n\n` +
          `If it really does belong here, resend it with "override:" on the front.\n` +
          (settable
            ? `If "${code}" is finished and this window is moving on to "${wanted}":\n` +
              `  node scripts/claims.mjs bind ${wanted}     (or  unbind  to clear it)\n` +
              `Neither touches a claim.`
            : `This is a worktree, so its code is the folder name and cannot be changed.`),
      );
    }
    allow(`tag=${tag}${wrapped} matches ${code}`);
  }

  // No run tag from here on.
  const why = prompt.pasted;
  if (!why) allow(`short untagged reply${wrapped}`);

  block(
    `untagged${wrapped}, looks pasted (${why})`,
    `\n⚠  UNTAGGED PROMPT — is this the right window?\n\n` +
      `  This window is  ${where}${code ? `, working on "${code}"` : ", with no project set"}.\n` +
      `  This prompt has no "Run tag:" line, and looks like a task prompt (${why}).\n\n` +
      `Nothing has been sent to Claude. Either:\n` +
      `  • add the "Run tag: ..." line and resend, so the window can be checked, or\n` +
      `  • resend it with "override:" on the front if you meant it to go here.\n\n` +
      (settable && code
        ? `To move this window to another project:  claims.mjs bind <code>\n` +
          `To leave it unbound:                    claims.mjs unbind\n\n`
        : "") +
      `Short replies — "yes", "confirmed, no drift" — are never stopped.`,
  );
}

main();
