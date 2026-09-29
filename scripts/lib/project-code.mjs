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

// ---------------------------------------------------------------------------
// PASTED-TEXT WRAPPERS
// ---------------------------------------------------------------------------
//
// The Claude panel in VS Code wraps anything pasted into it:
//
//   <pasted_content id="c70a">Run tag: claims-wq7-s7f-p8wz
//   …
//   </pasted_content id="c70a">
//
// Note the attributes on the CLOSING tag — that is what the panel really emits,
// so this does not look for a bare `</pasted_content>`. Two things follow, and
// both were live bugs on 2026-09-29:
//
//   The `Run tag:` line is no longer at the start of its line, so the tag was
//   not found and every pasted prompt — all of them are long enough to be
//   wrapped — would have been blocked as untagged.
//
//   A typed "override:" sits before the wrapper, and one typed inside the
//   pasted block sits after an opening tag, so neither was at the start of the
//   prompt and the override did nothing.
//
// A prompt can hold several blocks with typed text before, between and after
// them, so every tag is removed wherever it is.

const PASTE_WRAPPER = /<\/?pasted[_-](?:content|text)\b[^>]*>/gi;

/** The prompt with the panel's paste wrappers removed, content untouched. */
export function stripPasteWrappers(prompt) {
  return String(prompt).replace(PASTE_WRAPPER, "");
}

/**
 * Does this read like a prompt written for a CLI session, rather than an answer
 * to one?
 *
 * Short replies are the common case and must never be interrupted — "yes",
 * "confirmed, no drift", "go". A pasted task prompt is long, or has the shape of
 * one. Three independent signals, because any single one is easy to miss.
 *
 * Measured on the unwrapped text: the wrapper tags are the panel's, not Alex's,
 * and counting them would push a two-word reply towards the length threshold.
 */
export function looksPasted(prompt) {
  if (/^#+\s*Your Task/mi.test(prompt)) return "has a '# Your Task' heading";
  const trimmed = prompt.trim();
  if (trimmed.length > 400) return `${trimmed.length} characters`;
  const lines = prompt.split(/\r?\n/).filter((l) => l.trim()).length;
  if (lines >= 4) return `${lines} lines`;
  return null;
}

/**
 * Everything the prompt guard needs to decide, from the prompt text alone.
 *
 * `override` also accepts a leading run of tags of any shape, so a wrapper this
 * does not know about yet still cannot swallow an override.
 */
export function classifyPrompt(prompt) {
  const raw = String(prompt);
  const text = stripPasteWrappers(raw);
  const override =
    /^\s*override:/i.test(text) || /^\s*(?:<[^>]*>\s*)+override:/i.test(raw);
  return {
    text,
    wrapped: text !== raw,
    override,
    tag: tagInPrompt(text),
    pasted: looksPasted(text),
  };
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
