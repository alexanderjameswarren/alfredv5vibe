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
//   No tag, short reply ("yes", "no drift")        pass
//   No tag, looks like a pasted prompt             BLOCK, ask to confirm
//   Starts with "override:"                        pass, said out loud and logged
//
// Every decision goes to .clip/claims-guard.log alongside the tool guard's, so
// the two read as one story.

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ClaimsError, resolveRepo } from "../../scripts/lib/claims-core.mjs";
import {
  codeOfCheckout,
  projectOfTag,
  tagInPrompt,
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
    const file = path.join(root, LOG_RELATIVE);
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

/**
 * Does this read like a prompt written for a CLI session, rather than an answer
 * to one?
 *
 * Short replies are the common case and must never be interrupted — "yes",
 * "confirmed, no drift", "go". A pasted task prompt is long, or has the shape of
 * one. Three independent signals, because any single one is easy to miss.
 */
function looksPasted(prompt) {
  if (/^#+\s*Your Task/mi.test(prompt)) return "has a '# Your Task' heading";
  if (prompt.length > 400) return `${prompt.length} characters`;
  const lines = prompt.split(/\r?\n/).filter((l) => l.trim()).length;
  if (lines >= 4) return `${lines} lines`;
  return null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    allow("unparseable payload");
  }

  // Only interactive prompts. Loop and schedule wake-ups, SDK and system
  // messages are machinery, and blocking those would wedge the session.
  const source = payload?.source ?? "user";
  if (source !== "user") allow(`source=${source}`);

  const prompt = String(payload?.prompt ?? "");
  if (!prompt.trim()) allow("empty prompt");

  if (/^\s*override:/i.test(prompt)) {
    allow(
      "override:",
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

  const tag = tagInPrompt(prompt);

  if (tag) {
    const wanted = projectOfTag(tag);
    if (!wanted) {
      allow(`tag=${tag} (no step segment, cannot tell)`);
    }
    if (!code) {
      // First tagged prompt in the main checkout claims it for that project.
      if (settable) {
        writeMainCode(ctx, wanted);
        allow(
          `tag=${tag} set main project=${wanted}`,
          `prompt-check: the main checkout is now working on "${wanted}".\n` +
            `gitpush Finish on main clears that when the project is done.`,
        );
      }
      allow(`tag=${tag} no project code for this checkout`);
    }
    if (wanted !== code) {
      block(
        `tag=${tag} wants=${wanted} here=${code}`,
        `\n🛑  WRONG WINDOW — this prompt was not sent to the right place.\n\n` +
          `  This window is  ${where}, working on "${code}".\n` +
          `  The run tag      ${tag}\n` +
          `  belongs to       "${wanted}".\n\n` +
          `Nothing has been sent to Claude. Paste it into the "${wanted}" window instead.\n\n` +
          `If it really does belong here, resend it with "override:" on the front.`,
      );
    }
    allow(`tag=${tag} matches ${code}`);
  }

  // No run tag from here on.
  const why = looksPasted(prompt);
  if (!why) allow("short untagged reply");

  block(
    `untagged, looks pasted (${why})`,
    `\n⚠  UNTAGGED PROMPT — is this the right window?\n\n` +
      `  This window is  ${where}${code ? `, working on "${code}"` : ", with no project set"}.\n` +
      `  This prompt has no "Run tag:" line, and looks like a task prompt (${why}).\n\n` +
      `Nothing has been sent to Claude. Either:\n` +
      `  • add the "Run tag: ..." line and resend, so the window can be checked, or\n` +
      `  • resend it with "override:" on the front if you meant it to go here.\n\n` +
      `Short replies — "yes", "confirmed, no drift" — are never stopped.`,
  );
}

main();
