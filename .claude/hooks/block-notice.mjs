#!/usr/bin/env node
// UserPromptSubmit hook: tell a thread, at the start of each turn, that another
// project is waiting on a file it holds. Silent when nobody is.
//
// Separate from prompt-check so it can never change that hook's block or allow
// decision. Reads the claims and blocks files only — no git, not even rev-parse:
// the checkout's layout comes from its `.git` file or folder. Any failure says
// nothing and exits 0.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  BLOCKS_FILE,
  CLAIMS_FILE,
  codeOfOwner,
  holderNotice,
  readBlocks,
  readState,
} from "../../scripts/lib/claims-core.mjs";

/** resolveRepo's answer from the filesystem alone, or null. */
function checkoutFromFs(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st = null;
    try {
      st = statSync(dotGit);
    } catch {
      /* keep walking up */
    }
    if (st?.isDirectory()) return ctxFor(dir, dotGit, false);
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return null;
      const gitDir = path.resolve(dir, m[1].trim());
      const common = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      return ctxFor(dir, common, true);
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function ctxFor(root, common, isWorktree) {
  return {
    root,
    dir: common,
    file: path.join(common, CLAIMS_FILE),
    blocksFile: process.env.CLAIMS_BLOCKS_FILE
      ? path.resolve(process.env.CLAIMS_BLOCKS_FILE)
      : path.join(common, BLOCKS_FILE),
    owner: isWorktree ? path.basename(root) : "main",
    isWorktree,
  };
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    /* no payload: fall back to the project dir */
  }
  const ctx = checkoutFromFs(process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  if (!ctx) return;
  const text = holderNotice({
    blocks: readBlocks(ctx.blocksFile),
    state: readState(ctx.file),
    owner: ctx.owner,
    codeOf: (o) => codeOfOwner(ctx, o),
  });
  if (!text) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }),
  );
}

try {
  main();
} catch {
  /* never the reason a prompt fails */
}
process.exit(0);
