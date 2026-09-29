// Which project does this checkout belong to, and which project is a run tag for?
//
// Used by the UserPromptSubmit hook (.claude/hooks/prompt-check.mjs) to stop a
// prompt landing in the wrong window, and by gitpush Finish to clear main's code
// when a project is done.
//
// ---------------------------------------------------------------------------
// WHERE A PROJECT CODE COMES FROM
// ---------------------------------------------------------------------------
//
// A worktree's code is its folder name. `gitnewtree claims-wq7` makes
// .claude/worktrees/claims-wq7, so the answer is already on disk and nothing has
// to be remembered.
//
// The main checkout has no folder name to go on, so its code is recorded the
// first time a tagged prompt arrives, and cleared by gitpush Finish on main. It
// lives next to the claims file, in the shared git dir, for the same reason:
// every checkout sees the same one and git never tracks it.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROJECT_FILE = "alfred-project-code.json";

/**
 * The project part of a run tag: everything before the step segment.
 *
 *   claims-wq7-s7d-u3rb  ->  claims-wq7
 *   alfred-ab1-s1-x9k2   ->  alfred-ab1
 *
 * The step segment is the last one shaped like s<digit>… (s1, s7c, s3fix2).
 * Returns null when there is no such segment — an older or hand-written tag —
 * and callers treat that as "cannot tell", not as a mismatch.
 */
export function projectOfTag(tag) {
  const parts = String(tag).trim().split("-");
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (/^s\d/i.test(parts[i])) return parts.slice(0, i).join("-");
  }
  return null;
}

/** The `Run tag: <tag>` line of a prompt, or null. */
export function tagInPrompt(prompt) {
  const m = String(prompt).match(/^[ \t]*Run tag:[ \t]*([A-Za-z0-9-]{1,60})[ \t]*$/m);
  return m ? m[1] : null;
}

function projectFile(ctx) {
  return path.join(ctx.dir, PROJECT_FILE);
}

/** The code recorded for the main checkout, or null. */
export function readMainCode(ctx) {
  try {
    const raw = JSON.parse(readFileSync(projectFile(ctx), "utf8"));
    return typeof raw.code === "string" && raw.code ? raw.code : null;
  } catch {
    return null;
  }
}

export function writeMainCode(ctx, code) {
  const file = projectFile(ctx);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ code, set_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, file);
}

export function clearMainCode(ctx) {
  try {
    unlinkSync(projectFile(ctx));
    return true;
  } catch {
    return false;
  }
}

/**
 * The project this checkout belongs to.
 *
 * `settable` is true only for the main checkout, where the code is not known
 * from the folder name and the first tagged prompt gets to set it.
 */
export function codeOfCheckout(ctx) {
  if (ctx.isWorktree) {
    return { code: path.basename(ctx.root), source: "worktree folder", settable: false };
  }
  return { code: readMainCode(ctx), source: "recorded for main", settable: true };
}
