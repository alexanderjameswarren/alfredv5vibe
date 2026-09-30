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

// The one true run tag shape. Anchored end to end, deliberately:
//
//   <project-code>-s<step>-<4 random lowercase letters or digits>
//   rem-k4q-s1-t6v2
//
// The first version scanned backwards for a segment starting `s<digit>` and took
// everything before it. That got `rem-k4q-s1-s2ab` wrong — the random suffix
// looked like a step, so the project came out as `rem-k4q-s1` and a correct
// prompt would have been blocked as the wrong window. Roughly one tag in 360.
// Anchoring the four-character suffix to the end removes the ambiguity: only one
// segment can be the step.
export const TAG_SHAPE = /^([a-z0-9][a-z0-9-]*)-(s\d[a-z0-9]*)-([a-z0-9]{4})$/;

export const TAG_FORMAT =
  "<project-code>-s<step number>-<4 random lowercase letters or digits>";
export const TAG_EXAMPLE = "rem-k4q-s1-t6v2";

/** `{ project, step, suffix }` for a well-formed tag, or null. */
export function parseTag(tag) {
  const m = String(tag).trim().match(TAG_SHAPE);
  return m ? { project: m[1], step: m[2], suffix: m[3] } : null;
}

/**
 * The project part of a run tag.
 *
 *   claims-wq7-s7d-u3rb  ->  claims-wq7
 *   alfred-ab1-s1-x9k2   ->  alfred-ab1
 *
 * Null for anything that is not the shape above — `rem-k4q-plan-t6v2`, or an
 * older `clip-7b-q4m2`. The prompt guard **blocks** those rather than letting
 * them through: a tag it cannot read is a tag it cannot check, and allowing it
 * is how a prompt reached the wrong window unchecked on 2026-09-29.
 */
export function projectOfTag(tag) {
  return parseTag(tag)?.project ?? null;
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

// The harness delivers machine traffic to a session through the same
// UserPromptSubmit event Alex's typing uses, wrapped in an envelope tag:
//
//   <agent-message from="ad3b77bf…">
//   [Subagent hand-back] …
//
// There is no payload field that says so — `source` is absent and defaults to
// "user", and session_id is the PARENT's, because the hand-back is delivered
// into the parent's conversation. Verified 2026-09-30 by dumping the payload of
// three throwaway subagents; `agent-message` is the one seen. The other two are
// named from the SendMessage and background-task documentation and are not
// verified, but a hand-back proved the shape, and blocking those would break the
// same way.
const MACHINE_ENVELOPES = /^<(agent-message|cross-session-message|task-notification)\b[^>]*>/;

/**
 * The envelope tag if this prompt is machine traffic, else null.
 *
 * Matched on the RAW prompt, anchored at the very start, and deliberately not
 * on the paste-unwrapped text: a real envelope is never pasted, so anything
 * arriving inside a `<pasted_content>` wrapper is someone typing the shape of
 * one. The hand-back's own framing makes the same promise from the other side —
 * it indents every line of the report, so a frame at column zero within it
 * would be forged.
 */
export function machineEnvelope(prompt) {
  const match = MACHINE_ENVELOPES.exec(String(prompt));
  return match ? match[1] : null;
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
    machine: machineEnvelope(raw),
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
